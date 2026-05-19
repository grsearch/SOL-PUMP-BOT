'use strict';
//
// 交易确认追踪器。
//
// 用途:
//   1. trader.buy/sell 拿到 signature 后,把任务交给 tracker.track(sig, ctx)
//   2. tracker 用 getTransaction (commitment=confirmed) 轮询直到拿到 result
//   3. 提取:
//      - landed_slot (tx 在哪个 slot 落地, 用于 RUG 卖出 slot 差对比)
//      - 实际 SOL 净流入 (钱包 pre/post lamports + fee)
//      - 实际 token 净变化 (钱包 pre/post token balance)
//   4. 回调 onConfirmed(...) → 交给 strategy 回填 db / 校正 tokenBalance
//
// 用 confirmed 而不是 finalized: confirmed ~1-2s, finalized ~13s。
// confirmed 已经不会被 fork 掉,够用。
//

const { Connection } = require('@solana/web3.js');
const cfg = require('../config');
const log = require('../utils/logger').child('confirm');

const POLL_INTERVAL_MS = 800;
const MAX_WAIT_MS = 60_000;

class ConfirmTracker {
  /**
   * @param {object} opts
   * @param {(info)=>void} opts.onConfirmed
   *   info = { sig, ok, side, mint, reason, signalSlot?, actualSol, actualToken,
   *            landedSlot, slotDelta, error?, blockTime? }
   * @param {PublicKey} opts.walletPubkey
   */
  constructor({ onConfirmed, walletPubkey }) {
    this.onConfirmed = onConfirmed;
    this.walletPubkey = walletPubkey;
    this.walletStr = walletPubkey.toBase58();
    this.conn = new Connection(cfg.helius.rpc, 'confirmed');
    this.pending = new Map(); // sig → ctx
  }

  /**
   * 开始追踪一笔 tx
   * @param {string} sig
   * @param {object} ctx
   * @param {string} ctx.mint
   * @param {'BUY'|'SELL'} ctx.side
   * @param {string} ctx.reason
   * @param {number} [ctx.signalSlot]  RUG 信号触发时的 slot (仅 SELL 用)
   */
  track(sig, ctx) {
    if (!sig || this.pending.has(sig)) return;
    this.pending.set(sig, { ...ctx, startedAt: Date.now() });
    this._poll(sig);
  }

  async _poll(sig) {
    const info = this.pending.get(sig);
    if (!info) return;

    if (Date.now() - info.startedAt > MAX_WAIT_MS) {
      this.pending.delete(sig);
      log.warn(`confirm timeout ${sig.slice(0, 12)} (${info.side} ${info.mint?.slice(0, 8)})`);
      this.onConfirmed({
        sig, ok: false, error: 'confirm timeout',
        side: info.side, mint: info.mint, reason: info.reason,
        signalSlot: info.signalSlot,
      });
      return;
    }

    let tx = null;
    try {
      tx = await this.conn.getTransaction(sig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
    } catch (e) {
      // RPC 抖动, 重试
    }

    if (!tx) {
      setTimeout(() => this._poll(sig), POLL_INTERVAL_MS);
      return;
    }

    this.pending.delete(sig);

    if (tx.meta?.err) {
      log.warn(`tx onchain failed ${sig.slice(0, 12)}: ${JSON.stringify(tx.meta.err)}`);
      this.onConfirmed({
        sig, ok: false, error: `onchain err: ${JSON.stringify(tx.meta.err)}`,
        landedSlot: tx.slot,
        slotDelta: info.signalSlot != null ? tx.slot - info.signalSlot : null,
        side: info.side, mint: info.mint, reason: info.reason,
        signalSlot: info.signalSlot,
      });
      return;
    }

    const result = this._extract(tx, info);
    this.onConfirmed({
      sig, ok: true,
      side: info.side, mint: info.mint, reason: info.reason,
      signalSlot: info.signalSlot,
      ...result,
    });
  }

  /**
   * 从 confirmed tx 提取实际成交。
   *   - SOL 净流入 = postBalance[walletIdx] - preBalance[walletIdx] + fee
   *     (close wSOL ATA 把退回的 SOL 也算入了)
   *   - token 净变化 = postTokenBalances - preTokenBalances (mint=target, owner=wallet)
   */
  _extract(tx, info) {
    const meta = tx.meta;
    const message = tx.transaction.message;

    // accountKeys 处理 (兼容 legacy 和 v0)
    let accountKeys = [];
    if (message.staticAccountKeys) {
      accountKeys = message.staticAccountKeys.map(k => k.toBase58());
      // v0 还有 loaded addresses (Address Lookup Table)
      const loaded = meta.loadedAddresses;
      if (loaded?.writable) accountKeys.push(...loaded.writable.map(k =>
        typeof k === 'string' ? k : k.toBase58()));
      if (loaded?.readonly) accountKeys.push(...loaded.readonly.map(k =>
        typeof k === 'string' ? k : k.toBase58()));
    } else if (message.accountKeys) {
      accountKeys = message.accountKeys.map(k => typeof k === 'string' ? k : k.toBase58());
    }

    // wallet 在 accountKeys 里的 index (payer 一般是 0,但保险起见 search)
    let walletIdx = accountKeys.indexOf(this.walletStr);

    let actualSolLamports = 0;
    if (walletIdx >= 0 && meta.preBalances && meta.postBalances) {
      const pre = Number(meta.preBalances[walletIdx] || 0);
      const post = Number(meta.postBalances[walletIdx] || 0);
      const fee = Number(meta.fee || 0);
      // 钱包付了 fee, 所以"实际净流入" = post - pre + fee
      // BUY → 负, SELL → 正
      actualSolLamports = post - pre + fee;
    }

    // token 净变化
    let actualTokenAmount = 0n;
    const pre = meta.preTokenBalances || [];
    const post = meta.postTokenBalances || [];
    const findBal = (arr) => {
      for (const b of arr) {
        if (b.owner === this.walletStr && b.mint === info.mint) {
          return BigInt(b.uiTokenAmount?.amount || '0');
        }
      }
      return 0n;
    };
    const preTok = findBal(pre);
    const postTok = findBal(post);
    actualTokenAmount = postTok - preTok; // BUY 正, SELL 负

    const slotDelta = info.signalSlot != null ? tx.slot - info.signalSlot : null;

    return {
      actualSol: actualSolLamports / 1e9,
      actualSolLamports,
      actualToken: actualTokenAmount,
      landedSlot: tx.slot,
      slotDelta,
      blockTime: tx.blockTime,
    };
  }
}

module.exports = { ConfirmTracker };
