'use strict';
//
// Helius LaserStream gRPC 客户端,订阅指定 mint 的交易,解析卖单。
//
// LaserStream (基于 Yellowstone Geyser) 协议:
//   - SubscribeRequest.transactions[<filter_name>] = { account_include: [mint, ...], failed: false }
//   - 服务端推送 SubscribeUpdateTransaction { slot, transaction, meta }
//
// 解析卖单方法 (pump-amm 池):
//   - 检查 tx 是否调用了 pump_amm program
//   - 检查 inner instruction 的 transfer 方向:
//       * 卖家 token account → pool token vault     (token 流出)
//       * pool wsol vault   → 卖家 wsol account     (sol 流入)
//   - solAmount = wsol 流入数量
//   - priorityFeeLamports = meta.computeUnitsConsumed * priceMicroLamports / 1e6
//     更精确做法: 从 setComputeUnitPrice 指令解析
//
// ⚠️ 占位实现说明:
// Helius LaserStream 的实际 proto 文件需从 https://github.com/helius-labs/laserstream-grpc 获取,
// 这里假设 proto 已放在 ./proto/laserstream.proto。 部署时请确认 proto 路径 + endpoint 鉴权方式。
//

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const cfg = require('../config');
const log = require('../utils/logger').child('helius-ls');

const PUMP_AMM = cfg.pump.pumpAmmProgram;
const WSOL = cfg.pump.wsolMint;

class HeliusLaserStream {
  constructor({ onSell }) {
    this.onSell = onSell;
    this.client = null;
    this.stream = null;
    this.watchedMints = new Set();
    this.connected = false;
  }

  async connect() {
    if (this.connected) return;
    const protoPath = path.resolve(__dirname, '../proto/laserstream.proto');
    let pkgDef;
    try {
      pkgDef = protoLoader.loadSync(protoPath, {
        keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
      });
    } catch (e) {
      log.error(`proto load failed (${protoPath}): ${e.message}`);
      log.error('请将 laserstream.proto 放到 src/proto/ 目录');
      return;
    }

    const grpcObj = grpc.loadPackageDefinition(pkgDef);
    const Geyser = grpcObj.geyser?.Geyser || grpcObj.Geyser;
    if (!Geyser) {
      log.error('proto 未找到 Geyser service');
      return;
    }

    const url = cfg.helius.laserstream.endpoint.replace(/^https?:\/\//, '');
    const creds = grpc.credentials.combineChannelCredentials(
      grpc.credentials.createSsl(),
      grpc.credentials.createFromMetadataGenerator((_, callback) => {
        const meta = new grpc.Metadata();
        meta.add('x-token', cfg.helius.laserstream.token);
        callback(null, meta);
      }),
    );
    this.client = new Geyser(url, creds);
    this.stream = this.client.Subscribe();

    this.stream.on('data', (msg) => this._onMessage(msg));
    this.stream.on('error', (e) => log.error(`stream err: ${e.message}`));
    this.stream.on('end', () => {
      log.warn('stream ended, reconnecting in 3s');
      this.connected = false;
      setTimeout(() => this.connect(), 3000);
    });

    this.connected = true;
    log.info(`connected to ${url}`);
    this._resync();
  }

  _resync() {
    if (!this.stream || this.watchedMints.size === 0) return;
    const req = {
      transactions: {
        pump_sells: {
          account_include: Array.from(this.watchedMints),
          account_required: [PUMP_AMM],
          failed: false,
          vote: false,
        },
      },
      commitment: 'processed',
    };
    this.stream.write(req);
    log.debug(`subscribed to ${this.watchedMints.size} mints`);
  }

  watch(mint) {
    if (this.watchedMints.has(mint)) return;
    this.watchedMints.add(mint);
    this._resync();
  }

  unwatch(mint) {
    if (!this.watchedMints.delete(mint)) return;
    this._resync();
  }

  _onMessage(msg) {
    const tx = msg.transaction;
    if (!tx || !tx.transaction) return;
    try {
      const ev = parseSellEvent(tx, this.watchedMints);
      if (ev) this.onSell(ev);
    } catch (e) {
      log.debug(`parse err: ${e.message}`);
    }
  }
}

/**
 * 把 LaserStream 推送的 tx 解析成 SellEvent (如果是 pump-amm 卖单)
 * @param {Set<string>} watchedMints  仅匹配这些 mint 的卖单, 其他忽略
 * 返回 null 表示不是卖单或解析失败
 */
function parseSellEvent(txUpdate, watchedMints) {
  const slot = Number(txUpdate.slot || 0);
  const tx = txUpdate.transaction;
  const meta = tx.meta;
  const message = tx.transaction?.message;
  if (!meta || !message || meta.err) return null;

  const pre = meta.preTokenBalances || [];
  const post = meta.postTokenBalances || [];
  const preMap = new Map();
  for (const b of pre) preMap.set(`${b.accountIndex}_${b.mint}`, BigInt(b.uiTokenAmount?.amount || '0'));

  // 找出我们监控的 mint 中,余额减少最多的 token account
  let seller = null, mint = null, soldAmount = 0n;
  for (const b of post) {
    if (!watchedMints || !watchedMints.has(b.mint)) continue;
    if (b.mint === WSOL) continue;
    const k = `${b.accountIndex}_${b.mint}`;
    const preAmt = preMap.get(k) || 0n;
    const postAmt = BigInt(b.uiTokenAmount?.amount || '0');
    if (postAmt < preAmt) {
      const decrease = preAmt - postAmt;
      if (decrease > soldAmount) {
        seller = b.owner;
        mint = b.mint;
        soldAmount = decrease;
      }
    }
  }
  if (!seller || !mint) return null;

  // 2. 计算卖家 SOL 进账 (lamports)
  const accountKeys = message.accountKeys || [];
  let sellerIdx = -1;
  for (let i = 0; i < accountKeys.length; i++) {
    const k = typeof accountKeys[i] === 'string' ? accountKeys[i] : bytesToBase58(accountKeys[i]);
    if (k === seller) { sellerIdx = i; break; }
  }
  let solAmount = 0;
  if (sellerIdx >= 0) {
    const preBal = Number(meta.preBalances?.[sellerIdx] || 0);
    const postBal = Number(meta.postBalances?.[sellerIdx] || 0);
    const fee = Number(meta.fee || 0);
    solAmount = (postBal - preBal + fee) / 1e9;
  }
  if (solAmount <= 0) return null;

  // 3. priority fee 指纹: 优先从 ComputeBudget.SetComputeUnitPrice 指令读 microLamports
  //    (机器人发的 tx 这个值通常完全一致, 比 total_fee 更准)
  //    fallback: total_fee - base_fee(5000)
  const cbProgram = 'ComputeBudget111111111111111111111111111111';
  let priorityFeeLamports = Math.max(0, Number(meta.fee || 0) - 5000);
  try {
    const ixs = message.instructions || [];
    for (const ix of ixs) {
      const progIdIdx = typeof ix.programIdIndex === 'number' ? ix.programIdIndex : ix.program_id_index;
      const progKey = accountKeys[progIdIdx];
      const progStr = typeof progKey === 'string' ? progKey : bytesToBase58(progKey);
      if (progStr !== cbProgram) continue;
      const dataRaw = ix.data;
      const dataBuf = typeof dataRaw === 'string'
        ? Buffer.from(dataRaw, 'base64')
        : Buffer.isBuffer(dataRaw) ? dataRaw : Buffer.from(dataRaw || []);
      if (dataBuf.length === 0) continue;
      // ComputeBudget instructions: 0=RequestUnits(legacy), 1=RequestHeapFrame,
      // 2=SetComputeUnitLimit, 3=SetComputeUnitPrice (u64 microLamports)
      if (dataBuf[0] === 3 && dataBuf.length >= 9) {
        const microLamports = dataBuf.readBigUInt64LE(1);
        // 把它当作 gas 指纹 (单位 microLamports; RUG 检测的 tolerance 也是这个单位)
        priorityFeeLamports = Number(microLamports);
        break;
      }
    }
  } catch (e) { /* keep fallback */ }

  const sig = tx.signature
    ? (typeof tx.signature === 'string' ? tx.signature : bytesToBase58(tx.signature))
    : '';

  return {
    mint,
    signature: sig,
    slot,
    owner: seller,
    solAmount,
    priorityFeeLamports,
    ts: Date.now(),
  };
}

// 备用 base58 (避免拉 bs58 进核心解析路径)
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bytesToBase58(bytes) {
  if (!bytes || !bytes.length) return '';
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let intVal = 0n;
  for (const b of buf) intVal = (intVal << 8n) + BigInt(b);
  let s = '';
  while (intVal > 0n) {
    s = ALPHA[Number(intVal % 58n)] + s;
    intVal = intVal / 58n;
  }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}

module.exports = { HeliusLaserStream };
