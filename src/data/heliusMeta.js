'use strict';
//
// 通过 Helius 计算 token age 和 holders。
//   - age:  getSignaturesForAddress(mint) 取最早 tx → 距今多少分钟
//   - holders: getProgramAccounts(TOKEN_PROGRAM) filter mint → 去重 owner, 仅算余额>0
//
// 注意: holders 这个调用很重, 对热门 mint 也要 1-3 秒,所以 dashboard 用低频刷新。
//

const axios = require('axios');
const cfg = require('../config');
const log = require('../utils/logger').child('helius-meta');

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const http = axios.create({
  baseURL: cfg.helius.rpc,
  timeout: 15000,
  headers: { 'content-type': 'application/json' },
});

async function rpc(method, params) {
  const { data } = await http.post('', {
    jsonrpc: '2.0', id: 1, method, params,
  });
  if (data.error) throw new Error(`${method}: ${data.error.message}`);
  return data.result;
}

/**
 * 取 mint 的最早 tx 时间 (秒). 通过分页找最老的一条。
 * 为速度,默认只翻 5 页 (5*1000 = 5000条),如果币更老就用第 5000 条的时间近似。
 */
async function getMintAgeSec(mint, maxPages = 5) {
  let before = null;
  let oldestTs = null;
  for (let p = 0; p < maxPages; p++) {
    const params = [mint, { limit: 1000 }];
    if (before) params[1].before = before;
    const r = await rpc('getSignaturesForAddress', params);
    if (!r || r.length === 0) break;
    const last = r[r.length - 1];
    if (last.blockTime) oldestTs = last.blockTime;
    if (r.length < 1000) break;
    before = last.signature;
  }
  if (!oldestTs) return null;
  return Math.floor(Date.now() / 1000) - oldestTs;
}

/**
 * 计算持有者数量。
 * 用 getProgramAccounts + dataSize=165 (SPL token account) + memcmp mint
 * 然后取 owner 去重, balance > 0
 */
async function getHolderCount(mint) {
  const filter = (prog) => rpc('getProgramAccounts', [
    prog,
    {
      encoding: 'jsonParsed',
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: mint } },
      ],
    },
  ]).catch(() => []);

  const [a, b] = await Promise.all([filter(TOKEN_PROGRAM), filter(TOKEN_2022_PROGRAM)]);
  const all = [...(a || []), ...(b || [])];

  const owners = new Set();
  for (const acc of all) {
    const info = acc.account?.data?.parsed?.info;
    if (!info) continue;
    const amt = Number(info.tokenAmount?.uiAmount || 0);
    if (amt > 0) owners.add(info.owner);
  }
  return owners.size;
}

function formatAge(sec) {
  if (sec == null) return '?';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

module.exports = { getMintAgeSec, getHolderCount, formatAge };
