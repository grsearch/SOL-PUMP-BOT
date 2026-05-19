'use strict';
//
// 策略大脑。
//   - 收到 webhook  → buy
//   - 1秒价格 tick  → 喂 K 线 + RUG 价格暴跌通道
//   - K线收盘 → 检查 EMA cross (warmup 后) + trailing
//   - rugDetector 'rug' 事件 → 紧急卖出
//   - buy/sell 拿到 sig 后 → confirmTracker.track() 异步确认 + 回填实际 PnL/slot
//   - FDV / LP 跌破阈值 → 移除监控
//
// 每个 token 只买卖一次,卖完即清理。
//

const cfg = require('../config');
const log = require('../utils/logger').child('strategy');
const { TokenStore, STATE } = require('../monitor/tokenStore');
const { BirdeyePoller, fetchTokenOverview } = require('../data/birdeyePoller');
const tradeDb = require('../pnl/tradeDb');

class Strategy {
  /**
   * @param {object} deps
   * @param {Trader} deps.trader
   * @param {RugDetector} deps.rugDetector
   * @param {WsHub} deps.wsHub
   * @param {ConfirmTracker} [deps.confirmTracker]
   * @param {Array<{watch(mint):void, unwatch(mint):void, watchPool?(mint,pool):void}>} [deps.dataSources]
   */
  constructor({ trader, rugDetector, wsHub, confirmTracker, dataSources = [] }) {
    this.trader = trader;
    this.rug = rugDetector;
    this.wsHub = wsHub;
    this.confirmTracker = confirmTracker;
    this.dataSources = dataSources;
    this.poller = new BirdeyePoller();
    this.store = new TokenStore();
    this._overviewTimer = setInterval(() => this._refreshOverviews().catch(()=>{}), 30_000);

    this.rug.on('rug', (mint, evidence) => this._onRugSignal(mint, evidence));
  }

  _notifyWatch(mint) { for (const d of this.dataSources) try { d.watch(mint); } catch(e){} }
  _notifyUnwatch(mint) { for (const d of this.dataSources) try { d.unwatch(mint); } catch(e){} }
  _notifyWatchPool(mint, pool) {
    for (const d of this.dataSources) {
      try { if (typeof d.watchPool === 'function') d.watchPool(mint, pool); } catch(e){}
    }
  }

  hasPendingTrades() {
    return this.store.list().some(t => t.state === STATE.BUYING || t.state === STATE.SELLING);
  }

  stop() { clearInterval(this._overviewTimer); }

  /**
   * v4: 启动时从 db 恢复未结束的持仓 (HOLDING/SELLING).
   * 调用顺序: new Strategy(...) → await strategy.recoverPositions()
   *
   * 流程:
   *   1. 从 db 拿所有 state IN ('HOLDING', 'SELLING') 的 row
   *   2. 对每个 mint 调 trader.getTokenBalance 校验链上是否真有
   *   3. 链上有余额 → 恢复内存 store + 接 EMA/trailing/RUG 监控 + 持续阈值检查
   *   4. 链上无余额 → 说明重启期间被某种方式卖了 (手动 / 其他实例) → 标 CLOSED 删行
   */
  async recoverPositions() {
    let rows;
    try { rows = require('../pnl/tradeDb').loadActivePositions(); }
    catch (e) { log.error(`load positions err: ${e.message}`); return; }
    if (!rows || rows.length === 0) {
      log.info('启动恢复: 没有未结束的持仓');
      return;
    }
    log.info(`启动恢复: 发现 ${rows.length} 个未结束持仓, 校验链上余额...`);
    const tradeDb = require('../pnl/tradeDb');

    for (const row of rows) {
      const mint = row.mint;
      try {
        // 先 resolve pool 把 pool info 缓存起来 + reserves cache 启动
        await this.trader.resolvePool(mint).catch(e => {
          log.warn(`恢复 ${mint.slice(0,8)} resolvePool 失败: ${e.message}`);
        });

        const chainBalance = await this.trader.getTokenBalance(mint);
        const dbBalance = row.token_balance ? BigInt(row.token_balance) : 0n;

        if (chainBalance === 0n) {
          log.warn(`恢复 ${mint.slice(0,8)} ${row.symbol}: 链上余额 0, 标记 CLOSED 并删除`);
          tradeDb.deletePosition(mint);
          continue;
        }

        if (dbBalance > 0n && chainBalance !== dbBalance) {
          log.warn(`恢复 ${mint.slice(0,8)} ${row.symbol}: db 余额 ${dbBalance} ≠ 链上 ${chainBalance}, 用链上值`);
        }

        // 恢复内存 store
        const tok = this.store.add(mint, {
          symbol: row.symbol,
          onBarClose: (bar, snap) => this._onBarClose(mint, bar, snap),
        });
        tok.state = STATE.HOLDING;  // 重启后 SELLING 状态没意义, 重置为 HOLDING 让策略重新决定
        tok.addedAt = row.added_at || Date.now();
        tok.buyAt = row.buy_at;
        tok.buyTxSig = row.buy_tx_sig;
        tok.buyAmountLamports = row.buy_amount_lamports || cfg.trade.buyAmountLamports;
        tok.buyPriceUsd = row.buy_price_usd;
        tok.peakPriceUsd = row.peak_price_usd || row.buy_price_usd;
        tok.tokenBalance = chainBalance;  // 用链上的, 最权威
        tok.poolAddress = row.pool_address;
        tok.poolBaseVault = row.pool_base_vault;
        tok.poolQuoteVault = row.pool_quote_vault;
        tok.baseDecimals = row.base_decimals;
        tok.trailingActivated = !!row.trailing_activated;
        tok.barsSinceBuy = row.bars_since_buy || 0;

        // 通知数据源订阅
        const pi = this.trader.poolCache.get(mint);
        if (pi) {
          this._notifyWatchPool(mint, {
            pool: pi.pool,
            poolAddress: pi.pool.toBase58(),
            poolBaseVault: pi.poolBaseVault,
            poolQuoteVault: pi.poolQuoteVault,
            baseDecimals: pi.baseDecimals,
            symbol: row.symbol,
          });
        }
        this.poller.subscribe(mint, (tick) => this._onPriceTick(mint, tick));
        this.rug.watch(mint);
        this._notifyWatch(mint);

        // 把状态写回 db (state 可能从 SELLING 改成 HOLDING)
        this._persist(tok);

        log.info(`✅ 恢复 ${mint.slice(0,8)} ${row.symbol}: 链上余额=${chainBalance}, peak_price=$${tok.peakPriceUsd}, trailing=${tok.trailingActivated}`);
      } catch (e) {
        log.error(`恢复 ${mint.slice(0,8)} 失败: ${e.message}`);
      }
    }
    log.info(`启动恢复完成, store 中有 ${this.store.list().length} 个监控`);
  }

  /**
   * 新代币进入: webhook 触发, 检查 FDV 上限后买入
   */
  async onWebhookAdd(mint, symbol, payload = {}) {
    if (this.store.get(mint)) {
      log.info(`${mint.slice(0,8)} 已在监控,跳过`);
      return;
    }

    log.info(`webhook add ${mint.slice(0,8)} ${symbol}, 解 pool...`);

    const tok = this.store.add(mint, {
      symbol,
      onBarClose: (bar, snap) => this._onBarClose(mint, bar, snap),
    });

    // 先解 pool — 这给我们链上 FDV/LP 计算能力 + helius/shred 解析能力
    // (顺序换了: 旧版先查 birdeye 拿 FDV, 但 birdeye 索引延迟导致拿不到, 改成先链上)
    let pi;
    try {
      pi = await this.trader.resolvePool(mint);
      tok.poolAddress = pi.pool.toBase58();
      tok.baseDecimals = pi.baseDecimals;
      tok.poolBaseVault = pi.poolBaseVault.toBase58();
      tok.poolQuoteVault = pi.poolQuoteVault.toBase58();
    } catch (e) {
      log.error(`resolvePool 失败 ${mint.slice(0,8)}: ${e.message}, 跳过买入`);
      this._cleanup(mint);
      return;
    }

    // 链上 FDV / LP 检查 (v4: bypass birdeye 索引延迟)
    // pumpmonitor 那边可能在 webhook payload 里带了 fdv/lp, 优先用 payload, 没传就用链上算
    let fdvForCheck = payload.fdv;
    let lpForCheck = payload.lp;
    const chainFdvLp = this.trader.getOnChainFdvLp?.(mint);
    if (chainFdvLp) {
      // 链上数据可信度最高, 用它覆盖 payload
      fdvForCheck = chainFdvLp.fdv;
      lpForCheck = chainFdvLp.lp;
      tok.fdv = chainFdvLp.fdv;
      tok.lp = chainFdvLp.lp;
      tok.currentPriceUsd = chainFdvLp.priceUsd;
      log.info(`链上数据 ${mint.slice(0,8)}: fdv=$${chainFdvLp.fdv.toFixed(0)} lp=$${chainFdvLp.lp.toFixed(0)} price=$${chainFdvLp.priceUsd.toExponential(2)}`);
    } else {
      log.warn(`链上 FDV/LP 不可用 (SOL 价格未就绪?), 用 payload 数据`);
    }

    // FDV 上限检查
    if (fdvForCheck != null && fdvForCheck > 0 && fdvForCheck > cfg.monitor.maxFdv) {
      log.info(`❌ ${mint.slice(0,8)} ${symbol} FDV=$${fdvForCheck.toFixed(0)} > 上限 $${cfg.monitor.maxFdv}, 跳过买入`);
      this._cleanup(mint);
      return;
    }
    // FDV 下限检查 (低于 20K 通常是迁移失败或没人买)
    if (fdvForCheck != null && fdvForCheck > 0 && fdvForCheck < cfg.monitor.minFdv) {
      log.info(`❌ ${mint.slice(0,8)} ${symbol} FDV=$${fdvForCheck.toFixed(0)} < 下限 $${cfg.monitor.minFdv}, 跳过买入`);
      this._cleanup(mint);
      return;
    }
    // LP 下限检查
    if (lpForCheck != null && lpForCheck > 0 && lpForCheck < cfg.monitor.minLp) {
      log.info(`❌ ${mint.slice(0,8)} ${symbol} LP=$${lpForCheck.toFixed(0)} < 下限 $${cfg.monitor.minLp}, 跳过买入`);
      this._cleanup(mint);
      return;
    }

    log.info(`✅ ${mint.slice(0,8)} ${symbol} 阈值检查通过, 开始监控 + 买入`);

    // 通知数据源订阅
    const watchInfo = {
      pool: pi.pool,
      poolAddress: pi.pool.toBase58(),
      poolBaseVault: pi.poolBaseVault,
      poolQuoteVault: pi.poolQuoteVault,
      baseDecimals: pi.baseDecimals,
      symbol,
    };
    this._notifyWatchPool(mint, watchInfo);
    log.info(`pool ${pi.pool.toBase58().slice(0,8)} 已加入 helius/shredstream 订阅`);

    this.poller.subscribe(mint, (tick) => this._onPriceTick(mint, tick));
    this.rug.watch(mint);
    this._notifyWatch(mint);
    // birdeye overview 异步拉一次 (holders/volume 等 dashboard 元数据)
    this._refreshOneOverview(mint).catch(()=>{});

    // 立即买入
    this.store.setState(mint, STATE.BUYING);
    this._broadcast('state', { mint, state: STATE.BUYING });

    try {
      const res = await this.trader.buy(mint);
      if (res.signature) {
        tok.buyAt = Date.now();
        tok.buyTxSig = res.signature;
        tok.buyAmountLamports = cfg.trade.buyAmountLamports;
        tok.state = STATE.HOLDING;
        tok.tokenBalance = BigInt(res.expectedOut || 0);
        const rowId = tradeDb.record({
          mint, symbol, side: 'BUY', reason: 'MIGRATE',
          solAmount: -(cfg.trade.buyAmountLamports / 1e9),
          tokenAmount: tok.tokenBalance,
          priceUsd: tok.currentPriceUsd || null,
          txSig: res.signature,
          latencyMs: res.latencyMs,
          channel: res.channel,
        });
        this._broadcast('state', { mint, state: STATE.HOLDING });
        log.info(`HOLDING ${mint.slice(0,8)} sig=${res.signature.slice(0,12)}`);

        // v4: 持久化持仓 (重启时可恢复)
        this._persist(tok);

        // 异步追踪 confirm
        this.confirmTracker?.track(res.signature, { mint, side: 'BUY', reason: 'MIGRATE' });
      } else {
        log.error(`buy 失败 ${mint.slice(0,8)}: ${res.error}`);
        this._cleanup(mint);
      }
    } catch (e) {
      log.error(`buy 异常 ${mint.slice(0,8)}: ${e.message}`);
      this._cleanup(mint);
    }
  }

  /** v4: 把 tok 状态写入 db (供重启恢复) */
  _persist(tok) {
    if (tok.state === STATE.CLOSED) return;
    try {
      tradeDb.savePosition({
        mint: tok.mint,
        symbol: tok.symbol,
        state: tok.state,
        addedAt: tok.addedAt,
        buyAt: tok.buyAt,
        buyTxSig: tok.buyTxSig,
        buyAmountLamports: tok.buyAmountLamports,
        buyPriceUsd: tok.buyPriceUsd,
        peakPriceUsd: tok.peakPriceUsd,
        tokenBalance: tok.tokenBalance,
        poolAddress: tok.poolAddress,
        poolBaseVault: tok.poolBaseVault,
        poolQuoteVault: tok.poolQuoteVault,
        baseDecimals: tok.baseDecimals,
        trailingActivated: tok.trailingActivated,
        barsSinceBuy: tok.barsSinceBuy,
      });
    } catch (e) {
      log.error(`持久化失败 ${tok.mint?.slice(0,8)}: ${e.message}`);
    }
  }

  _onPriceTick(mint, tick) {
    const t = this.store.get(mint);
    if (!t || t.state === STATE.CLOSED) return;
    t.currentPriceUsd = tick.price;
    t.lastPriceTickAt = tick.ts;

    if (t.state === STATE.HOLDING && !t.buyPriceUsd && tick.price > 0) {
      t.buyPriceUsd = tick.price;
      t.peakPriceUsd = tick.price;
      log.info(`📌 ${mint.slice(0,8)} buyPriceUsd = ${tick.price}`);
    }

    if (t.state === STATE.HOLDING) {
      if (tick.price > t.peakPriceUsd) t.peakPriceUsd = tick.price;
      this._checkTrailing(mint);
      // 喂给 RUG price crash 通道 (兜底防线)
      this.rug.ingestPriceDrop(mint, tick.price, tick.ts);
    }
    t.kline.push({ price: tick.price, ts: tick.ts });
  }

  _onBarClose(mint, bar, snap) {
    const t = this.store.get(mint);
    if (!t || t.state !== STATE.HOLDING) return;
    t.barsSinceBuy++;
    this._broadcast('bar', { mint, bar, ema9: snap.emaFastNow, ema20: snap.emaSlowNow });

    // v4: 每根 K 线收盘时持久化 (barsSinceBuy / peakPriceUsd / trailingActivated 都可能更新)
    this._persist(t);

    if (t.barsSinceBuy < cfg.kline.warmupBars) return;
    if (t.kline.isBearCross()) {
      log.info(`📉 EMA cross ${mint.slice(0,8)} ema9=${snap.emaFastNow?.toFixed(8)} ema20=${snap.emaSlowNow?.toFixed(8)}`);
      this._sell(mint, 'EMA_CROSS');
    }
  }

  _checkTrailing(mint) {
    const t = this.store.get(mint);
    if (!t || t.state !== STATE.HOLDING) return;
    if (!t.buyPriceUsd || !t.currentPriceUsd) return;

    const pct = ((t.currentPriceUsd / t.buyPriceUsd) - 1) * 100;
    if (!t.trailingActivated && pct >= cfg.trailing.activatePct) {
      t.trailingActivated = true;
      log.info(`🎯 trailing 激活 ${mint.slice(0,8)} (+${pct.toFixed(0)}%)`);
      this._broadcast('trailing', { mint, activated: true });
      this._persist(t);  // trailing 激活立即持久化, 避免重启丢失
    }
    if (t.trailingActivated && t.peakPriceUsd > 0) {
      const drawdown = ((t.peakPriceUsd - t.currentPriceUsd) / t.peakPriceUsd) * 100;
      if (drawdown >= cfg.trailing.drawdownPct) {
        log.info(`📉 trailing 触发 ${mint.slice(0,8)} 回撤 ${drawdown.toFixed(1)}%`);
        this._sell(mint, 'TRAILING');
      }
    }
  }

  _onRugSignal(mint, evidence) {
    const t = this.store.get(mint);
    if (!t) return;
    if (t.state !== STATE.HOLDING) return;
    log.warn(`🚨 RUG 触发紧急卖出 ${mint.slice(0,8)} channel=${evidence.channel}`);
    this._sell(mint, 'RUG', evidence);
  }

  async _sell(mint, reason, evidence = null) {
    const t = this.store.get(mint);
    if (!t || t.state !== STATE.HOLDING) return;
    t.state = STATE.SELLING;
    this._broadcast('state', { mint, state: STATE.SELLING, reason });
    this._persist(t);

    const isRug = reason === 'RUG';
    const signalSlot = evidence?.slot ?? null;

    try {
      const res = await this.trader.sell(mint, {
        isRug,
        knownBalance: t.tokenBalance > 0n ? t.tokenBalance : null,
      });
      if (res.signature) {
        t.sellAt = Date.now();
        t.sellTxSig = res.signature;
        t.sellReason = reason;
        t.sellPriceUsd = t.currentPriceUsd;
        t.state = STATE.CLOSED;

        const solOut = Number(res.expectedOut || 0) / 1e9;
        const solIn = cfg.trade.buyAmountLamports / 1e9;
        const pnl = solOut - solIn;

        tradeDb.record({
          mint, symbol: t.symbol, side: 'SELL', reason,
          solAmount: solOut,
          tokenAmount: res.baseAmount,
          priceUsd: t.currentPriceUsd,
          txSig: res.signature,
          latencyMs: res.latencyMs,
          channel: res.channel,
          pnlSol: pnl,
          signalSlot,
          raw: evidence,
        });
        this._broadcast('state', { mint, state: STATE.CLOSED, reason, pnl });
        log.info(`✅ SOLD ${mint.slice(0,8)} reason=${reason} pnl≈${pnl.toFixed(4)} SOL (预估, 待 confirm)`);

        this.confirmTracker?.track(res.signature, {
          mint, side: 'SELL', reason, signalSlot,
        });
      } else {
        log.error(`❌ sell 失败 ${mint.slice(0,8)} reason=${reason}: ${res.error}`);
        tradeDb.record({
          mint, symbol: t.symbol, side: 'SELL_FAILED', reason,
          txSig: null, latencyMs: res.latencyMs,
          signalSlot,
          raw: { error: res.error, evidence },
        });
        t.state = STATE.HOLDING;
        this._persist(t);  // 回滚到 HOLDING, 持久化
        this._broadcast('sell_failed', { mint, reason, error: res.error });
      }
    } catch (e) {
      log.error(`sell 异常 ${mint.slice(0,8)}: ${e.message}`);
      tradeDb.record({
        mint, symbol: t.symbol, side: 'SELL_FAILED', reason,
        signalSlot,
        raw: { exception: e.message },
      });
      t.state = STATE.HOLDING;
      this._persist(t);
    } finally {
      if (t.state === STATE.CLOSED) {
        setTimeout(() => this._cleanup(mint), 5_000);
      }
    }
  }

  /**
   * confirmTracker 回调: 把实际 SOL / token / slot 回填 db 和内存
   */
  onTxConfirmed(info) {
    if (!info.sig) return;

    if (!info.ok) {
      // 链上失败: 标记 FAILED, 如果是 BUY 失败要清掉持仓状态
      log.error(`tx FAILED ${info.sig.slice(0,12)} side=${info.side} reason=${info.reason}: ${info.error}`);
      tradeDb.updateOnConfirm(info.sig, {
        landedSlot: info.landedSlot,
        slotDelta: info.slotDelta,
        status: 'FAILED',
      });
      const t = this.store.get(info.mint);
      if (t && info.side === 'BUY' && t.state === STATE.HOLDING) {
        // buy 上链失败: 取消监控 (没真买到)
        log.warn(`buy 上链失败, 清理 ${info.mint.slice(0,8)}`);
        this._cleanup(info.mint);
      }
      return;
    }

    const slotDeltaStr = info.slotDelta != null
      ? (info.slotDelta === 0 ? 'SAME_SLOT' : `+${info.slotDelta}`)
      : 'N/A';

    if (info.side === 'BUY') {
      // 校正内存中的 tokenBalance 为实际
      const t = this.store.get(info.mint);
      if (t && info.actualToken > 0n) {
        t.tokenBalance = info.actualToken;
        log.info(`📊 BUY confirmed ${info.mint.slice(0,8)} actual_token=${info.actualToken} actual_sol=${info.actualSol.toFixed(4)} slot=${info.landedSlot}`);
      }
      tradeDb.updateOnConfirm(info.sig, {
        actualSol: info.actualSol,
        actualToken: info.actualToken,
        landedSlot: info.landedSlot,
        slotDelta: info.slotDelta,
        status: 'CONFIRMED',
      });
      this._broadcast('confirmed', { mint: info.mint, side: 'BUY', landedSlot: info.landedSlot });
    } else if (info.side === 'SELL') {
      // 实际 PnL: actualSol (SELL 时为正) + 之前 BUY 实际花的 SOL
      // 但 BUY 的 actualSol 可能还没回填或不在内存; 用 db 查
      const buyRow = this._findConfirmedBuy(info.mint);
      let actualBuySol = -(cfg.trade.buyAmountLamports / 1e9); // 默认用预估
      if (buyRow?.sol_amount_actual != null) actualBuySol = buyRow.sol_amount_actual;
      const actualPnl = info.actualSol + actualBuySol;
      tradeDb.updateOnConfirm(info.sig, {
        actualSol: info.actualSol,
        actualToken: info.actualToken,
        actualPnlSol: actualPnl,
        landedSlot: info.landedSlot,
        slotDelta: info.slotDelta,
        status: 'CONFIRMED',
      });
      log.info(`📊 SELL confirmed ${info.mint.slice(0,8)} reason=${info.reason} actual_sol=${info.actualSol.toFixed(4)} actual_pnl=${actualPnl.toFixed(4)} slot=${info.landedSlot} ${info.reason === 'RUG' ? `slot_delta=${slotDeltaStr}` : ''}`);
      this._broadcast('confirmed', {
        mint: info.mint, side: 'SELL', reason: info.reason,
        landedSlot: info.landedSlot, slotDelta: info.slotDelta, actualPnl,
      });
    }
  }

  _findConfirmedBuy(mint) {
    // 简单实现: 翻最近 100 条找该 mint 的 BUY
    const list = tradeDb.recent(200);
    for (const r of list) {
      if (r.mint === mint && r.side === 'BUY' && r.status === 'CONFIRMED') return r;
    }
    return null;
  }

  _cleanup(mint) {
    this.poller.unsubscribe(mint);
    this.rug.unwatch(mint);
    this._notifyUnwatch(mint);
    this.store.remove(mint);
    this.trader.forgetPool?.(mint);
    // v4: 从 positions 表删除
    try { tradeDb.deletePosition(mint); } catch (e) {}
    this._broadcast('remove', { mint });
  }

  async _refreshOverviews() {
    const toks = this.store.list();
    for (const t of toks) {
      if (t.state === STATE.CLOSED) continue;
      await this._refreshOneOverview(t.mint);
    }
  }

  async _refreshOneOverview(mint) {
    const t = this.store.get(mint);
    if (!t) return;

    // v4: birdeye overview 只用来填 holders / volume / symbol (dashboard 元数据)
    // FDV / LP 用链上数据 (更准, 不延迟)
    const ov = await fetchTokenOverview(mint);
    if (ov) {
      if (ov.volume24h > 0) t.volume24h = ov.volume24h;
      if (ov.holders > 0) t.holders = ov.holders;
      if (!t.symbol && ov.symbol) t.symbol = ov.symbol;
      t.lastOverviewAt = Date.now();
    }

    // 链上 FDV/LP — 优先 (实时, 准确)
    const chain = this.trader.getOnChainFdvLp?.(mint);
    if (chain) {
      t.fdv = chain.fdv;
      t.lp = chain.lp;
      // chain.priceUsd 不覆盖 currentPriceUsd, 那个来自 birdeye poller 的高频数据
    } else if (ov?.fdv > 0 && ov?.liquidity > 0) {
      // 链上不可用时退回 birdeye
      t.fdv = ov.fdv;
      t.lp = ov.liquidity;
    }

    const GRACE_MS = 60_000;
    const inGrace = t.buyAt && (Date.now() - t.buyAt < GRACE_MS);
    const hasRealData = t.fdv > 0 && t.lp > 0;
    const belowThreshold = hasRealData && (t.fdv < cfg.monitor.minFdv || t.lp < cfg.monitor.minLp);

    if (belowThreshold && !inGrace) {
      if (t.state === STATE.HOLDING) {
        log.info(`📉 ${mint.slice(0,8)} 跌破阈值 fdv=$${t.fdv.toFixed(0)} lp=$${t.lp.toFixed(0)} → 卖出并移除`);
        this._sell(mint, 'BELOW_THRESHOLD');
      } else if (t.state !== STATE.BUYING && t.state !== STATE.SELLING) {
        log.info(`📉 ${mint.slice(0,8)} 跌破阈值,无持仓直接移除`);
        this._cleanup(mint);
      }
    }
  }

  _broadcast(type, data) {
    this.wsHub?.broadcast({ type, data, ts: Date.now() });
  }

  snapshot() {
    return this.store.list().map(t => ({
      mint: t.mint,
      symbol: t.symbol,
      state: t.state,
      addedAt: t.addedAt,
      buyAt: t.buyAt,
      buyTxSig: t.buyTxSig,
      sellAt: t.sellAt,
      sellReason: t.sellReason,
      sellTxSig: t.sellTxSig,
      poolAddress: t.poolAddress,
      fdv: t.fdv, lp: t.lp, volume24h: t.volume24h, holders: t.holders,
      ageSec: t.ageSec,
      currentPriceUsd: t.currentPriceUsd,
      peakPriceUsd: t.peakPriceUsd,
      buyPriceUsd: t.buyPriceUsd,
      trailingActivated: t.trailingActivated,
      pnlSol: tradeDb.pnlByMint(t.mint),
    }));
  }
}

module.exports = { Strategy };
