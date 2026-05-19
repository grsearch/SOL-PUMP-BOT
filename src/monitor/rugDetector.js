'use strict';
//
// RUG 同 slot 卖出检测器。
//
// 检测规则:
//   在滑动窗口 (RUG_SLOT_WINDOW slot) 内,如果出现:
//     - 至少 RUG_SAME_SLOT_MIN_SELLS 笔卖单
//     - 累计 SOL >= RUG_SAME_SLOT_MIN_SOL
//     - 这些卖单的 priority fee (lamports) 高度一致 (差 <= RUG_GAS_TOLERANCE_LAMPORTS)
//     - 这些卖单来自不同的 owner (≥ 3 个不同钱包)
//   → 触发 RUG 信号,emit('rug', mint, evidence)
//
// 数据源 (双订阅,任一触发):
//   1. Helius LaserStream gRPC: subscribe transactions where account_include = [mint]
//      → 解析每个 tx 的 priority fee + 卖出方向 + sol量
//   2. Shredstream: 同样订阅 mint 相关交易,但拿到的是 shred 级别 (未确认),更快
//
// 实现细节:
//   - 每个 mint 维护一个 ring buffer of recent sells (按 slot)
//   - 每收到新 sell, 检查 [slot-window, slot] 窗口是否满足触发条件
//   - 一旦触发,立即 emit,然后该 mint 标记为 rugged,不再重复触发
//
// ⚠️ 重要: 本文件包含 Helius / Shredstream 的客户端封装。
// 实际部署时,请用真实 endpoint 和 proto 文件替换占位实现。
// 已留出统一接口 RugDataSource,只要喂入 SellEvent 即可。

const EventEmitter = require('events');
const cfg = require('../config');
const log = require('../utils/logger').child('rug');

/**
 * @typedef {object} SellEvent
 * @property {string} mint        - token mint
 * @property {string} signature   - tx signature
 * @property {number} slot
 * @property {string} owner       - seller wallet
 * @property {number} solAmount   - SOL 流入 owner 的数量 (即卖出获得的 SOL)
 * @property {number} priorityFeeLamports
 * @property {number} ts          - ms
 */

class RugDetector extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, {sells: SellEvent[], triggered: boolean}>} */
    this.state = new Map();
  }

  watch(mint) {
    if (!this.state.has(mint)) {
      this.state.set(mint, { sells: [], triggered: false });
      log.info(`watching ${mint.slice(0, 8)}`);
    }
  }

  unwatch(mint) {
    this.state.delete(mint);
  }

  /**
   * 喂入一个卖单事件 (来自 helius / shredstream / slipstream 任一通道)
   */
  ingest(ev) {
    const s = this.state.get(ev.mint);
    if (!s || s.triggered) return;

    // 去重 (同 signature 多通道会重复推送)
    if (s.sells.some(x => x.signature === ev.signature)) return;

    s.sells.push(ev);

    // 修剪: ring buffer, 上限 200 (用 while 防止一次推入多条时漏修)
    while (s.sells.length > 200) s.sells.shift();

    // 滑动窗口右边界 = 已收到的最大 slot (防止乱序到达时漏算)
    const maxSlot = s.sells.reduce((m, x) => x.slot > m ? x.slot : m, ev.slot);
    this._check(ev.mint, maxSlot);
  }

  _check(mint, currentSlot) {
    const s = this.state.get(mint);
    if (!s || s.triggered) return;

    const windowStart = currentSlot - cfg.rug.slotWindow;
    const recent = s.sells.filter(x => x.slot >= windowStart && x.slot <= currentSlot);

    if (recent.length < cfg.rug.minSells) return;

    const totalSol = recent.reduce((a, x) => a + x.solAmount, 0);
    if (totalSol < cfg.rug.minSolTotal) return;

    // 不同 owner 数 >= 3 (单个钱包多笔不算协同)
    const owners = new Set(recent.map(x => x.owner));
    if (owners.size < 3) return;

    // priority fee 一致性: 中位数 ± tolerance
    const fees = recent.map(x => x.priorityFeeLamports).sort((a, b) => a - b);
    const median = fees[Math.floor(fees.length / 2)];
    const consistent = fees.filter(f => Math.abs(f - median) <= cfg.rug.gasToleranceLamports);
    if (consistent.length < cfg.rug.minSells) return;

    // 触发!
    s.triggered = true;
    const evidence = {
      mint,
      slot: currentSlot,
      sellCount: recent.length,
      uniqueOwners: owners.size,
      totalSol,
      medianFee: median,
      consistentFees: consistent.length,
      sigs: recent.map(x => x.signature),
    };
    log.warn(`🚨 RUG detected ${mint.slice(0, 8)} slot=${currentSlot} sells=${recent.length} sol=${totalSol.toFixed(2)} owners=${owners.size}`);
    this.emit('rug', mint, evidence);
  }
}

module.exports = { RugDetector };
