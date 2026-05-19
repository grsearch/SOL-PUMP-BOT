# CHANGES.md — sol-pump-bot 完整变更记录

> 打包时间: 2026-05-19
> 状态: v4 全部补丁已应用,可直接部署

---

## v4 (本次, 2026-05-19)

### 新功能

**1. 链上 FDV/LP 计算 (替代 birdeye 索引依赖)**
- `trader.getOnChainFdvLp(mint)` 用 vault 余额 + mint supply + SOL/USD 价直接算 FDV 和 LP
- 公式: `priceUsd = (quote_lamports/1e9) / (base_amount/10^decimals) × sol_usd`, `fdv = priceUsd × supply_ui`, `lp = 2 × quote_sol × sol_usd`
- 新迁移瞬间也能算出准确值, bypass birdeye 索引延迟
- onWebhookAdd 改成先 resolvePool 拿到链上数据再做 FDV 上下限检查

**2. 持仓持久化 (重启不丢仓)**
- sqlite 新增 `positions` 表, 字段含 state / buyAt / buyTxSig / buyAmountLamports / buyPriceUsd / **peakPriceUsd** / tokenBalance / pool 信息 / **trailingActivated** / **barsSinceBuy**
- 持久化时机: buy 成功 / sell 失败回滚 / 每根 K 线收盘 / trailing 激活 / 启动恢复
- `strategy.recoverPositions()` 启动恢复:
  1. 读 db 所有 HOLDING/SELLING 记录
  2. `trader.getTokenBalance` 校验链上余额
  3. 有余额 → 重建内存 store + 重新订阅 helius/shred/birdeye, 用链上余额覆盖 db 余额
  4. 无余额 → 删 db 行 (重启期间被卖了)
- 启动后 sleep 3 秒等 SOL 价格 / reserveCache 填好再恢复

**3. 新增 AGGRESSIVE RUG 通道**
- 3+ 笔同 slot 同 gas, 总 ≥10 SOL → 立即触发卖出
- 抓"少而大"的协同砸盘 (区别于 STRICT 的"多而小")
- 通道架构重构成 `signals[]` 数组形式, 以后加新规则只需 push 一条

### 通道优先级 (任一满足即触发)
1. **STRICT** — 5+ 笔, ≥5 SOL, ≥3 owner, 同 gas
2. **AGGRESSIVE** — 3+ 笔, ≥10 SOL, ≥2 owner, 同 gas  ← v4 新增
3. **FALLBACK** — 8+ 笔, ≥8 SOL (数据不全兜底)
4. **PRICE_CRASH** — 30s 内峰值跌 ≥60% (最后兜底)

### 修改文件
| 文件 | 主要改动 |
|------|---------|
| `src/trade/trader.js` | SOL 价格缓存 + mint supply 读取 + `getOnChainFdvLp()` |
| `src/strategy/strategy.js` | 链上 FDV/LP 检查 + `_persist()` + `recoverPositions()` |
| `src/monitor/rugDetector.js` | 重构 signals 数组 + AGGRESSIVE 通道 |
| `src/pnl/tradeDb.js` | positions 表 + CRUD 函数 |
| `src/config.js` | `RUG_AGGR_MIN_SELLS` / `RUG_AGGR_MIN_SOL` 配置 |
| `src/server.js` | webhook 接受可选 fdv/lp payload |
| `src/index.js` | 启动后 3 秒调 recoverPositions |

---

## v3 (上一版, 2026-05-19 上午)

### 核心修复: RUG 检测彻底修好

**根因**: 老的 `heliusLaserStream.parseSellEvent` 用 `b.owner === seller_wallet` 在 token balances 里找减少的 mint, 但 Jupiter/OKX/Trojan 这些 router 走 CPI 时, **中间账户的 owner 是 router PDA, 不是真正卖家钱包**, 导致 95%+ 的真实砸盘漏掉。

**修复** (借鉴 dump-sniper v3):
- 用 `pool_base_vault` 和 `pool_quote_vault` 的 `accountIndex` 在 pre/postTokenBalances 反查余额变化
- `baseDelta > 0 && quoteDelta < 0` → SELL
- `sellSol = -quoteDelta` (精确, 不是估算)
- 不再依赖 owner 匹配, 任何 CPI router 都能解出来

### 其他改动
- `shredstream.js` 真正解析 sell 指令 (base_amount_in + ComputeBudget priority fee), 用 `trader.getCachedReserves` 算精确 sol_out
- `trader.js` 加 `reserveCache` (1s 后台刷新) + `getCachedReserves` 同步接口
- dashboard 改为按 mint 配对显示交易记录, 加 CA 列 (点击跳 gmgn)
- `/api/trades-paired` 新 endpoint

---

## v2 (handoff 时已有的状态)

- buy/sell 用官方 `@pump-fun/pump-swap-sdk` 重写
- 修复 pool PDA 派生 (加 `pumpPoolAuthorityPda`)
- 修复 Token-2022 支持 (检测 baseTokenProgram / quoteTokenProgram)
- 新增 FDV 上限检查 (老版用 birdeye, v4 改链上)
- shredstream 从 gRPC 改为 UDP SDK
- 加买入重试 (5 次, 1s 间隔)
- ConfirmTracker (异步 confirm tx, 拿 landed_slot + 实际 SOL/token diff)
- tradeDb 加 sol_amount_actual / token_amount_actual / pnl_sol_actual / signal_slot / landed_slot / slot_delta / status / confirmed_at 字段
- dashboard 显示 status / landed_slot / slot Δ 列

---

## 文件结构

```
sol-pump-bot/
├── README.md
├── CHANGES.md
├── package.json
├── package-lock.json
├── public/
│   └── index.html               # dashboard (配对显示 + CA 列)
└── src/
    ├── config.js                # 所有 env 配置
    ├── index.js                 # 入口, 启动恢复
    ├── server.js                # webhook + dashboard API
    ├── data/
    │   ├── birdeyePoller.js     # 1s 价格轮询
    │   ├── heliusLaserStream.js # ⭐ v3: vault delta 解析
    │   ├── heliusMeta.js        # age/holders 计算 (未启用)
    │   ├── klineEngine.js       # 15s OHLC + EMA9/EMA20
    │   ├── shredstream.js       # ⭐ v3: 真正解析 sell ix
    │   └── slipstream.js        # 发送通道
    ├── monitor/
    │   ├── rugDetector.js       # ⭐ v4: signals 数组, AGGRESSIVE 通道
    │   └── tokenStore.js        # 内存 token 状态机
    ├── pnl/
    │   └── tradeDb.js           # ⭐ v4: positions 表
    ├── proto/
    │   └── README.md            # proto 文件占位说明
    ├── strategy/
    │   └── strategy.js          # ⭐ v4: 链上 FDV/LP + 持久化 + 恢复
    ├── trade/
    │   ├── confirmTracker.js    # tx confirm + 实际值/slot 提取
    │   ├── pumpAmm.js           # pump-amm 指令构造
    │   ├── sender.js            # 多通道并发广播
    │   └── trader.js            # ⭐ v4: getOnChainFdvLp + supply 缓存
    ├── utils/
    │   ├── logger.js
    │   └── pumpAmmConsts.js     # discriminators
    └── ws/
        └── wsHub.js             # dashboard 实时推送
```

---

## 部署 checklist

- [ ] 复制 `.env.example` → `.env`, 填好所有 API key 和钱包
- [ ] `npm install` 安装依赖
- [ ] proto 文件: 把 `laserstream.proto` 和 `shredstream.proto` 放到 `src/proto/`
- [ ] pumpmonitor 端配置 `WEBHOOK_URL=http://<server>:3001/webhook/add-token`
- [ ] (可选) 配 `WEBHOOK_SECRET` env + pumpmonitor 端发送 `X-Webhook-Secret` header
- [ ] (可选) `RUG_AGGR_MIN_SELLS=3` / `RUG_AGGR_MIN_SOL=10` 调整 AGGRESSIVE 阈值
- [ ] `node src/index.js` 启动, 看日志 `wallet: <pubkey>` + 3 秒后 `启动恢复:` 信息

---

## 关键 env 变量

```
# 基础
PORT=3001
WEBHOOK_SECRET=<填写, 防止公网被恶意触发>
DASHBOARD_USER=admin
DASHBOARD_PASS=<填写>
TRADER_PRIVATE_KEY=<base58 钱包私钥>

# RPC
HELIUS_API_KEY=
HELIUS_RPC=https://mainnet.helius-rpc.com/?api-key=...
HELIUS_LASERSTREAM_ENDPOINT=
HELIUS_LASERSTREAM_TOKEN=

# Birdeye (拿 SOL 价格 + holders/volume)
BIRDEYE_API_KEY=

# Shredstream / Slipstream
SHREDSTREAM_PORT=8001
SLIPSTREAM_ENDPOINT=
SLIPSTREAM_API_KEY=

# 交易参数
BUY_AMOUNT_SOL=1
BUY_PRIORITY_FEE_SOL=0.0005
SELL_PRIORITY_FEE_SOL=0.0005
RUG_PRIORITY_FEE_SOL=0.005
RUG_TIP_SOL=0.001

# 监控阈值
MONITOR_MAX_FDV=200000     # FDV 上限, 超过不买入
MONITOR_MIN_FDV=20000      # FDV 下限, 低于不买入
MONITOR_MIN_LP=5000        # LP 下限

# RUG 检测
RUG_SAME_SLOT_MIN_SELLS=5
RUG_SAME_SLOT_MIN_SOL=5
RUG_AGGR_MIN_SELLS=3       # v4 新增
RUG_AGGR_MIN_SOL=10        # v4 新增
RUG_GAS_TOLERANCE_LAMPORTS=1000
RUG_SLOT_WINDOW=1
RUG_FALLBACK_ENABLED=true
RUG_FALLBACK_MIN_SELLS=8
RUG_FALLBACK_MIN_SOL=8
RUG_PRICE_CRASH_ENABLED=true
RUG_PRICE_CRASH_PCT=60

# 策略
TRAILING_ACTIVATE_PCT=200
TRAILING_DRAWDOWN_PCT=20
EMA_FAST=9
EMA_SLOW=20
EMA_WARMUP_BARS=2
KLINE_INTERVAL_SEC=15
```
