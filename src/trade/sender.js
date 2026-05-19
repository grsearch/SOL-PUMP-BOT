'use strict';
//
// 多通道交易广播。
//   - 同一笔已签名 tx 同时通过 Shredstream / Slipstream / Helius RPC 发送
//   - 任一返回 signature 都算成功;第一笔上链的算数
//   - 用于 RUG 紧急卖出,目标是"和 RUG 同 slot"
//

const { Connection } = require('@solana/web3.js');
const cfg = require('../config');
const log = require('../utils/logger').child('sender');

class MultiSender {
  constructor({ shredstream, slipstream }) {
    this.shredstream = shredstream;
    this.slipstream = slipstream;
    this.rpc = new Connection(cfg.helius.rpc, 'processed');
  }

  /**
   * 并发广播
   * @param {VersionedTransaction} signedTx
   * @param {object} opts
   * @param {boolean} opts.useShredstream
   * @param {boolean} opts.useSlipstream
   * @param {boolean} opts.useRpc
   * @returns {Promise<{channel:string, signature?:string, error?:string}>}
   */
  async broadcast(signedTx, opts = {}) {
    const raw = Buffer.from(signedTx.serialize());
    const tasks = [];

    if (opts.useShredstream !== false && this.shredstream?.connected) {
      tasks.push(
        this.shredstream.sendTransaction(raw)
          .then(r => ({ channel: 'shredstream', ...r }))
          .catch(e => ({ channel: 'shredstream', error: e.message }))
      );
    }
    if (opts.useSlipstream !== false && this.slipstream?.enabled) {
      tasks.push(
        this.slipstream.sendTransaction(raw)
          .then(r => ({ channel: 'slipstream', ...r }))
          .catch(e => ({ channel: 'slipstream', error: e.message }))
      );
    }
    if (opts.useRpc !== false) {
      tasks.push(
        this.rpc.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
          .then(sig => ({ channel: 'rpc', signature: sig }))
          .catch(e => ({ channel: 'rpc', error: e.message }))
      );
    }

    if (tasks.length === 0) {
      return { error: '没有可用的发送通道' };
    }

    // 注意: signature 由 tx 内容决定,不由通道决定。 多通道是冗余 (任一送达 leader 即可),
    // 这里"first ack via X"只是第一个回 ack 的通道,不代表它独家把 tx 送上链。
    return new Promise((resolve) => {
      let resolved = false;
      const all = [];
      tasks.forEach(t => {
        t.then(r => {
          all.push(r);
          if (!resolved && r.signature) {
            resolved = true;
            log.info(`first ack via ${r.channel} sig=${r.signature.slice(0, 12)}`);
            resolve({ ...r, all });
          }
          if (all.length === tasks.length && !resolved) {
            resolved = true;
            resolve({ error: '全部通道失败', all });
          }
        });
      });
    });
  }
}

module.exports = { MultiSender };
