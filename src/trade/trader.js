'use strict';
//
// 交易执行器 (v3)。
//
// v3 改动 (只为 shred 路径解析服务, 业务逻辑不动):
//   - resolvePool 时读 base mint decimals
//   - 新增 reserveCache: { mint → {baseReserve, quoteReserve, baseDecimals, updatedAt} }
//   - 后台每 1s 刷新所有监控 mint 的 vault 余额到 reserveCache
//   - 暴露同步接口 getCachedReserves(mint): 给 shredstream 解析时算 constant product 用
//

const { Connection, Keypair, PublicKey, ComputeBudgetProgram, SystemProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint } = require('@solana/spl-token');

let bs58 = require('bs58');
if (typeof bs58.decode !== 'function' && bs58.default) bs58 = bs58.default;

const cfg = require('../config');
const log = require('../utils/logger').child('trader');
const pumpAmm = require('./pumpAmm');

const GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const PROTOCOL_FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
const SHREDSTREAM_TIP_ACCOUNT = null;

class Trader {
  constructor({ sender }) {
    this.sender = sender;
    this.conn = new Connection(cfg.helius.rpc, 'confirmed');
    if (!cfg.wallet.privateKey) throw new Error('TRADER_PRIVATE_KEY 未配置');
    this.wallet = Keypair.fromSecretKey(bs58.decode(cfg.wallet.privateKey));
    log.info(`wallet: ${this.wallet.publicKey.toBase58()}`);

    this.poolCache = new Map();
    this.reserveCache = new Map(); // mint → { baseReserve, quoteReserve, baseDecimals, updatedAt }
    // v4: SOL 价格 (USD) 缓存, 30s 刷新一次
    this._solPriceUsd = 0;
    this._solPriceUpdatedAt = 0;
    this._solPriceTimer = null;
    this._cachedBlockhash = null;
    this._cachedBlockhashAt = 0;
    this._blockhashTimer = null;
    this._reserveTimer = null;
    this._startBlockhashRefresher();
    this._startReserveRefresher();
    this._startSolPriceRefresher();
  }

  _startBlockhashRefresher() {
    const refresh = async () => {
      try {
        const r = await this.conn.getLatestBlockhash('confirmed');
        this._cachedBlockhash = r.blockhash;
        this._cachedBlockhashAt = Date.now();
      } catch (e) {}
    };
    refresh();
    this._blockhashTimer = setInterval(refresh, 300);
  }

  _startReserveRefresher() {
    const refresh = async () => {
      for (const mint of this.poolCache.keys()) {
        try {
          const pi = this.poolCache.get(mint);
          const [b, q] = await Promise.all([
            this._getVaultBalance(pi.poolBaseVault, pi.baseTokenProgram),
            this._getVaultBalance(pi.poolQuoteVault, pi.quoteTokenProgram),
          ]);
          if (b != null && q != null) {
            this.reserveCache.set(mint, {
              baseReserve: b,
              quoteReserve: q,
              baseDecimals: pi.baseDecimals,
              updatedAt: Date.now(),
            });
          }
        } catch (e) {}
      }
    };
    this._reserveTimer = setInterval(refresh, 1000);
  }

  /**
   * v4: 后台拉 SOL/USD 价格 (用于 FDV/LP 链上计算).
   * 30s 刷新一次, SOL 价格短期波动小, 不需要更频繁。
   */
  _startSolPriceRefresher() {
    const refresh = async () => {
      try {
        const axios = require('axios');
        const cfg = require('../config');
        const { data } = await axios.get(`${cfg.birdeye.base}/defi/price`, {
          params: { address: cfg.pump.wsolMint },
          headers: { 'X-API-KEY': cfg.birdeye.apiKey, 'x-chain': 'solana' },
          timeout: 5000,
        });
        const v = data?.data?.value;
        if (typeof v === 'number' && v > 0) {
          this._solPriceUsd = v;
          this._solPriceUpdatedAt = Date.now();
        }
      } catch (e) { /* keep stale */ }
    };
    refresh();
    this._solPriceTimer = setInterval(refresh, 30_000);
  }

  /** 同步获取 SOL/USD 价格 (用于链上 FDV/LP 换算) */
  getSolPriceUsd() {
    return this._solPriceUsd;
  }

  stop() {
    if (this._blockhashTimer) clearInterval(this._blockhashTimer);
    if (this._reserveTimer) clearInterval(this._reserveTimer);
    if (this._solPriceTimer) clearInterval(this._solPriceTimer);
  }

  async _getBlockhash() {
    if (!this._cachedBlockhash || Date.now() - this._cachedBlockhashAt > 2000) {
      const r = await this.conn.getLatestBlockhash('confirmed');
      this._cachedBlockhash = r.blockhash;
      this._cachedBlockhashAt = Date.now();
    }
    return this._cachedBlockhash;
  }

  /** 同步获取池子 reserves (shred 路径用) */
  getCachedReserves(mint) {
    return this.reserveCache.get(mint) || null;
  }

  async resolvePool(baseMint, useCache = true) {
    if (useCache && this.poolCache.has(baseMint)) return this.poolCache.get(baseMint);
    const mintPk = new PublicKey(baseMint);
    const pool = pumpAmm.findPoolPda(mintPk);

    const poolAcc = await this.conn.getAccountInfo(pool);
    if (!poolAcc) throw new Error('pool account not found on-chain');

    const data = poolAcc.data;
    const creator = new PublicKey(data.slice(11, 43));
    const poolBaseVault = new PublicKey(data.slice(139, 171));
    const poolQuoteVault = new PublicKey(data.slice(171, 203));

    const protocolFeeRecipientWsol = getAssociatedTokenAddressSync(
      pumpAmm.WSOL_MINT, PROTOCOL_FEE_RECIPIENT, true,
    );
    const info = {
      mintPk, pool, poolBaseVault, poolQuoteVault,
      creator,
      globalConfig: GLOBAL_CONFIG,
      protocolFeeRecipient: PROTOCOL_FEE_RECIPIENT,
      protocolFeeRecipientWsol,
    };
    const [baseVaultAcc, quoteVaultAcc] = await Promise.all([
      this.conn.getAccountInfo(poolBaseVault),
      this.conn.getAccountInfo(poolQuoteVault),
    ]);
    info.baseTokenProgram = baseVaultAcc?.owner?.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()
      ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    info.quoteTokenProgram = quoteVaultAcc?.owner?.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()
      ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    // v3: 读 base mint decimals
    try {
      const mintAcc = await getMint(this.conn, mintPk, undefined, info.baseTokenProgram);
      info.baseDecimals = mintAcc.decimals;
      // v4: 读 supply (用于链上 FDV 计算)
      info.supply = BigInt(mintAcc.supply.toString());
    } catch (e) {
      info.baseDecimals = 6;
      info.supply = 0n;
    }

    this.poolCache.set(baseMint, info);

    // 立即填一次 reserves 缓存
    const [b, q] = await Promise.all([
      this._getVaultBalance(poolBaseVault, info.baseTokenProgram),
      this._getVaultBalance(poolQuoteVault, info.quoteTokenProgram),
    ]);
    if (b != null && q != null) {
      this.reserveCache.set(baseMint, {
        baseReserve: b, quoteReserve: q, baseDecimals: info.baseDecimals, updatedAt: Date.now(),
      });
    }

    log.info(`pool resolved: ${pool.toBase58()} base_vault=${poolBaseVault.toBase58().slice(0,8)} quote_vault=${poolQuoteVault.toBase58().slice(0,8)} decimals=${info.baseDecimals} supply=${info.supply}`);
    return info;
  }

  forgetPool(mint) {
    this.poolCache.delete(mint);
    this.reserveCache.delete(mint);
  }

  /**
   * v4: 从链上数据计算 FDV 和 LP (USD), 不依赖 birdeye 索引。
   *
   * 算法:
   *   price_per_token_sol = quote_reserve_sol / base_reserve_ui
   *   fdv_usd = price_per_token_sol × sol_usd × (supply_ui)
   *   lp_usd = 2 × quote_reserve_sol × sol_usd    (经典 AMM 流动性 = 双边价值, quote 侧 × 2)
   *
   * 返回 { fdv, lp, priceUsd, source: 'onchain' } 或 null (数据不全)
   */
  getOnChainFdvLp(mint) {
    const pi = this.poolCache.get(mint);
    const reserves = this.reserveCache.get(mint);
    if (!pi || !reserves) return null;
    const solUsd = this._solPriceUsd;
    if (!solUsd || solUsd <= 0) return null;
    if (reserves.baseReserve === 0n || reserves.quoteReserve === 0n) return null;
    if (!pi.supply || pi.supply === 0n) return null;

    const dec = pi.baseDecimals;
    const quoteSol = Number(reserves.quoteReserve) / 1e9;
    const baseUi = Number(reserves.baseReserve) / Math.pow(10, dec);
    const supplyUi = Number(pi.supply) / Math.pow(10, dec);

    const pricePerTokenSol = quoteSol / baseUi;
    const fdv = pricePerTokenSol * solUsd * supplyUi;
    const lp = 2 * quoteSol * solUsd;
    const priceUsd = pricePerTokenSol * solUsd;

    return { fdv, lp, priceUsd, source: 'onchain', solPriceUsd: solUsd };
  }

  async _getVaultBalance(vaultAddress, tokenProgram) {
    try {
      const acc = await getAccount(this.conn, vaultAddress, undefined, tokenProgram);
      return BigInt(acc.amount.toString());
    } catch {
      return null;
    }
  }

  async estimateBuyOut(pi, quoteInLamports) {
    const [baseRes, quoteRes] = await Promise.all([
      this._getVaultBalance(pi.poolBaseVault, pi.baseTokenProgram),
      this._getVaultBalance(pi.poolQuoteVault, pi.quoteTokenProgram),
    ]);
    if (baseRes === null || quoteRes === null) throw new Error('pool vaults not found');
    if (baseRes === 0n || quoteRes === 0n) throw new Error('pool empty');
    const k = baseRes * quoteRes;
    const newQuote = quoteRes + BigInt(quoteInLamports);
    const newBase = k / newQuote;
    return baseRes - newBase;
  }

  async estimateSellOut(pi, baseAmountIn) {
    const [baseRes, quoteRes] = await Promise.all([
      this._getVaultBalance(pi.poolBaseVault, pi.baseTokenProgram),
      this._getVaultBalance(pi.poolQuoteVault, pi.quoteTokenProgram),
    ]);
    if (baseRes === null || quoteRes === null) throw new Error('pool vaults not found');
    if (baseRes === 0n || quoteRes === 0n) throw new Error('pool empty');
    const k = baseRes * quoteRes;
    const newBase = baseRes + BigInt(baseAmountIn);
    const newQuote = k / newBase;
    return quoteRes - newQuote;
  }

  async getTokenBalance(mint) {
    const pi = this.poolCache.get(mint);
    const tokenProgram = pi?.baseTokenProgram || TOKEN_PROGRAM_ID;
    const mintPk = new PublicKey(mint);
    const ata = getAssociatedTokenAddressSync(mintPk, this.wallet.publicKey, false, tokenProgram);
    try {
      const acc = await getAccount(this.conn, ata, undefined, tokenProgram);
      return BigInt(acc.amount.toString());
    } catch {
      return 0n;
    }
  }

  async buy(mint, amountLamports = cfg.trade.buyAmountLamports) {
    const t0 = Date.now();
    const pi = await this.resolvePool(mint, false);

    const BUY_RETRIES = 5;
    const BUY_RETRY_DELAY_MS = 1000;
    let expectedOut;
    for (let attempt = 1; attempt <= BUY_RETRIES; attempt++) {
      try {
        expectedOut = await this.estimateBuyOut(pi, amountLamports);
        break;
      } catch (e) {
        if (attempt < BUY_RETRIES && (e.message.includes('not found') || e.message.includes('empty'))) {
          log.info(`buy ${mint.slice(0,8)} pool 未就绪, ${BUY_RETRY_DELAY_MS}ms 后重试 (${attempt}/${BUY_RETRIES})`);
          await new Promise(r => setTimeout(r, BUY_RETRY_DELAY_MS));
          continue;
        }
        throw e;
      }
    }
    const blockhash = await this._getBlockhash();

    const { OnlinePumpAmmSdk, PumpAmmSdk } = require('@pump-fun/pump-swap-sdk');
    const online = new OnlinePumpAmmSdk(this.conn);
    const sdk = new PumpAmmSdk();
    const slippagePercent = cfg.trade.buySlippageBps / 100;
    const BN = require('bn.js');

    const swapState = await online.swapSolanaState(pi.pool, this.wallet.publicKey);
    const buyIxs = await sdk.buyQuoteInput(swapState, new BN(amountLamports), slippagePercent);

    const ixs = [];
    ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    const priorityFeeMicro = Math.ceil((cfg.trade.buyPriorityFeeLamports * 1_000_000) / 400_000);
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicro }));
    for (const ix of buyIxs) ixs.push(ix);

    const { VersionedTransaction, TransactionMessage } = require('@solana/web3.js');
    const msg = new TransactionMessage({
      payerKey: this.wallet.publicKey, recentBlockhash: blockhash, instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([this.wallet]);

    const res = await this.sender.broadcast(tx, { useShredstream: true, useRpc: true });
    const t1 = Date.now();
    log.info(`buy ${mint.slice(0, 8)} ${amountLamports / 1e9} SOL → ${res.signature || res.error} (${t1 - t0}ms)`);
    return { ...res, expectedOut: '0', latencyMs: t1 - t0 };
  }

  async sell(mint, { isRug = false, knownBalance = null } = {}) {
    const t0 = Date.now();
    const pi = await this.resolvePool(mint, true);

    let bal;
    if (isRug && knownBalance !== null && knownBalance > 0n) {
      bal = knownBalance;
    } else {
      bal = await this.getTokenBalance(mint);
    }
    if (bal === 0n) {
      log.warn(`sell ${mint.slice(0, 8)}: 余额为 0`);
      return { error: '余额为 0' };
    }

    const expectedOut = await this.estimateSellOut(pi, bal);
    const blockhash = await this._getBlockhash();

    const priorityFee = isRug ? cfg.trade.rugPriorityFeeLamports : cfg.trade.sellPriorityFeeLamports;
    const tip = isRug ? cfg.trade.rugTipLamports : 0;
    const slippage = isRug ? cfg.trade.rugSlippageBps : cfg.trade.sellSlippageBps;

    const { OnlinePumpAmmSdk, PumpAmmSdk } = require('@pump-fun/pump-swap-sdk');
    const online = new OnlinePumpAmmSdk(this.conn);
    const sdk = new PumpAmmSdk();
    const slippagePercent = slippage / 100;
    const swapState = await online.swapSolanaState(pi.pool, this.wallet.publicKey);
    const BN = require('bn.js');
    const sellIxs = await sdk.sellBaseInput(swapState, new BN(bal.toString()), slippagePercent);

    const ixs = [];
    ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    const priorityFeeMicro = Math.ceil((priorityFee * 1_000_000) / 400_000);
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicro }));
    for (const ix of sellIxs) ixs.push(ix);
    if (tip > 0 && SHREDSTREAM_TIP_ACCOUNT) {
      ixs.push(SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey, toPubkey: new PublicKey(SHREDSTREAM_TIP_ACCOUNT), lamports: tip,
      }));
    }

    const { VersionedTransaction, TransactionMessage } = require('@solana/web3.js');
    const msg = new TransactionMessage({
      payerKey: this.wallet.publicKey, recentBlockhash: blockhash, instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([this.wallet]);

    let res = await this.sender.broadcast(tx, {
      useShredstream: true,
      useSlipstream: isRug,
      useRpc: true,
    });

    if (isRug && !res.signature) {
      log.warn(`RUG sell 第一次失败 (${res.error}), 立即重试`);
      const bh2 = await this._getBlockhash();
      const ixs2 = [];
      ixs2.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      ixs2.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.ceil((Math.floor(priorityFee * 1.5) * 1_000_000) / 400_000) }));
      const sellIxs2 = await sdk.sellBaseInput(swapState, new BN(bal.toString()), Math.min(95, slippagePercent + 10));
      for (const ix of sellIxs2) ixs2.push(ix);
      const msg2 = new TransactionMessage({
        payerKey: this.wallet.publicKey, recentBlockhash: bh2, instructions: ixs2,
      }).compileToV0Message();
      const tx2 = new VersionedTransaction(msg2);
      tx2.sign([this.wallet]);
      res = await this.sender.broadcast(tx2, {
        useShredstream: true, useSlipstream: true, useRpc: true,
      });
    }

    const t1 = Date.now();
    log.info(`sell ${mint.slice(0, 8)} ${isRug ? '🚨RUG' : ''} → ${res.signature || res.error} (${t1 - t0}ms)`);
    return { ...res, expectedOut: expectedOut.toString(), latencyMs: t1 - t0, baseAmount: bal.toString() };
  }
}

module.exports = { Trader };
