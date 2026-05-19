'use strict';
const express = require('express');
const basicAuth = require('express-basic-auth');
const path = require('path');
const cfg = require('../config');
const log = require('../utils/logger').child('server');
const tradeDb = require('../pnl/tradeDb');

function makeServer({ strategy, wsHub }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // webhook endpoint (用 WEBHOOK_SECRET header 鉴权,防止公网暴露被恶意触发)
  app.post('/webhook/add-token', async (req, res) => {
    if (cfg.webhookSecret) {
      const got = req.headers['x-webhook-secret'];
      if (got !== cfg.webhookSecret) {
        return res.status(401).json({ error: 'invalid secret' });
      }
    }
    const { network, address, symbol } = req.body || {};
    if (network !== 'solana' || !address) {
      return res.status(400).json({ error: 'invalid payload' });
    }
    // 不 await, 立即返回 200 给 pumpmoniter
    strategy.onWebhookAdd(address, symbol || '').catch(e => log.error(`webhook handler err: ${e.message}`));
    res.json({ ok: true });
  });

  // ─── 以下接口走 basic auth ─────────────────────
  const auth = basicAuth({
    users: { [cfg.dashboard.user]: cfg.dashboard.pass },
    challenge: true,
    realm: 'sol-pump-bot',
  });

  app.use('/api', auth);
  app.use('/', auth, express.static(path.resolve(__dirname, '../../public')));

  const safeJson = (obj) => JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  const sendJson = (res, obj) => res.type('application/json').send(safeJson(obj));

  app.get('/api/tokens', (req, res) => {
    sendJson(res, strategy.snapshot());
  });

  app.post('/api/tokens', async (req, res) => {
    const { mint, symbol } = req.body || {};
    if (!mint) return res.status(400).json({ error: 'mint required' });
    strategy.onWebhookAdd(mint, symbol || '');
    res.json({ ok: true });
  });

  app.delete('/api/tokens/:mint', (req, res) => {
    strategy._cleanup(req.params.mint);
    res.json({ ok: true });
  });

  app.get('/api/trades', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    res.json(tradeDb.recent(limit));
  });

  app.get('/api/pnl', (req, res) => {
    res.json({ pnl24hSol: tradeDb.pnl24h() });
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  return app;
}

module.exports = { makeServer };
