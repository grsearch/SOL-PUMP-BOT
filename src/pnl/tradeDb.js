'use strict';
//
// 交易记录持久化 (sqlite)。
// 每次买/卖都写一行。 dashboard PnL 直接 SQL 聚合。
//

const path = require('path');
const fs = require('fs');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  // 在 npm install 失败的环境提供 in-memory fallback,避免整个 app 起不来
  console.warn('[tradeDb] better-sqlite3 unavailable, using in-memory fallback');
  Database = null;
}

const DB_PATH = path.resolve(__dirname, '../../data/trades.db');

let _db = null;
let _memTrades = []; // fallback

function init() {
  if (!Database) return;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      mint TEXT NOT NULL,
      symbol TEXT,
      side TEXT NOT NULL,          -- BUY / SELL
      reason TEXT,                 -- MIGRATE / EMA_CROSS / TRAILING / RUG / MANUAL
      sol_amount REAL,             -- SOL 流向 (买入为负,卖出为正)
      token_amount TEXT,           -- big int as string
      price_usd REAL,
      tx_sig TEXT,
      latency_ms INTEGER,
      channel TEXT,                -- shredstream / slipstream / rpc
      pnl_sol REAL,                -- 仅 SELL 行: 该 trade 的盈亏
      raw TEXT                     -- json 额外字段
    );
    CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
    CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
  `);
}

function record(row) {
  const r = {
    ts: row.ts || Date.now(),
    mint: row.mint,
    symbol: row.symbol || '',
    side: row.side,
    reason: row.reason || '',
    sol_amount: row.solAmount ?? null,
    token_amount: row.tokenAmount ? String(row.tokenAmount) : null,
    price_usd: row.priceUsd ?? null,
    tx_sig: row.txSig || null,
    latency_ms: row.latencyMs ?? null,
    channel: row.channel || null,
    pnl_sol: row.pnlSol ?? null,
    raw: row.raw ? JSON.stringify(row.raw) : null,
  };
  if (_db) {
    _db.prepare(`
      INSERT INTO trades (ts,mint,symbol,side,reason,sol_amount,token_amount,price_usd,tx_sig,latency_ms,channel,pnl_sol,raw)
      VALUES (@ts,@mint,@symbol,@side,@reason,@sol_amount,@token_amount,@price_usd,@tx_sig,@latency_ms,@channel,@pnl_sol,@raw)
    `).run(r);
  } else {
    _memTrades.push({ id: _memTrades.length + 1, ...r });
  }
}

function recent(limit = 100) {
  if (_db) {
    return _db.prepare('SELECT * FROM trades ORDER BY ts DESC LIMIT ?').all(limit);
  }
  return _memTrades.slice(-limit).reverse();
}

function pnl24h() {
  const since = Date.now() - 24 * 3600 * 1000;
  if (_db) {
    const r = _db.prepare('SELECT COALESCE(SUM(pnl_sol),0) AS s FROM trades WHERE ts >= ? AND side = ?').get(since, 'SELL');
    return r.s || 0;
  }
  return _memTrades.filter(t => t.ts >= since && t.side === 'SELL')
    .reduce((a, t) => a + (t.pnl_sol || 0), 0);
}

function pnlByMint(mint) {
  if (_db) {
    const r = _db.prepare('SELECT COALESCE(SUM(pnl_sol),0) AS s FROM trades WHERE mint = ?').get(mint);
    return r.s || 0;
  }
  return _memTrades.filter(t => t.mint === mint)
    .reduce((a, t) => a + (t.pnl_sol || 0), 0);
}

init();

module.exports = { record, recent, pnl24h, pnlByMint };
