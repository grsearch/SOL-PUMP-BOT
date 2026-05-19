'use strict';
//
// Pump-amm 协议常量。 供解析器和构造器共用。
//

// pump-amm sell instruction discriminator (8 bytes, Anchor sighash of "global:sell")
// = sha256("global:sell")[0..8]
const SELL_DISC = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

// buy instruction discriminator (Anchor sighash of "global:buy")
const BUY_DISC = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

// ComputeBudget program
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

// ComputeBudget instruction discriminators (单字节):
//   2 = SetComputeUnitLimit
//   3 = SetComputeUnitPrice (followed by u64 microLamports LE)
const CB_SET_PRICE = 3;

function bufStartsWith(buf, prefix) {
  if (!buf || buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (buf[i] !== prefix[i]) return false;
  return true;
}

module.exports = { SELL_DISC, BUY_DISC, COMPUTE_BUDGET, CB_SET_PRICE, bufStartsWith };
