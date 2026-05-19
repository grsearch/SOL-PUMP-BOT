'use strict';
//
// 监控的 token 状态机。
//
// state:
//   PENDING   - webhook 收到, 还没买入
//   BUYING    - buy tx 已发, 等确认
//   HOLDING   - 已持仓, K线运转
//   SELLING   - sell tx 已发
//   CLOSED    - 已卖完, 准备清理
//
// 每个 token 都挂一个 KlineEngine。

const { KlineEngine } = require('../data/klineEngine');

const STATE = {
  PENDING: 'PENDING',
  BUYING: 'BUYING',
  HOLDING: 'HOLDING',
  SELLING: 'SELLING',
  CLOSED: 'CLOSED',
};

class TokenStore {
  constructor() {
    /** @type {Map<string, object>} mint → state */
    this.tokens = new Map();
  }

  add(mint, meta = {}) {
    if (this.tokens.has(mint)) return this.tokens.get(mint);
    const t = {
      mint,
      symbol: meta.symbol || '',
      state: STATE.PENDING,
      addedAt: Date.now(),
      buyAt: null,
      buyPriceUsd: 0,
      buyTxSig: null,
      buyAmountLamports: 0,
      tokenBalance: 0n,        // 已买入的 token 数量
      sellAt: null,
      sellPriceUsd: 0,
      sellTxSig: null,
      sellReason: null,        // EMA_CROSS / TRAILING / RUG / MANUAL
      peakPriceUsd: 0,         // 历史最高价 (用于 trailing)
      trailingActivated: false,
      // dashboard 元数据
      fdv: 0, lp: 0, volume24h: 0, holders: 0, ageSec: null,
      lastOverviewAt: 0,
      // 价格历史
      currentPriceUsd: 0,
      lastPriceTickAt: 0,
      // K线
      kline: new KlineEngine({ onBarClose: meta.onBarClose }),
      barsSinceBuy: 0,         // 买入后多少根 K 线了
    };
    this.tokens.set(mint, t);
    return t;
  }

  get(mint) { return this.tokens.get(mint); }
  remove(mint) { return this.tokens.delete(mint); }
  list() { return Array.from(this.tokens.values()); }

  setState(mint, state) {
    const t = this.tokens.get(mint);
    if (t) t.state = state;
  }
}

module.exports = { TokenStore, STATE };
