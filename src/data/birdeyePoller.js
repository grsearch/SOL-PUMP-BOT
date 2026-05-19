'use strict';
//
// Birdeye 1秒价格轮询。
// 用 /defi/price?address=<mint> 拿 USD 价 + 区块时间。
// 对每个被监控的 mint 独立轮询,退订时清理。
//
// 也提供 fetchTokenOverview() 用来取 FDV / LP / 24h volume / age 等 dashboard 数据。

const axios = require('axios');
const cfg = require('../config');
const log = require('../utils/logger').child('birdeye');

const http = axios.create({
  baseURL: cfg.birdeye.base,
  timeout: 8000,
  headers: {
    'X-API-KEY': cfg.birdeye.apiKey,
    'x-chain': 'solana',
    'accept': 'application/json',
  },
});

class BirdeyePoller {
  constructor() {
    /** @type {Map<string, {timer: NodeJS.Timeout, onTick: Function, lastPrice: number}>} */
    this.pollers = new Map();
  }

  /**
   * 订阅一个 mint 的 1秒价格轮询
   * @param {string} mint
   * @param {(tick: {price:number, ts:number, mint:string})=>void} onTick
   */
  subscribe(mint, onTick) {
    if (this.pollers.has(mint)) {
      log.warn(`already subscribed: ${mint}`);
      return;
    }
    const state = { stopped: false, timer: null, onTick, lastPrice: 0 };

    const tick = async () => {
      if (state.stopped) return;
      try {
        const { data } = await http.get('/defi/price', { params: { address: mint } });
        const v = data?.data;
        if (v && typeof v.value === 'number') {
          state.lastPrice = v.value;
          // 用 wall clock 作为 K 线对齐 ts (birdeye 的 updateUnixTime 在新池滞后,
          // 用它会导致 K 线边界漂移; wall clock 保证规则切分)
          onTick({ price: v.value, ts: Date.now(), mint });
        }
      } catch (e) {
        if (e.response?.status !== 404) {
          log.debug(`poll ${mint.slice(0, 6)} err: ${e.message}`);
        }
      } finally {
        if (!state.stopped) {
          // 串行: 上一次完成后才排下一次, 避免雪崩
          state.timer = setTimeout(tick, cfg.kline.pollSec * 1000);
        }
      }
    };

    this.pollers.set(mint, state);
    tick();
    log.info(`subscribed ${mint}`);
  }

  unsubscribe(mint) {
    const s = this.pollers.get(mint);
    if (!s) return;
    s.stopped = true;
    if (s.timer) clearTimeout(s.timer);
    this.pollers.delete(mint);
    log.info(`unsubscribed ${mint}`);
  }

  has(mint) { return this.pollers.has(mint); }
  size() { return this.pollers.size; }
}

/**
 * 一次性查询 token 元数据 / FDV / LP / volume
 * Birdeye /defi/token_overview
 */
async function fetchTokenOverview(mint) {
  try {
    const { data } = await http.get('/defi/token_overview', { params: { address: mint } });
    const d = data?.data;
    if (!d) return null;
    return {
      mint,
      symbol: d.symbol || '',
      name: d.name || '',
      price: d.price || 0,
      fdv: d.fdv || d.mc || 0,
      liquidity: d.liquidity || 0,
      volume24h: d.v24hUSD || d.volume24hUSD || 0,
      holders: d.holder || 0,
      supply: d.supply || 0,
      decimals: d.decimals || 6,
    };
  } catch (e) {
    log.debug(`overview ${mint.slice(0, 6)} err: ${e.message}`);
    return null;
  }
}

module.exports = { BirdeyePoller, fetchTokenOverview };
