'use strict';
//
// RUG 同 slot 卖出检测器。
//
// 触发通道 (从严格到宽松, 都开启):
//   A. STRICT 协同抛售: 滑动窗口内 ≥ minSells 笔 + ≥ minSolTotal SOL + 不同 owner ≥ 3 + priority fee 一致
//   B. FALLBACK 量化抛售: 滑动窗口内 ≥ fallbackMinSells 笔 + ≥ fallbackMinSol SOL (不要求 fee 一致 / 不要求多 owner)
//      用于 shredstream 数据通道 owner/fee 不全时的兜底
//   C. PRICE_CRASH 价格暴跌: 通过 ingestPriceDrop() 喂入,短时间内跌 ≥ pctDrop% 触发
//      最后防线 — 即便 helius/shred 全挂,价格信号也能触发
//

const EventEmitter = require('events');
const cfg = require('../config');
const log = require('../utils/logger').child('rug');

class RugDetector extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, {sells: SellEvent[], priceHistory: Array<{price,ts}>, triggered: boolean}>} */
    this.state = new Map();
  }

  watch(mint) {
    if (!this.state.has(mint)) {
      this.state.set(mint, { sells: [], priceHistory: [], triggered: false });
      log.info(`watching ${mint.slice(0, 8)}`);
    }
  }

  unwatch(mint) {
    this.state.delete(mint);
  }

  /**
   * 喂入 sell event
   */
  ingest(ev) {
    const s = this.state.get(ev.mint);
    if (!s || s.triggered) return;

    // 去重
    if (ev.signature && s.sells.some(x => x.signature === ev.signature)) return;

    log.debug(`ingest ${ev.mint?.slice(0,8)} owner=${ev.owner?.slice(0,8) || '?'} sol=${(ev.solAmount || 0).toFixed(4)} slot=${ev.slot} fee=${ev.priorityFeeLamports || 0}`);
    s.sells.push(ev);
    while (s.sells.length > 200) s.sells.shift();

    const maxSlot = s.sells.reduce((m, x) => x.slot > m ? x.slot : m, ev.slot);
    this._checkSells(ev.mint, maxSlot);
  }

  /**
   * 喂入价格点 (用于 PRICE_CRASH 检测)
   * 单位 USD,或者用户给的任何一致单位都行 (我们看百分比)
   */
  ingestPriceDrop(mint, price, ts = Date.now()) {
    const s = this.state.get(mint);
    if (!s || s.triggered) return;
    if (!Number.isFinite(price) || price <= 0) return;

    s.priceHistory.push({ price, ts });
    // 只保留最近 30 秒
    const cutoff = ts - 30_000;
    while (s.priceHistory.length > 0 && s.priceHistory[0].ts < cutoff) s.priceHistory.shift();

    if (!cfg.rug.priceCrashEnabled) return;
    // 拿窗口内的最高价当基准
    let peak = 0;
    for (const p of s.priceHistory) if (p.price > peak) peak = p.price;
    if (peak <= 0) return;
    const dropPct = (peak - price) / peak * 100;
    if (dropPct >= cfg.rug.priceCrashPct) {
      this._fire(mint, {
        channel: 'PRICE_CRASH',
        slot: null,             // 价格通道没有 slot
        peakPrice: peak,
        currentPrice: price,
        dropPct,
      });
    }
  }

  _checkSells(mint, currentSlot) {
    const s = this.state.get(mint);
    if (!s || s.triggered) return;

    const windowStart = currentSlot - cfg.rug.slotWindow;
    const recent = s.sells.filter(x => x.slot >= windowStart && x.slot <= currentSlot);
    if (recent.length === 0) return;

    const totalSol = recent.reduce((a, x) => a + (x.solAmount || 0), 0);
    const owners = new Set(recent.map(x => x.owner).filter(Boolean));

    // 通道按从严到松的顺序排, 任一满足立即触发
    // 每个通道是一个 {name, check} 对象, 以后加新规则就 push 一条
    for (const signal of this._buildSignals()) {
      const evidence = signal.check({ recent, totalSol, owners, currentSlot });
      if (evidence) {
        return this._fire(mint, { ...evidence, channel: signal.name });
      }
    }
  }

  /**
   * RUG 信号列表 (按严格度排序, 第一个匹配的触发).
   * 加新规则的方法: 往返回数组里 push 一个 {name, check} 即可。
   */
  _buildSignals() {
    return [
      // ─── 通道 STRICT: 5+ 笔同 slot 多钱包同 gas, 总 ≥5 SOL ───
      {
        name: 'STRICT',
        check: ({ recent, totalSol, owners, currentSlot }) => {
          if (recent.length < cfg.rug.minSells) return null;
          if (totalSol < cfg.rug.minSolTotal) return null;
          if (owners.size < 3) return null;
          const consistent = this._countConsistentFees(recent);
          if (consistent < cfg.rug.minSells) return null;
          return {
            slot: currentSlot,
            sellCount: recent.length,
            uniqueOwners: owners.size,
            totalSol,
            consistentFees: consistent,
            sigs: recent.map(x => x.signature),
          };
        },
      },

      // ─── 通道 AGGRESSIVE: 3+ 笔同 slot 同 gas, 总 ≥10 SOL ───
      // 比 STRICT 笔数少 (3+) 但单笔金额大 (总 ≥10 SOL), 抓"少数大户协同砸盘"
      {
        name: 'AGGRESSIVE',
        check: ({ recent, totalSol, owners, currentSlot }) => {
          if (recent.length < cfg.rug.aggrMinSells) return null;
          if (totalSol < cfg.rug.aggrMinSolTotal) return null;
          // 同 gas 检查: 至少 aggrMinSells 笔 fee 一致
          const consistent = this._countConsistentFees(recent);
          if (consistent < cfg.rug.aggrMinSells) return null;
          // owner 要求宽一点: ≥2 (避免单一钱包大单触发, 那不是 rug)
          if (owners.size < 2) return null;
          return {
            slot: currentSlot,
            sellCount: recent.length,
            uniqueOwners: owners.size,
            totalSol,
            consistentFees: consistent,
            sigs: recent.map(x => x.signature),
          };
        },
      },

      // ─── 通道 FALLBACK: 数据不全时兜底 ───
      {
        name: 'FALLBACK',
        check: ({ recent, totalSol, owners, currentSlot }) => {
          if (!cfg.rug.fallbackEnabled) return null;
          if (recent.length < cfg.rug.fallbackMinSells) return null;
          if (totalSol < cfg.rug.fallbackMinSol) return null;
          return {
            slot: currentSlot,
            sellCount: recent.length,
            uniqueOwners: owners.size,
            totalSol,
            sigs: recent.map(x => x.signature),
          };
        },
      },
    ];
  }

  /**
   * 计算 recent 中有多少笔的 priority fee 一致 (中位数 ± gasTolerance).
   * fee=0 的不算 (shred 阶段可能没读到)
   */
  _countConsistentFees(recent) {
    const fees = recent.map(x => x.priorityFeeLamports || 0).filter(f => f > 0).sort((a, b) => a - b);
    if (fees.length === 0) return 0;
    const median = fees[Math.floor(fees.length / 2)];
    return fees.filter(f => Math.abs(f - median) <= cfg.rug.gasToleranceLamports).length;
  }

  _fire(mint, evidence) {
    const s = this.state.get(mint);
    if (!s || s.triggered) return;
    s.triggered = true;
    evidence.mint = mint;
    log.warn(`🚨 RUG [${evidence.channel}] ${mint.slice(0, 8)} ` +
      (evidence.slot != null ? `slot=${evidence.slot} ` : '') +
      (evidence.sellCount != null ? `sells=${evidence.sellCount} sol=${evidence.totalSol?.toFixed(2)} owners=${evidence.uniqueOwners} ` : '') +
      (evidence.dropPct != null ? `drop=${evidence.dropPct.toFixed(1)}% ` : '')
    );
    this.emit('rug', mint, evidence);
  }
}

module.exports = { RugDetector };
