'use strict';
//
// 策略大脑。
//   - 收到 webhook  → buy
//   - 1秒价格 tick  → 喂 K 线
//   - K线收盘 → 检查 EMA cross (warmup 后) + trailing
//   - rugDetector 'rug' 事件 → 紧急卖出
//   - FDV / LP 跌破阈值 → 移除监控 (有持仓先卖)
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
   * @param {Array<{watch(mint):void, unwatch(mint):void}>} [deps.dataSources]
   *   每次 token 加入/移除时, 会调用这些数据源的 watch/unwatch
   */
  constructor({ trader, rugDetector, wsHub, dataSources = [] }) {
    this.trader = trader;
    this.rug = rugDetector;
    this.wsHub = wsHub;
    this.dataSources = dataSources;
    this.poller = new BirdeyePoller();
    this.store = new TokenStore();
    this._overviewTimer = setInterval(() => this._refreshOverviews().catch(()=>{}), 30_000);

    this.rug.on('rug', (mint, evidence) => this._onRugSignal(mint, evidence));
  }

  _notifyWatch(mint) { for (const d of this.dataSources) try { d.watch(mint); } catch(e){} }
  _notifyUnwatch(mint) { for (const d of this.dataSources) try { d.unwatch(mint); } catch(e){} }

  /** dashboard: 当前是否还有未结束交易 (用于优雅退出) */
  hasPendingTrades() {
    return this.store.list().some(t =>
      t.state === STATE.BUYING || t.state === STATE.SELLING
    );
  }

  stop() { clearInterval(this._overviewTimer); }

  /**
   * 新代币进入: webhook 触发, 立即买入
   */
  async onWebhookAdd(mint, symbol) {
    if (this.store.get(mint)) {
      log.info(`${mint.slice(0,8)} 已在监控,跳过`);
      return;
    }
    log.info(`✅ webhook add ${mint.slice(0,8)} ${symbol}`);

    const tok = this.store.add(mint, {
      symbol,
      onBarClose: (bar, snap) => this._onBarClose(mint, bar, snap),
    });

    // 开始价格轮询
    this.poller.subscribe(mint, (tick) => this._onPriceTick(mint, tick));
    // 开始 RUG 监听
    this.rug.watch(mint);
    // 通知所有数据源 (helius / shredstream) 加 mint 到订阅
    this._notifyWatch(mint);
    // 异步拉一次元数据 (不阻塞买入)
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
        // tokenBalance 从 expectedOut 估算;实际成交后会用 onchain 余额校正
        tok.tokenBalance = BigInt(res.expectedOut || 0);
        tradeDb.record({
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
      } else {
        log.error(`buy 失败 ${mint.slice(0,8)}: ${res.error}`);
        this._cleanup(mint);
      }
    } catch (e) {
      log.error(`buy 异常 ${mint.slice(0,8)}: ${e.message}`);
      this._cleanup(mint);
    }
  }

  /**
   * 价格 tick → 喂 K线 + 更新 peak
   */
  _onPriceTick(mint, tick) {
    const t = this.store.get(mint);
    if (!t || t.state === STATE.CLOSED) return;
    t.currentPriceUsd = tick.price;
    t.lastPriceTickAt = tick.ts;

    // 买入成功后第一次拿到价格 tick: 锁定 buyPriceUsd (trailing 计算基准)
    if (t.state === STATE.HOLDING && !t.buyPriceUsd && tick.price > 0) {
      t.buyPriceUsd = tick.price;
      t.peakPriceUsd = tick.price;
      log.info(`📌 ${mint.slice(0,8)} buyPriceUsd = ${tick.price}`);
    }

    if (t.state === STATE.HOLDING) {
      if (tick.price > t.peakPriceUsd) t.peakPriceUsd = tick.price;
      // trailing 实时检查 (不等 K 线收盘)
      this._checkTrailing(mint);
    }
    t.kline.push({ price: tick.price, ts: tick.ts });
  }

  /**
   * K线收盘 → EMA cross 检查
   */
  _onBarClose(mint, bar, snap) {
    const t = this.store.get(mint);
    if (!t || t.state !== STATE.HOLDING) return;
    t.barsSinceBuy++;
    this._broadcast('bar', { mint, bar, ema9: snap.emaFastNow, ema20: snap.emaSlowNow });

    if (t.barsSinceBuy < cfg.kline.warmupBars) return;
    if (t.kline.isBearCross()) {
      log.info(`📉 EMA cross ${mint.slice(0,8)} ema9=${snap.emaFastNow?.toFixed(8)} ema20=${snap.emaSlowNow?.toFixed(8)}`);
      this._sell(mint, 'EMA_CROSS');
    }
  }

  /**
   * trailing 检查
   */
  _checkTrailing(mint) {
    const t = this.store.get(mint);
    if (!t || t.state !== STATE.HOLDING) return;
    if (!t.buyPriceUsd || !t.currentPriceUsd) return;

    const pct = ((t.currentPriceUsd / t.buyPriceUsd) - 1) * 100;
    if (!t.trailingActivated && pct >= cfg.trailing.activatePct) {
      t.trailingActivated = true;
      log.info(`🎯 trailing 激活 ${mint.slice(0,8)} (+${pct.toFixed(0)}%)`);
      this._broadcast('trailing', { mint, activated: true });
    }
    if (t.trailingActivated && t.peakPriceUsd > 0) {
      const drawdown = ((t.peakPriceUsd - t.currentPriceUsd) / t.peakPriceUsd) * 100;
      if (drawdown >= cfg.trailing.drawdownPct) {
        log.info(`📉 trailing 触发 ${mint.slice(0,8)} 回撤 ${drawdown.toFixed(1)}%`);
        this._sell(mint, 'TRAILING');
      }
    }
  }

  /**
   * RUG 信号 → 紧急卖出
   */
  _onRugSignal(mint, evidence) {
    const t = this.store.get(mint);
    if (!t) return;
    if (t.state !== STATE.HOLDING) return;
    log.warn(`🚨 RUG 触发紧急卖出 ${mint.slice(0,8)}`, evidence);
    this._sell(mint, 'RUG', evidence);
  }

  async _sell(mint, reason, evidence = null) {
    const t = this.store.get(mint);
    if (!t || t.state !== STATE.HOLDING) return;
    t.state = STATE.SELLING;
    this._broadcast('state', { mint, state: STATE.SELLING, reason });

    const isRug = reason === 'RUG';
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

        const solOut = Number(res.expectedOut || 0) / 1e9; // 预估,实际成交可能有滑点
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
          raw: evidence,
        });
        this._broadcast('state', { mint, state: STATE.CLOSED, reason, pnl });
        log.info(`✅ SOLD ${mint.slice(0,8)} reason=${reason} pnl≈${pnl.toFixed(4)} SOL (估算)`);
      } else {
        // 卖出失败: 记入 db, 把状态回滚到 HOLDING 让后续策略再尝试
        log.error(`❌ sell 失败 ${mint.slice(0,8)} reason=${reason}: ${res.error}`);
        tradeDb.record({
          mint, symbol: t.symbol, side: 'SELL_FAILED', reason,
          txSig: null, latencyMs: res.latencyMs,
          raw: { error: res.error, evidence },
        });
        t.state = STATE.HOLDING;
        this._broadcast('sell_failed', { mint, reason, error: res.error });
      }
    } catch (e) {
      log.error(`sell 异常 ${mint.slice(0,8)}: ${e.message}`);
      tradeDb.record({
        mint, symbol: t.symbol, side: 'SELL_FAILED', reason,
        raw: { exception: e.message },
      });
      t.state = STATE.HOLDING;
    } finally {
      if (t.state === STATE.CLOSED) {
        setTimeout(() => this._cleanup(mint), 5_000);
      }
    }
  }

  _cleanup(mint) {
    this.poller.unsubscribe(mint);
    this.rug.unwatch(mint);
    this._notifyUnwatch(mint);
    this.store.remove(mint);
    this.trader.forgetPool?.(mint);
    this._broadcast('remove', { mint });
  }

  /**
   * dashboard 元数据刷新 (FDV / LP / holders / volume / age)
   */
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
    const ov = await fetchTokenOverview(mint);
    if (!ov) return;
    // 仅在拿到非零数据时更新, 避免 birdeye 未索引返回 0 把缓存覆盖掉
    if (ov.fdv > 0) t.fdv = ov.fdv;
    if (ov.liquidity > 0) t.lp = ov.liquidity;
    if (ov.volume24h > 0) t.volume24h = ov.volume24h;
    if (ov.holders > 0) t.holders = ov.holders;
    if (!t.symbol) t.symbol = ov.symbol;
    t.lastOverviewAt = Date.now();

    // 阈值检查需要的两个保护:
    //   1. fdv/lp 必须 > 0 才算"真实数据"; = 0 通常是 birdeye 未索引
    //   2. buyAt 后 grace period (60s) 内不杀, 防止刚迁移就被早期价格波动误杀
    const GRACE_MS = 60_000;
    const inGrace = t.buyAt && (Date.now() - t.buyAt < GRACE_MS);
    const hasRealData = ov.fdv > 0 && ov.liquidity > 0;
    const belowThreshold = hasRealData && (ov.fdv < cfg.monitor.minFdv || ov.liquidity < cfg.monitor.minLp);

    if (belowThreshold && !inGrace) {
      if (t.state === STATE.HOLDING) {
        log.info(`📉 ${mint.slice(0,8)} 跌破阈值 fdv=${ov.fdv} lp=${ov.liquidity} → 卖出并移除`);
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

  /**
   * dashboard 用: 监控列表 + 状态快照
   */
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
