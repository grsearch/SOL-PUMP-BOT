'use strict';
//
// 交易记录持久化 (sqlite)。
//
// 生命周期:
//   1. broadcast 拿到 signature 后, record() 立即写一行 (status=PENDING, 含预估字段)
//   2. confirmTracker 后台 confirm tx, 拿到实际 slot + balance diff, 调 updateOnConfirm() 回填
//
// 关键字段:
//   - sol_amount         即时写入的预估值
//   - sol_amount_actual  confirm 后回填,真实成交 SOL
//   - token_amount       预估值
//   - token_amount_actual  实际 token 数 (BigInt string)
//   - pnl_sol            初始为预估 PnL, confirm 后用 actual 重算覆盖
//   - signal_slot        触发卖出信号时的 slot (仅 SELL 行)
//   - landed_slot        tx 实际上链 slot
//   - slot_delta         landed_slot - signal_slot (RUG 卖出关注的核心指标)
//   - status             PENDING / CONFIRMED / FAILED
//
// 24h PnL = SUM(SELL.pnl_sol WHERE status='CONFIRMED')
//
// 兼容性: ALTER TABLE ADD COLUMN 让老 db 文件也能用。
//

const path = require('path');
const fs = require('fs');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn('[tradeDb] better-sqlite3 unavailable, using in-memory fallback');
  Database = null;
}

const DB_PATH = path.resolve(__dirname, '../../data/trades.db');

let _db = null;
let _memTrades = [];
let _memSeq = 0;

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
      side TEXT NOT NULL,
      reason TEXT,
      sol_amount REAL,
      token_amount TEXT,
      price_usd REAL,
      tx_sig TEXT,
      latency_ms INTEGER,
      channel TEXT,
      pnl_sol REAL,
      raw TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
    CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
    CREATE INDEX IF NOT EXISTS idx_trades_sig ON trades(tx_sig);

    -- v4: 持仓持久化表 (重启时从这里恢复 token store)
    CREATE TABLE IF NOT EXISTS positions (
      mint TEXT PRIMARY KEY,
      symbol TEXT,
      state TEXT,                 -- HOLDING / SELLING / CLOSED
      added_at INTEGER,
      buy_at INTEGER,
      buy_tx_sig TEXT,
      buy_amount_lamports INTEGER,
      buy_price_usd REAL,
      peak_price_usd REAL,
      token_balance TEXT,         -- BigInt as string
      pool_address TEXT,
      pool_base_vault TEXT,
      pool_quote_vault TEXT,
      base_decimals INTEGER,
      trailing_activated INTEGER DEFAULT 0,
      bars_since_buy INTEGER DEFAULT 0,
      updated_at INTEGER
    );
  `);

  // 老 db 迁移
  const cols = new Set(_db.prepare("PRAGMA table_info(trades)").all().map(r => r.name));
  const addCol = (name, type) => {
    if (!cols.has(name)) {
      try { _db.exec(`ALTER TABLE trades ADD COLUMN ${name} ${type}`); } catch (e) {}
    }
  };
  addCol('sol_amount_actual', 'REAL');
  addCol('token_amount_actual', 'TEXT');
  addCol('pnl_sol_actual', 'REAL');
  addCol('signal_slot', 'INTEGER');
  addCol('landed_slot', 'INTEGER');
  addCol('slot_delta', 'INTEGER');
  addCol('status', "TEXT DEFAULT 'PENDING'");
  addCol('confirmed_at', 'INTEGER');

  try { _db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)`); } catch (e) {}
  try { _db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_state ON positions(state)`); } catch (e) {}
}

// ─── v4: positions 表的 CRUD ────────────────────────────
const _memPositions = new Map();

function savePosition(p) {
  const row = {
    mint: p.mint,
    symbol: p.symbol || '',
    state: p.state,
    added_at: p.addedAt ?? null,
    buy_at: p.buyAt ?? null,
    buy_tx_sig: p.buyTxSig ?? null,
    buy_amount_lamports: p.buyAmountLamports ?? null,
    buy_price_usd: p.buyPriceUsd ?? null,
    peak_price_usd: p.peakPriceUsd ?? null,
    token_balance: p.tokenBalance != null ? String(p.tokenBalance) : null,
    pool_address: p.poolAddress ?? null,
    pool_base_vault: p.poolBaseVault ?? null,
    pool_quote_vault: p.poolQuoteVault ?? null,
    base_decimals: p.baseDecimals ?? null,
    trailing_activated: p.trailingActivated ? 1 : 0,
    bars_since_buy: p.barsSinceBuy || 0,
    updated_at: Date.now(),
  };
  if (_db) {
    _db.prepare(`
      INSERT INTO positions (
        mint, symbol, state, added_at, buy_at, buy_tx_sig, buy_amount_lamports,
        buy_price_usd, peak_price_usd, token_balance, pool_address,
        pool_base_vault, pool_quote_vault, base_decimals,
        trailing_activated, bars_since_buy, updated_at
      ) VALUES (
        @mint, @symbol, @state, @added_at, @buy_at, @buy_tx_sig, @buy_amount_lamports,
        @buy_price_usd, @peak_price_usd, @token_balance, @pool_address,
        @pool_base_vault, @pool_quote_vault, @base_decimals,
        @trailing_activated, @bars_since_buy, @updated_at
      )
      ON CONFLICT(mint) DO UPDATE SET
        symbol = excluded.symbol,
        state = excluded.state,
        buy_at = excluded.buy_at,
        buy_tx_sig = excluded.buy_tx_sig,
        buy_amount_lamports = excluded.buy_amount_lamports,
        buy_price_usd = excluded.buy_price_usd,
        peak_price_usd = excluded.peak_price_usd,
        token_balance = excluded.token_balance,
        pool_address = excluded.pool_address,
        pool_base_vault = excluded.pool_base_vault,
        pool_quote_vault = excluded.pool_quote_vault,
        base_decimals = excluded.base_decimals,
        trailing_activated = excluded.trailing_activated,
        bars_since_buy = excluded.bars_since_buy,
        updated_at = excluded.updated_at
    `).run(row);
  } else {
    _memPositions.set(p.mint, row);
  }
}

function deletePosition(mint) {
  if (_db) _db.prepare('DELETE FROM positions WHERE mint = ?').run(mint);
  else _memPositions.delete(mint);
}

/** 启动时调用: 拿所有未结束的持仓 (HOLDING / SELLING) */
function loadActivePositions() {
  if (_db) return _db.prepare(`SELECT * FROM positions WHERE state IN ('HOLDING', 'SELLING')`).all();
  return Array.from(_memPositions.values()).filter(p => p.state === 'HOLDING' || p.state === 'SELLING');
}

/**
 * 即时记录一笔
 * @returns {number} 行 id
 */
function record(row) {
  const r = {
    ts: row.ts || Date.now(),
    mint: row.mint,
    symbol: row.symbol || '',
    side: row.side,
    reason: row.reason || '',
    sol_amount: row.solAmount ?? null,
    token_amount: row.tokenAmount != null ? String(row.tokenAmount) : null,
    price_usd: row.priceUsd ?? null,
    tx_sig: row.txSig || null,
    latency_ms: row.latencyMs ?? null,
    channel: row.channel || null,
    pnl_sol: row.pnlSol ?? null,
    signal_slot: row.signalSlot ?? null,
    status: row.status || (row.txSig ? 'PENDING' : 'FAILED'),
    raw: row.raw ? JSON.stringify(row.raw) : null,
  };
  if (_db) {
    const info = _db.prepare(`
      INSERT INTO trades
        (ts,mint,symbol,side,reason,sol_amount,token_amount,price_usd,tx_sig,latency_ms,channel,pnl_sol,signal_slot,status,raw)
      VALUES
        (@ts,@mint,@symbol,@side,@reason,@sol_amount,@token_amount,@price_usd,@tx_sig,@latency_ms,@channel,@pnl_sol,@signal_slot,@status,@raw)
    `).run(r);
    return info.lastInsertRowid;
  } else {
    const id = ++_memSeq;
    _memTrades.push({ id, ...r });
    return id;
  }
}

function findBySig(sig) {
  if (!sig) return null;
  if (_db) {
    return _db.prepare('SELECT * FROM trades WHERE tx_sig = ? ORDER BY id DESC LIMIT 1').get(sig);
  }
  for (let i = _memTrades.length - 1; i >= 0; i--) {
    if (_memTrades[i].tx_sig === sig) return _memTrades[i];
  }
  return null;
}

/**
 * confirm 后回填实际值
 * @param {string} sig
 * @param {object} update
 *   - actualSol         实际 SOL (BUY 为负, SELL 为正)
 *   - actualToken       实际 token (BigInt or string)
 *   - landedSlot
 *   - actualPnlSol      实际 PnL (仅 SELL)
 *   - status            'CONFIRMED' / 'FAILED'
 */
function updateOnConfirm(sig, update) {
  if (!sig) return;
  const row = findBySig(sig);
  if (!row) return;

  const slotDelta = (update.landedSlot != null && row.signal_slot != null)
    ? update.landedSlot - row.signal_slot
    : (update.slotDelta ?? null);

  const fields = {
    sol_amount_actual: update.actualSol ?? null,
    token_amount_actual: update.actualToken != null ? String(update.actualToken) : null,
    pnl_sol_actual: update.actualPnlSol ?? null,
    pnl_sol: update.actualPnlSol != null ? update.actualPnlSol : row.pnl_sol,
    landed_slot: update.landedSlot ?? row.landed_slot,
    slot_delta: slotDelta,
    status: update.status || 'CONFIRMED',
    confirmed_at: Date.now(),
  };
  if (_db) {
    _db.prepare(`
      UPDATE trades SET
        sol_amount_actual = @sol_amount_actual,
        token_amount_actual = @token_amount_actual,
        pnl_sol_actual = @pnl_sol_actual,
        pnl_sol = @pnl_sol,
        landed_slot = @landed_slot,
        slot_delta = @slot_delta,
        status = @status,
        confirmed_at = @confirmed_at
      WHERE tx_sig = @sig
    `).run({ ...fields, sig });
  } else {
    const idx = _memTrades.findIndex(t => t.tx_sig === sig);
    if (idx >= 0) _memTrades[idx] = { ..._memTrades[idx], ...fields };
  }
}

function recent(limit = 100) {
  if (_db) {
    return _db.prepare('SELECT * FROM trades ORDER BY ts DESC LIMIT ?').all(limit);
  }
  return _memTrades.slice(-limit).reverse();
}

/** 24h PnL: 仅 CONFIRMED 的 SELL 行 (pnl_sol 已用 actual 覆盖) */
function pnl24h() {
  const since = Date.now() - 24 * 3600 * 1000;
  if (_db) {
    const r = _db.prepare(`
      SELECT COALESCE(SUM(pnl_sol),0) AS s
      FROM trades
      WHERE ts >= ? AND side = 'SELL' AND status = 'CONFIRMED'
    `).get(since);
    return r.s || 0;
  }
  return _memTrades
    .filter(t => t.ts >= since && t.side === 'SELL' && t.status === 'CONFIRMED')
    .reduce((a, t) => a + (t.pnl_sol || 0), 0);
}

function pnlByMint(mint) {
  if (_db) {
    const r = _db.prepare(`
      SELECT COALESCE(SUM(pnl_sol),0) AS s
      FROM trades
      WHERE mint = ? AND status = 'CONFIRMED'
    `).get(mint);
    return r.s || 0;
  }
  return _memTrades
    .filter(t => t.mint === mint && t.status === 'CONFIRMED')
    .reduce((a, t) => a + (t.pnl_sol || 0), 0);
}

function pendingSells() {
  if (_db) {
    return _db.prepare(
      `SELECT * FROM trades WHERE status = 'PENDING' AND tx_sig IS NOT NULL`
    ).all();
  }
  return _memTrades.filter(t => t.status === 'PENDING' && t.tx_sig);
}

init();

module.exports = {
  record, updateOnConfirm, recent, pnl24h, pnlByMint, findBySig, pendingSells,
  // v4: positions 持久化
  savePosition, deletePosition, loadActivePositions,
};
