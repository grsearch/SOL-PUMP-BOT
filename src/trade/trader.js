'use strict';
//
// 交易执行器 (高层封装)。
//
// 关键: RUG 卖出延迟优化
//   - blockhash 后台每 300ms 拉一次,sell 直接读缓存 (省 ~150ms)
//   - pool info 在买入时已缓存,sell 不重新解析 (省 ~50ms)
//   - RUG 失败立即重试一次,带更大滑点 + 更高优先费
//

const { Connection, Keypair, PublicKey, ComputeBudgetProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, getAccount } = require('@solana/spl-token');

// bs58 v6 是 ESM,在 CJS 中 .decode 在 .default 上;v5 直接在顶层。两种都兼容:
let bs58 = require('bs58');
if (typeof bs58.decode !== 'function' && bs58.default) bs58 = bs58.default;

const cfg = require('../config');
const log = require('../utils/logger').child('trader');
const pumpAmm = require('./pumpAmm');

// pump-amm 全局账户 (mainnet)
// ⚠️ 占位地址!部署前请用本地 @pump-fun/pump-swap-sdk 校验
const GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const PROTOCOL_FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
const SHREDSTREAM_TIP_ACCOUNT = null; // 由 shredstream 文档提供后填

class Trader {
  constructor({ sender }) {
    this.sender = sender;
    // commitment 'processed' 可能被 fork → 用 'confirmed',稳定性优先
    this.conn = new Connection(cfg.helius.rpc, 'confirmed');
    if (!cfg.wallet.privateKey) throw new Error('TRADER_PRIVATE_KEY 未配置');
    this.wallet = Keypair.fromSecretKey(bs58.decode(cfg.wallet.privateKey));
    log.info(`wallet: ${this.wallet.publicKey.toBase58()}`);

    this.poolCache = new Map(); // mint → poolInfo
    this._cachedBlockhash = null;
    this._cachedBlockhashAt = 0;
    this._blockhashTimer = null;
    this._startBlockhashRefresher();
  }

  _startBlockhashRefresher() {
    const refresh = async () => {
      try {
        const r = await this.conn.getLatestBlockhash('confirmed');
        this._cachedBlockhash = r.blockhash;
        this._cachedBlockhashAt = Date.now();
      } catch (e) {
        // 保留旧值,下次再试
      }
    };
    refresh();
    this._blockhashTimer = setInterval(refresh, 300);
  }

  stop() {
    if (this._blockhashTimer) clearInterval(this._blockhashTimer);
  }

  async _getBlockhash() {
    if (!this._cachedBlockhash || Date.now() - this._cachedBlockhashAt > 2000) {
      const r = await this.conn.getLatestBlockhash('confirmed');
      this._cachedBlockhash = r.blockhash;
      this._cachedBlockhashAt = Date.now();
    }
    return this._cachedBlockhash;
  }

  async resolvePool(baseMint, useCache = true) {
    if (useCache && this.poolCache.has(baseMint)) return this.poolCache.get(baseMint);
    const mintPk = new PublicKey(baseMint);
    const pool = pumpAmm.findPoolPda(mintPk);
    const poolBaseVault = getAssociatedTokenAddressSync(mintPk, pool, true);
    const poolQuoteVault = getAssociatedTokenAddressSync(pumpAmm.WSOL_MINT, pool, true);
    const protocolFeeRecipientWsol = getAssociatedTokenAddressSync(
      pumpAmm.WSOL_MINT, PROTOCOL_FEE_RECIPIENT, true,
    );
    const info = {
      mintPk, pool, poolBaseVault, poolQuoteVault,
      globalConfig: GLOBAL_CONFIG,
      protocolFeeRecipient: PROTOCOL_FEE_RECIPIENT,
      protocolFeeRecipientWsol,
    };
    this.poolCache.set(baseMint, info);
    return info;
  }

  forgetPool(mint) { this.poolCache.delete(mint); }

  // 估算 (恒定乘积, 未扣手续费, 配合 slippage buffer 一般 OK)
  async estimateBuyOut(pi, quoteInLamports) {
    const [baseAcc, quoteAcc] = await Promise.all([
      getAccount(this.conn, pi.poolBaseVault).catch(() => null),
      getAccount(this.conn, pi.poolQuoteVault).catch(() => null),
    ]);
    if (!baseAcc || !quoteAcc) throw new Error('pool vaults not found');
    const baseRes = BigInt(baseAcc.amount.toString());
    const quoteRes = BigInt(quoteAcc.amount.toString());
    if (baseRes === 0n || quoteRes === 0n) throw new Error('pool empty');
    const k = baseRes * quoteRes;
    const newQuote = quoteRes + BigInt(quoteInLamports);
    const newBase = k / newQuote;
    return baseRes - newBase;
  }

  async estimateSellOut(pi, baseAmountIn) {
    const [baseAcc, quoteAcc] = await Promise.all([
      getAccount(this.conn, pi.poolBaseVault).catch(() => null),
      getAccount(this.conn, pi.poolQuoteVault).catch(() => null),
    ]);
    if (!baseAcc || !quoteAcc) throw new Error('pool vaults not found');
    const baseRes = BigInt(baseAcc.amount.toString());
    const quoteRes = BigInt(quoteAcc.amount.toString());
    if (baseRes === 0n || quoteRes === 0n) throw new Error('pool empty');
    const k = baseRes * quoteRes;
    const newBase = baseRes + BigInt(baseAmountIn);
    const newQuote = k / newBase;
    return quoteRes - newQuote;
  }

  async getTokenBalance(mint) {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), this.wallet.publicKey);
    try {
      const acc = await getAccount(this.conn, ata);
      return BigInt(acc.amount.toString());
    } catch {
      return 0n;
    }
  }

  /**
   * 买入。成功后 pool info 已缓存供 sell 复用。
   */
  async buy(mint, amountLamports = cfg.trade.buyAmountLamports) {
    const t0 = Date.now();
    const pi = await this.resolvePool(mint, false); // 新币强制重新解析
    const expectedOut = await this.estimateBuyOut(pi, amountLamports);
    const blockhash = await this._getBlockhash();

    // 多 wrap 一些 SOL 作为价格波动缓冲, 让 max_quote_in 略大于 quoteInLamports
    const wrapBuffer = BigInt(amountLamports) * BigInt(cfg.trade.buySlippageBps) / 10000n;
    const wrapAmount = BigInt(amountLamports) + wrapBuffer;

    const tx = pumpAmm.buildBuyTx({
      user: this.wallet.publicKey,
      baseMint: pi.mintPk,
      pool: pi.pool,
      poolBaseVault: pi.poolBaseVault,
      poolQuoteVault: pi.poolQuoteVault,
      globalConfig: pi.globalConfig,
      protocolFeeRecipient: pi.protocolFeeRecipient,
      protocolFeeRecipientWsol: pi.protocolFeeRecipientWsol,
      quoteInLamports: amountLamports,
      wrapLamports: Number(wrapAmount),
      expectedBaseOut: expectedOut,
      slippageBps: cfg.trade.buySlippageBps,
      priorityFeeLamports: cfg.trade.buyPriorityFeeLamports,
      tipLamports: 0,
      blockhash,
    });
    tx.sign([this.wallet]);

    const res = await this.sender.broadcast(tx, { useShredstream: true, useRpc: true });
    const t1 = Date.now();
    log.info(`buy ${mint.slice(0, 8)} ${amountLamports / 1e9} SOL → ${res.signature || res.error} (${t1 - t0}ms)`);
    return { ...res, expectedOut: expectedOut.toString(), latencyMs: t1 - t0 };
  }

  /**
   * 卖出
   * @param {object} opts
   * @param {boolean} opts.isRug   RUG 模式: 高优先费 + slipstream + 失败重试 1 次
   * @param {bigint=} opts.knownBalance  调用方已知的余额 (跳过 RPC 查询,节省 ~100ms)
   */
  async sell(mint, { isRug = false, knownBalance = null } = {}) {
    const t0 = Date.now();
    const pi = await this.resolvePool(mint, true);

    // RUG 模式优先用调用方传入的余额; 普通模式查 RPC 拿准确值
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

    const tx = pumpAmm.buildSellTx({
      user: this.wallet.publicKey,
      baseMint: pi.mintPk,
      pool: pi.pool,
      poolBaseVault: pi.poolBaseVault,
      poolQuoteVault: pi.poolQuoteVault,
      globalConfig: pi.globalConfig,
      protocolFeeRecipient: pi.protocolFeeRecipient,
      protocolFeeRecipientWsol: pi.protocolFeeRecipientWsol,
      baseAmountIn: bal,
      expectedQuoteOut: expectedOut,
      slippageBps: slippage,
      priorityFeeLamports: priorityFee,
      tipLamports: tip,
      tipAccount: SHREDSTREAM_TIP_ACCOUNT,
      blockhash,
    });
    tx.sign([this.wallet]);

    let res = await this.sender.broadcast(tx, {
      useShredstream: true,
      useSlipstream: isRug,
      useRpc: true,
    });

    // RUG 模式: 失败立即重试 1 次, 用更新的 blockhash + 更大滑点 + 更高优先费
    if (isRug && !res.signature) {
      log.warn(`RUG sell 第一次失败 (${res.error}), 立即重试`);
      const bh2 = await this._getBlockhash();
      const tx2 = pumpAmm.buildSellTx({
        user: this.wallet.publicKey,
        baseMint: pi.mintPk, pool: pi.pool,
        poolBaseVault: pi.poolBaseVault, poolQuoteVault: pi.poolQuoteVault,
        globalConfig: pi.globalConfig,
        protocolFeeRecipient: pi.protocolFeeRecipient,
        protocolFeeRecipientWsol: pi.protocolFeeRecipientWsol,
        baseAmountIn: bal,
        expectedQuoteOut: expectedOut,
        slippageBps: Math.min(9500, slippage + 1000),
        priorityFeeLamports: Math.floor(priorityFee * 1.5),
        tipLamports: tip,
        tipAccount: SHREDSTREAM_TIP_ACCOUNT,
        blockhash: bh2,
      });
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
