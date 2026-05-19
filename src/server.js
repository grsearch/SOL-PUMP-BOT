'use strict';
const express = require('express');
const basicAuth = require('express-basic-auth');
const path = require('path');
const cfg = require('./config');
const log = require('./utils/logger').child('server');
const tradeDb = require('./pnl/tradeDb');

function makeServer({ strategy, wsHub }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/webhook/add-token', async (req, res) => {
    if (cfg.webhookSecret) {
      const got = req.headers['x-webhook-secret'];
      if (got !== cfg.webhookSecret) {
        return res.status(401).json({ error: 'invalid secret' });
      }
    }
    const { network, address, symbol, fdv, lp } = req.body || {};
    if (network !== 'solana' || !address) {
      return res.status(400).json({ error: 'invalid payload' });
    }
    // v4: 把 pumpmonitor 传的 fdv/lp 一起传过去 (链上数据可用时会优先用链上)
    const payload = {};
    if (typeof fdv === 'number' && fdv > 0) payload.fdv = fdv;
    if (typeof lp === 'number' && lp > 0) payload.lp = lp;
    strategy.onWebhookAdd(address, symbol || '', payload)
      .catch(e => log.error(`webhook handler err: ${e.message}`));
    res.json({ ok: true });
  });

  const auth = basicAuth({
    users: { [cfg.dashboard.user]: cfg.dashboard.pass },
    challenge: true,
    realm: 'sol-pump-bot',
  });

  app.use('/api', auth);
  app.use('/', auth, express.static(path.resolve(__dirname, '../public')));

  const safeJson = (obj) => JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  const sendJson = (res, obj) => res.type('application/json').send(safeJson(obj));

  app.get('/api/tokens', (req, res) => sendJson(res, strategy.snapshot()));

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

  // 原始交易记录 (按时间, 不分组)
  app.get('/api/trades', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    res.json(tradeDb.recent(limit));
  });

  // v3 新增: 按 mint 配对的交易记录 (BUY + SELL 合并成一行)
  // 每一行代表"一次完整的买卖" 或 "买入但还没卖"
  app.get('/api/trades-paired', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    // 从 db 拿足够多的原始行 — 因为一次完整交易至少 2 行 (BUY+SELL), 拿 limit * 3 留余
    const all = tradeDb.recent(limit * 4);
    // 按 mint + ts 顺序分组
    // 假设: 同一个 mint 只交易一次 (我们的策略限制), 所以同 mint 的 BUY/SELL/SELL_FAILED 就是同一笔
    const byMint = new Map();
    for (const t of all) {
      if (!byMint.has(t.mint)) byMint.set(t.mint, { buy: null, sell: null, fails: [] });
      const g = byMint.get(t.mint);
      if (t.side === 'BUY') {
        // 取最早的 BUY
        if (!g.buy || t.ts < g.buy.ts) g.buy = t;
      } else if (t.side === 'SELL') {
        // 取最新的成功 SELL
        if (!g.sell || t.ts > g.sell.ts) g.sell = t;
      } else if (t.side === 'SELL_FAILED') {
        g.fails.push(t);
      }
    }

    const paired = [];
    for (const [mint, g] of byMint) {
      const buy = g.buy;
      const sell = g.sell;
      const lastFail = g.fails.length > 0 ? g.fails[g.fails.length - 1] : null;
      if (!buy && !sell) continue;

      const row = {
        mint,
        symbol: buy?.symbol || sell?.symbol || '???',
        // BUY
        buyTs: buy?.ts ?? null,
        buyAmountSol: buy?.sol_amount_actual ?? buy?.sol_amount ?? null,
        buyPriceUsd: buy?.price_usd ?? null,
        buyTxSig: buy?.tx_sig ?? null,
        buyLatencyMs: buy?.latency_ms ?? null,
        buyLandedSlot: buy?.landed_slot ?? null,
        buyStatus: buy?.status ?? null,
        // SELL
        sellTs: sell?.ts ?? null,
        sellAmountSol: sell?.sol_amount_actual ?? sell?.sol_amount ?? null,
        sellPriceUsd: sell?.price_usd ?? null,
        sellTxSig: sell?.tx_sig ?? null,
        sellLatencyMs: sell?.latency_ms ?? null,
        sellReason: sell?.reason ?? null,
        sellLandedSlot: sell?.landed_slot ?? null,
        sellSignalSlot: sell?.signal_slot ?? null,
        sellSlotDelta: sell?.slot_delta ?? null,
        sellStatus: sell?.status ?? null,
        // PnL
        pnlSol: sell?.pnl_sol_actual ?? sell?.pnl_sol ?? null,
        // 当前状态
        state: !buy ? 'NO_BUY'
             : !sell && lastFail ? 'SELL_FAILED'
             : !sell ? 'HOLDING'
             : sell.status === 'CONFIRMED' ? 'CLOSED'
             : 'SELL_PENDING',
        lastFailReason: lastFail?.reason || null,
        lastFailError: lastFail ? safeParseRaw(lastFail.raw)?.error : null,
      };
      paired.push(row);
    }
    // 按 BUY 时间倒序 (最近的在上)
    paired.sort((a, b) => (b.buyTs || b.sellTs || 0) - (a.buyTs || a.sellTs || 0));
    sendJson(res, paired.slice(0, limit));
  });

  app.get('/api/pnl', (req, res) => {
    res.json({ pnl24hSol: tradeDb.pnl24h() });
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  return app;
}

function safeParseRaw(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

module.exports = { makeServer };
