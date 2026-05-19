'use strict';
//
// Pump AMM 交易构造器 — 跳过 SDK 封装,直接构造 instruction。
//
// pump-amm 指令布局 (basd on 公开 IDL,部署前请用你本地 pump SDK 版本对照确认):
//
//   buy:
//     discriminator: [102, 6, 61, 18, 1, 218, 235, 234]  (8 bytes)
//     args: { base_amount_out: u64, max_quote_amount_in: u64 }
//     accounts (顺序固定):
//       0  pool                    (PDA)
//       1  user                    (signer, writable)
//       2  global_config
//       3  base_mint               (token mint)
//       4  quote_mint              (wSOL)
//       5  user_base_token_account (signer 的 token ATA)
//       6  user_quote_token_account(signer 的 wSOL ATA)
//       7  pool_base_token_account (pool token vault)
//       8  pool_quote_token_account(pool wSOL vault)
//       9  protocol_fee_recipient
//       10 protocol_fee_recipient_token_account
//       11 base_token_program
//       12 quote_token_program
//       13 system_program
//       14 associated_token_program
//       15 event_authority
//       16 program (pump_amm)
//
//   sell:
//     discriminator: [51, 230, 133, 164, 1, 127, 131, 173]
//     args: { base_amount_in: u64, min_quote_amount_out: u64 }
//     accounts: same layout as buy
//
// pool PDA derivation (mainnet pump-amm):
//   seeds = ["pool", index_le_u16, base_mint, quote_mint]
//   index 在迁移时由 pump-fun 写入,固定为 0 (绝大多数情况) — 部署前确认
//
// ⚠️ 本文件按公开规范构造指令,但 pump-amm 偶有版本更新,
// 建议在 testnet 跑一笔验证或参考你本地的 @pump-fun/pump-swap-sdk 实现。

const {
  PublicKey, Keypair, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram, VersionedTransaction,
  TransactionMessage,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, createSyncNativeInstruction,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT,
} = require('@solana/spl-token');
const cfg = require('../config');
const log = require('../utils/logger').child('pump-tx');

const PUMP_AMM_PROGRAM = new PublicKey(cfg.pump.pumpAmmProgram);
const WSOL_MINT = new PublicKey(cfg.pump.wsolMint);

const DISCRIM_BUY  = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const DISCRIM_SELL = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

function u64LE(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

function findPoolPda(baseMint, quoteMint = WSOL_MINT, index = 0) {
  const idxBuf = Buffer.alloc(2);
  idxBuf.writeUInt16LE(index);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), idxBuf, baseMint.toBuffer(), quoteMint.toBuffer()],
    PUMP_AMM_PROGRAM,
  )[0];
}

function findEventAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PUMP_AMM_PROGRAM,
  )[0];
}

/**
 * 构造 buy 指令 (单条 instruction,不含 setup/cleanup)
 * @param {object} ctx
 * @param {PublicKey} ctx.user
 * @param {PublicKey} ctx.baseMint
 * @param {PublicKey} ctx.pool
 * @param {PublicKey} ctx.poolBaseVault
 * @param {PublicKey} ctx.poolQuoteVault
 * @param {PublicKey} ctx.globalConfig
 * @param {PublicKey} ctx.protocolFeeRecipient
 * @param {PublicKey} ctx.protocolFeeRecipientWsol
 * @param {bigint}    ctx.baseAmountOut    期望买到的 token 量 (考虑滑点,取下限)
 * @param {bigint}    ctx.maxQuoteIn       愿意付的最大 SOL (lamports)
 */
function buildBuyIx(ctx) {
  const userBaseAta  = getAssociatedTokenAddressSync(ctx.baseMint, ctx.user);
  const userQuoteAta = getAssociatedTokenAddressSync(WSOL_MINT, ctx.user);
  const eventAuth    = findEventAuthority();

  const data = Buffer.concat([
    DISCRIM_BUY,
    u64LE(ctx.baseAmountOut),
    u64LE(ctx.maxQuoteIn),
  ]);

  const keys = [
    { pubkey: ctx.pool, isSigner: false, isWritable: true },
    { pubkey: ctx.user, isSigner: true, isWritable: true },
    { pubkey: ctx.globalConfig, isSigner: false, isWritable: false },
    { pubkey: ctx.baseMint, isSigner: false, isWritable: false },
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
    { pubkey: userBaseAta, isSigner: false, isWritable: true },
    { pubkey: userQuoteAta, isSigner: false, isWritable: true },
    { pubkey: ctx.poolBaseVault, isSigner: false, isWritable: true },
    { pubkey: ctx.poolQuoteVault, isSigner: false, isWritable: true },
    { pubkey: ctx.protocolFeeRecipient, isSigner: false, isWritable: false },
    { pubkey: ctx.protocolFeeRecipientWsol, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: eventAuth, isSigner: false, isWritable: false },
    { pubkey: PUMP_AMM_PROGRAM, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: PUMP_AMM_PROGRAM, keys, data });
}

/**
 * 构造 sell 指令
 */
function buildSellIx(ctx) {
  const userBaseAta  = getAssociatedTokenAddressSync(ctx.baseMint, ctx.user);
  const userQuoteAta = getAssociatedTokenAddressSync(WSOL_MINT, ctx.user);
  const eventAuth    = findEventAuthority();

  const data = Buffer.concat([
    DISCRIM_SELL,
    u64LE(ctx.baseAmountIn),
    u64LE(ctx.minQuoteOut),
  ]);

  const keys = [
    { pubkey: ctx.pool, isSigner: false, isWritable: true },
    { pubkey: ctx.user, isSigner: true, isWritable: true },
    { pubkey: ctx.globalConfig, isSigner: false, isWritable: false },
    { pubkey: ctx.baseMint, isSigner: false, isWritable: false },
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
    { pubkey: userBaseAta, isSigner: false, isWritable: true },
    { pubkey: userQuoteAta, isSigner: false, isWritable: true },
    { pubkey: ctx.poolBaseVault, isSigner: false, isWritable: true },
    { pubkey: ctx.poolQuoteVault, isSigner: false, isWritable: true },
    { pubkey: ctx.protocolFeeRecipient, isSigner: false, isWritable: false },
    { pubkey: ctx.protocolFeeRecipientWsol, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: eventAuth, isSigner: false, isWritable: false },
    { pubkey: PUMP_AMM_PROGRAM, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: PUMP_AMM_PROGRAM, keys, data });
}

/**
 * 构造一笔完整买入 tx (含 ATA 创建、wSOL wrap、setComputeUnitPrice、tip)
 * 返回未签名的 VersionedTransaction
 */
function buildBuyTx({
  user, baseMint, pool, poolBaseVault, poolQuoteVault, globalConfig,
  protocolFeeRecipient, protocolFeeRecipientWsol,
  quoteInLamports,             // 计划花掉的 SOL (max_quote_in 用这个值)
  wrapLamports,                // 实际 wrap 进 wSOL ATA 的 SOL (≥ quoteInLamports, 多余的会通过 close 退回)
  expectedBaseOut,             // 估算的 base token 数量 (整数)
  slippageBps,                 // e.g. 2500 = 25%
  priorityFeeLamports,
  tipLamports = 0,
  tipAccount = null,
  blockhash,
  computeUnits = 350_000,
}) {
  const ixs = [];
  // 没传 wrapLamports 时回退到 quoteInLamports (兼容旧调用)
  const wrap = wrapLamports || quoteInLamports;

  // 1. compute budget
  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
  if (priorityFeeLamports > 0) {
    const microLamports = Math.ceil((priorityFeeLamports * 1_000_000) / computeUnits);
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  }

  // 2. ensure ATAs exist
  const userBaseAta = getAssociatedTokenAddressSync(baseMint, user);
  const userWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, user);
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, userBaseAta, user, baseMint));
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, userWsolAta, user, WSOL_MINT));

  // 3. wrap SOL: transfer (含缓冲) + syncNative
  ixs.push(SystemProgram.transfer({
    fromPubkey: user, toPubkey: userWsolAta, lamports: wrap,
  }));
  ixs.push(createSyncNativeInstruction(userWsolAta));

  // 4. min base out = expectedBaseOut * (1 - slippage)
  const minOut = (BigInt(expectedBaseOut) * BigInt(10000 - slippageBps)) / 10000n;

  ixs.push(buildBuyIx({
    user, baseMint, pool, poolBaseVault, poolQuoteVault, globalConfig,
    protocolFeeRecipient, protocolFeeRecipientWsol,
    baseAmountOut: minOut,
    maxQuoteIn: BigInt(quoteInLamports),
  }));

  // 5. close wSOL ATA → 退回未消耗的 wSOL + rent
  ixs.push(createCloseAccountInstruction(userWsolAta, user, user));

  // 6. tip
  if (tipLamports > 0 && tipAccount) {
    ixs.push(SystemProgram.transfer({
      fromPubkey: user, toPubkey: new PublicKey(tipAccount), lamports: tipLamports,
    }));
  }

  const msg = new TransactionMessage({
    payerKey: user, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

/**
 * 构造一笔完整卖出 tx
 */
function buildSellTx({
  user, baseMint, pool, poolBaseVault, poolQuoteVault, globalConfig,
  protocolFeeRecipient, protocolFeeRecipientWsol,
  baseAmountIn,
  expectedQuoteOut,
  slippageBps,
  priorityFeeLamports,
  tipLamports = 0,
  tipAccount = null,
  blockhash,
  closeAtaAfter = true,
  computeUnits = 350_000,
}) {
  const ixs = [];

  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
  if (priorityFeeLamports > 0) {
    const microLamports = Math.ceil((priorityFeeLamports * 1_000_000) / computeUnits);
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  }

  const userWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, user);
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, userWsolAta, user, WSOL_MINT));

  const minOut = (BigInt(expectedQuoteOut) * BigInt(10000 - slippageBps)) / 10000n;

  ixs.push(buildSellIx({
    user, baseMint, pool, poolBaseVault, poolQuoteVault, globalConfig,
    protocolFeeRecipient, protocolFeeRecipientWsol,
    baseAmountIn: BigInt(baseAmountIn),
    minQuoteOut: minOut,
  }));

  // unwrap wSOL → SOL
  ixs.push(createCloseAccountInstruction(userWsolAta, user, user));

  // tip
  if (tipLamports > 0 && tipAccount) {
    ixs.push(SystemProgram.transfer({
      fromPubkey: user, toPubkey: new PublicKey(tipAccount), lamports: tipLamports,
    }));
  }

  const msg = new TransactionMessage({
    payerKey: user, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

module.exports = {
  PUMP_AMM_PROGRAM, WSOL_MINT,
  findPoolPda, findEventAuthority,
  buildBuyIx, buildSellIx,
  buildBuyTx, buildSellTx,
};
