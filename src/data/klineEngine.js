'use strict';
//
// K线合成引擎。
//   - 输入: 1秒价格 tick (price, ts)
//   - 输出: 15秒 OHLC bar + EMA9 / EMA20
//
// EMA 算法 (TradingView / GMGN 标准):
//   1. 前 N 根用 SMA 初始化 EMA(N)
//   2. 之后: ema = price * k + prev_ema * (1 - k),  k = 2 / (N+1)
//
// EMA9 下穿 EMA20 = 上一根 ema9 >= ema20  且  当前 ema9 < ema20
//

const cfg = require('../config');

class KlineEngine {
  /**
   * @param {object} opts
   * @param {number} opts.intervalSec   K线周期, 默认 15
   * @param {number} opts.emaFast       默认 9
   * @param {number} opts.emaSlow       默认 20
   * @param {(bar, ctx)=>void} opts.onBarClose  每根K线收盘时回调
   */
  constructor(opts = {}) {
    this.intervalSec = opts.intervalSec ?? cfg.kline.intervalSec;
    this.fastN = opts.emaFast ?? cfg.kline.emaFast;
    this.slowN = opts.emaSlow ?? cfg.kline.emaSlow;
    this.onBarClose = opts.onBarClose || (() => {});

    /** 已收盘的 bars */
    this.bars = [];
    /** 当前未收盘 bar */
    this.current = null;
    /** ema 数组,index 与 bars 对齐 */
    this.emaFast = [];
    this.emaSlow = [];
  }

  /** 把 epoch ms 对齐到该 K 线起点 (秒) */
  _alignSec(tsMs) {
    const s = Math.floor(tsMs / 1000);
    return s - (s % this.intervalSec);
  }

  /**
   * 喂入一个 tick
   * @param {{price:number, ts:number}} tick
   */
  push(tick) {
    const { price, ts } = tick;
    if (!Number.isFinite(price) || price <= 0) return;
    const barOpen = this._alignSec(ts);

    if (!this.current) {
      this.current = { t: barOpen, o: price, h: price, l: price, c: price, v: 0 };
      return;
    }

    if (barOpen > this.current.t) {
      // 收掉旧的,可能跨过空 bar(用上一根 c 填)
      this._closeBar(this.current);
      let lastClose = this.current.c;
      let nextOpen = this.current.t + this.intervalSec;
      while (nextOpen < barOpen) {
        const filler = { t: nextOpen, o: lastClose, h: lastClose, l: lastClose, c: lastClose, v: 0 };
        this._closeBar(filler);
        nextOpen += this.intervalSec;
      }
      this.current = { t: barOpen, o: price, h: price, l: price, c: price, v: 0 };
    } else {
      // 在当前 bar 内
      if (price > this.current.h) this.current.h = price;
      if (price < this.current.l) this.current.l = price;
      this.current.c = price;
    }
  }

  _closeBar(bar) {
    this.bars.push(bar);
    this._updateEma(bar.c);
    this.onBarClose(bar, this._snapshot());
  }

  _updateEma(close) {
    const i = this.bars.length - 1;
    this.emaFast[i] = this._calcEma(this.emaFast, this.fastN, i);
    this.emaSlow[i] = this._calcEma(this.emaSlow, this.slowN, i);
  }

  _calcEma(arr, n, i) {
    if (i < n - 1) return null;
    if (i === n - 1) {
      // SMA 初始化
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += this.bars[j].c;
      return sum / n;
    }
    const k = 2 / (n + 1);
    const prev = arr[i - 1];
    if (prev == null) return null;
    return this.bars[i].c * k + prev * (1 - k);
  }

  _snapshot() {
    const i = this.bars.length - 1;
    return {
      bars: this.bars,
      lastBar: this.bars[i],
      emaFast: this.emaFast,
      emaSlow: this.emaSlow,
      emaFastNow: this.emaFast[i],
      emaSlowNow: this.emaSlow[i],
      emaFastPrev: this.emaFast[i - 1],
      emaSlowPrev: this.emaSlow[i - 1],
      barCount: this.bars.length,
    };
  }

  /**
   * 检查是否刚刚发生 EMA9 下穿 EMA20
   * 必须在 onBarClose 内调用
   */
  isBearCross() {
    const s = this._snapshot();
    if (s.emaFastPrev == null || s.emaSlowPrev == null) return false;
    if (s.emaFastNow == null || s.emaSlowNow == null) return false;
    return s.emaFastPrev >= s.emaSlowPrev && s.emaFastNow < s.emaSlowNow;
  }

  snapshot() { return this._snapshot(); }
}

module.exports = { KlineEngine };
