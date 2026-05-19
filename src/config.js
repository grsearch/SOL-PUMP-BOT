'use strict';
require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const str = (v, d) => (v === undefined || v === '' ? d : String(v));
const lamports = (sol) => Math.round(Number(sol) * 1e9);

const cfg = {
  port: num(process.env.PORT, 3001),
  webhookSecret: str(process.env.WEBHOOK_SECRET, ''),
  dashboard: {
    user: str(process.env.DASHBOARD_USER, 'admin'),
    pass: str(process.env.DASHBOARD_PASS, 'change_me'),
  },
  wallet: {
    privateKey: str(process.env.TRADER_PRIVATE_KEY, ''),
  },
  helius: {
    apiKey: str(process.env.HELIUS_API_KEY, ''),
    rpc: str(process.env.HELIUS_RPC, ''),
    wss: str(process.env.HELIUS_WSS, ''),
    laserstream: {
      endpoint: str(process.env.HELIUS_LASERSTREAM_ENDPOINT, ''),
      token: str(process.env.HELIUS_LASERSTREAM_TOKEN, ''),
    },
  },
  birdeye: {
    apiKey: str(process.env.BIRDEYE_API_KEY, ''),
    base: str(process.env.BIRDEYE_BASE, 'https://public-api.birdeye.so'),
  },
  shredstream: {
    endpoint: str(process.env.SHREDSTREAM_ENDPOINT, ''),
    token: str(process.env.SHREDSTREAM_AUTH_TOKEN, ''),
    tipLamports: num(process.env.SHREDSTREAM_TIP_LAMPORTS, 1_000_000),
  },
  slipstream: {
    endpoint: str(process.env.SLIPSTREAM_ENDPOINT, ''),
    apiKey: str(process.env.SLIPSTREAM_API_KEY, ''),
  },
  trade: {
    buyAmountSol: num(process.env.BUY_AMOUNT_SOL, 1),
    buyAmountLamports: lamports(num(process.env.BUY_AMOUNT_SOL, 1)),
    buyPriorityFeeLamports: lamports(num(process.env.BUY_PRIORITY_FEE_SOL, 0.0005)),
    buySlippageBps: num(process.env.BUY_SLIPPAGE_BPS, 2500),
    sellPriorityFeeLamports: lamports(num(process.env.SELL_PRIORITY_FEE_SOL, 0.0005)),
    sellSlippageBps: num(process.env.SELL_SLIPPAGE_BPS, 3000),
    rugPriorityFeeLamports: lamports(num(process.env.RUG_PRIORITY_FEE_SOL, 0.005)),
    rugTipLamports: lamports(num(process.env.RUG_TIP_SOL, 0.001)),
    rugSlippageBps: num(process.env.RUG_SLIPPAGE_BPS, 9000),
  },
  kline: {
    intervalSec: num(process.env.KLINE_INTERVAL_SEC, 15),
    pollSec: num(process.env.PRICE_POLL_SEC, 1),
    emaFast: num(process.env.EMA_FAST, 9),
    emaSlow: num(process.env.EMA_SLOW, 20),
    warmupBars: num(process.env.EMA_WARMUP_BARS, 2),
  },
  trailing: {
    activatePct: num(process.env.TRAILING_ACTIVATE_PCT, 200),
    drawdownPct: num(process.env.TRAILING_DRAWDOWN_PCT, 20),
  },
  monitor: {
    minFdv: num(process.env.MONITOR_MIN_FDV, 30_000),
    minLp: num(process.env.MONITOR_MIN_LP, 10_000),
  },
  rug: {
    minSells: num(process.env.RUG_SAME_SLOT_MIN_SELLS, 5),
    minSolTotal: num(process.env.RUG_SAME_SLOT_MIN_SOL, 5),
    gasToleranceLamports: num(process.env.RUG_GAS_TOLERANCE_LAMPORTS, 1000),
    slotWindow: num(process.env.RUG_SLOT_WINDOW, 1),
  },
  pump: {
    pumpFunProgram: str(process.env.PUMP_FUN_PROGRAM, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
    pumpAmmProgram: str(process.env.PUMP_AMM_PROGRAM, 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'),
    wsolMint: str(process.env.WSOL_MINT, 'So11111111111111111111111111111111111111112'),
  },
  logLevel: str(process.env.LOG_LEVEL, 'info'),
};

module.exports = cfg;
