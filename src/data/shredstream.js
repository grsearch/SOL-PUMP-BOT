'use strict';
//
// Shredstream 客户端 (法兰克福区)
// https://docs.shredstream.com/zh
//
// Shredstream 提供的是 leader 还没把 block 完全打包前的 shred 级别数据,
// 比 RPC 的 processed commitment 还要早几十-上百毫秒。
//
// 数据用途:
//   1. 监控目标 mint 的 incoming transactions (用于 RUG 检测)
//   2. 卖出时把交易广播到 shredstream tip account 以让 leader 立即打包
//
// 详细 proto 与 endpoint 鉴权方式请参考 docs.shredstream.com/zh。
// 这里给出统一接口,实际部署时替换为官方 SDK 即可。
//

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const cfg = require('../config');
const log = require('../utils/logger').child('shredstream');

class ShredstreamClient {
  constructor({ onSell }) {
    this.onSell = onSell;
    this.client = null;
    this.stream = null;
    this.watchedMints = new Set();
    this.connected = false;
  }

  async connect() {
    if (this.connected) return;
    if (!cfg.shredstream.endpoint || !cfg.shredstream.token) {
      log.warn('shredstream 未配置, 跳过');
      return;
    }
    const protoPath = path.resolve(__dirname, '../proto/shredstream.proto');
    let pkgDef;
    try {
      pkgDef = protoLoader.loadSync(protoPath, {
        keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
      });
    } catch (e) {
      log.error(`proto load failed: ${e.message}`);
      log.error('请将官方 shredstream.proto 放到 src/proto/');
      return;
    }

    const grpcObj = grpc.loadPackageDefinition(pkgDef);
    const Svc = grpcObj.shredstream?.Shredstream || grpcObj.Shredstream;
    if (!Svc) {
      log.error('proto 未找到 Shredstream service');
      return;
    }

    const creds = grpc.credentials.combineChannelCredentials(
      grpc.credentials.createSsl(),
      grpc.credentials.createFromMetadataGenerator((_, cb) => {
        const meta = new grpc.Metadata();
        meta.add('authorization', `Bearer ${cfg.shredstream.token}`);
        cb(null, meta);
      }),
    );
    this.client = new Svc(cfg.shredstream.endpoint, creds);
    this.stream = this.client.SubscribeTransactions();

    this.stream.on('data', (msg) => this._onTx(msg));
    this.stream.on('error', (e) => log.error(`stream err: ${e.message}`));
    this.stream.on('end', () => {
      log.warn('stream ended, reconnect in 3s');
      this.connected = false;
      setTimeout(() => this.connect(), 3000);
    });
    this.connected = true;
    log.info(`connected to ${cfg.shredstream.endpoint}`);
    this._resync();
  }

  _resync() {
    if (!this.stream || this.watchedMints.size === 0) return;
    this.stream.write({
      account_include: Array.from(this.watchedMints),
      program_include: [cfg.pump.pumpAmmProgram],
    });
  }

  watch(mint) {
    if (this.watchedMints.has(mint)) return;
    this.watchedMints.add(mint);
    this._resync();
  }
  unwatch(mint) {
    if (this.watchedMints.delete(mint)) this._resync();
  }

  _onTx(msg) {
    // shredstream 推送格式由 proto 决定; 解析后调用 onSell
    // 占位: 期望 msg = { slot, signature, owner, mint, solAmount, priorityFeeLamports }
    try {
      if (!msg.mint || !msg.owner) return;
      this.onSell({
        mint: msg.mint,
        signature: msg.signature,
        slot: Number(msg.slot),
        owner: msg.owner,
        solAmount: Number(msg.solAmount || 0),
        priorityFeeLamports: Number(msg.priorityFeeLamports || 0),
        ts: Date.now(),
      });
    } catch (e) {
      log.debug(`parse err: ${e.message}`);
    }
  }

  /**
   * 把已签名 tx 通过 shredstream 高速广播
   * @param {Buffer} rawTx
   */
  async sendTransaction(rawTx) {
    if (!this.client) throw new Error('shredstream not connected');
    return new Promise((resolve, reject) => {
      this.client.SendTransaction({ data: rawTx }, (err, res) => {
        if (err) return reject(err);
        resolve(res);
      });
    });
  }
}

module.exports = { ShredstreamClient };
