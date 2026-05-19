'use strict';
//
// Dashboard 实时推送 hub。 strategy/trader 调 broadcast() 即可,
// 所有连接的浏览器都会收到。
// ws upgrade 时验 basic auth, 防止公网暴露被监听 RUG 信号。
//

const WebSocket = require('ws');
const cfg = require('../config');
const log = require('../utils/logger').child('ws');

class WsHub {
  constructor() {
    this.wss = null;
    this.clients = new Set();
  }

  attach(server) {
    this.wss = new WebSocket.Server({
      server, path: '/ws',
      verifyClient: (info) => {
        const auth = info.req.headers['authorization'] || '';
        if (!auth.startsWith('Basic ')) return false;
        try {
          const decoded = Buffer.from(auth.slice(6), 'base64').toString();
          const [u, p] = decoded.split(':');
          return u === cfg.dashboard.user && p === cfg.dashboard.pass;
        } catch {
          return false;
        }
      },
    });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      log.info(`client connected (total=${this.clients.size})`);
      ws.on('close', () => {
        this.clients.delete(ws);
        log.info(`client disconnected (total=${this.clients.size})`);
      });
    });
  }

  broadcast(msg) {
    // BigInt 不能默认 JSON.stringify,统一转字符串
    const data = JSON.stringify(msg, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }
}

module.exports = { WsHub };
