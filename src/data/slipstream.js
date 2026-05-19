'use strict';
//
// Slipstream (allenhark.com) 客户端 — 仅用于卖出广播。
// 卖出时,我们把同一笔 tx 同时通过 Shredstream 和 Slipstream 广播,
// 谁先被 leader 打包谁有效。
//
// 占位实现: 默认走 HTTP /sendTransaction (base64 编码 tx)
// 实际 endpoint 与字段以 allenhark 文档为准。
//

const axios = require('axios');
const cfg = require('../config');
const log = require('../utils/logger').child('slipstream');

class SlipstreamClient {
  constructor() {
    if (!cfg.slipstream.endpoint || !cfg.slipstream.apiKey) {
      log.warn('slipstream 未配置');
      this.enabled = false;
      return;
    }
    this.enabled = true;
    this.http = axios.create({
      baseURL: cfg.slipstream.endpoint,
      timeout: 5000,
      headers: {
        'authorization': `Bearer ${cfg.slipstream.apiKey}`,
        'content-type': 'application/json',
      },
    });
  }

  /**
   * 广播一笔已签名 tx
   * @param {Buffer} rawTx
   * @returns {Promise<{signature?:string, error?:string}>}
   */
  async sendTransaction(rawTx) {
    if (!this.enabled) return { error: 'disabled' };
    try {
      const { data } = await this.http.post('/sendTransaction', {
        transaction: rawTx.toString('base64'),
        encoding: 'base64',
        skipPreflight: true,
      });
      return data;
    } catch (e) {
      return { error: e.message };
    }
  }
}

module.exports = { SlipstreamClient };
