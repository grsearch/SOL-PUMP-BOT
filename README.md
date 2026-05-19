# SOL Pump Bot

Pump.fun 迁移币自动交易机器人。 迁移即买入,EMA9 下穿 EMA20 / 移动止盈 / RUG 同 slot 紧急止损卖出。

## 架构

```
                                ┌──────────────────────────────┐
                                │   pumpmoniter-v2 (上游)      │
                                │   迁移信号 (FDV≥20K, LP≥5K)  │
                                └─────────────┬────────────────┘
                                              │ webhook
                                              ▼
                              ┌──────────────────────────────────┐
                              │  POST /webhook/add-token        │
                              │  → Strategy.onWebhookAdd        │
                              └─────────────┬────────────────────┘
                                            │
              ┌─────────────────────────────┼───────────────────────────┐
              ▼                             ▼                           ▼
   ┌──────────────────┐         ┌─────────────────────┐     ┌──────────────────────┐
   │ Trader.buy       │         │ BirdeyePoller (1s)  │     │ RugDetector          │
   │ Pump SDK 自构造  │         │  → KlineEngine 15s  │     │  ⬅ HeliusLaserStream │
   │ Shredstream+RPC  │         │  → EMA9/EMA20       │     │  ⬅ Shredstream       │
   └────────┬─────────┘         └──────────┬──────────┘     └──────────┬───────────┘
            │                              │                            │
            ▼                              ▼                            ▼
                                  Strategy 决策中心
                            (EMA cross / trailing / RUG)
                                            │
                                            ▼
                                  Trader.sell { isRug }
                                            │
                                            ▼
                              MultiSender → Shredstream + Slipstream + RPC
                                  (RUG 模式下三通道并发,谁先成交算谁)
```

## 模块

| 文件 | 作用 |
|------|------|
| `src/index.js` | 入口,串起所有组件 |
| `src/config.js` | 集中配置 (.env) |
| `src/server.js` | Express,webhook + dashboard API + 静态资源 |
| `src/ws/wsHub.js` | dashboard 实时推送 |
| `src/data/birdeyePoller.js` | Birdeye 1秒价格轮询 + token overview |
| `src/data/klineEngine.js` | 15秒 OHLC 合成 + EMA9/EMA20 (TradingView 标准) |
| `src/data/heliusLaserStream.js` | LaserStream gRPC,订阅 mint 卖单 |
| `src/data/heliusMeta.js` | helius 算 age / holders |
| `src/data/shredstream.js` | shredstream 订阅 + 发送 |
| `src/data/slipstream.js` | slipstream 发送通道 |
| `src/monitor/rugDetector.js` | **RUG 同 slot 卖单聚类检测** ★ |
| `src/monitor/tokenStore.js` | token 状态机 |
| `src/trade/pumpAmm.js` | pump-amm 指令直接构造 (跳过 SDK 封装) |
| `src/trade/trader.js` | buy/sell 高层封装 |
| `src/trade/sender.js` | 多通道并发广播 |
| `src/strategy/strategy.js` | **策略大脑** ★ |
| `src/pnl/tradeDb.js` | sqlite 交易记录 + PnL 聚合 |
| `public/index.html` | dashboard |

## 启动

```bash
cp .env.example .env
# 编辑 .env, 填好所有 API key 和钱包

npm install
npm start
```

dashboard 地址: `http://<server>:3001/`  (basic auth)

## webhook 接入

pumpmoniter-v2 配置 `WEBHOOK_URL=http://<this-server>:3001/webhook/add-token`

payload 格式 (兼容 pumpmoniter-v2):
```json
{ "network": "solana", "address": "<mint>", "symbol": "<sym>" }
```

**公网部署务必**:
1. `.env` 里设 `WEBHOOK_SECRET=xxx`
2. pumpmoniter-v2 端发请求时带 `X-Webhook-Secret: xxx` header
3. 不设置会被任何人触发买入

## 关键说明 ⚠️

### 1. proto 文件
- `src/proto/laserstream.proto` 需从 [helius-labs/laserstream-grpc](https://github.com/helius-labs/) 下载
- `src/proto/shredstream.proto` 需从 docs.shredstream.com 拿到官方版本
- 这两个目前是占位,**不放进去 gRPC 通道会断**(其他模块仍可运行)

### 2. pump-amm 指令布局
`src/trade/pumpAmm.js` 中的 discriminator / accounts 顺序按公开 IDL 实现。
**部署前请用你本地的 `@pump-fun/pump-swap-sdk` 跑一笔小额买卖对照确认**,
特别是 `GLOBAL_CONFIG` / `PROTOCOL_FEE_RECIPIENT` 这两个常量。

### 3. shredstream tip account
卖出 tip 转账的目标地址需在 shredstream 文档里查到,
填到 `src/trade/trader.js` 的 `SHREDSTREAM_TIP_ACCOUNT` 常量。

### 4. EMA 算法 (TradingView 标准)
- 前 N 根 K 线用 SMA 初始化 EMA(N)
- 之后: `ema = price * (2/(N+1)) + prev_ema * (1 - 2/(N+1))`
- 已用已知数据集验证,与 TradingView 输出 4 位小数精度一致

### 5. 买入后冷启动
买入瞬间没有历史 K 线,前 `EMA_WARMUP_BARS` (默认 2) 根 K 线内
**不允许 EMA 卖出信号触发**,避免噪声打出来。
trailing 和 RUG 不受此限制。

### 6. 单 token 只交易一次
卖出成功后 5 秒清理,从 birdeye / helius / shredstream 全部退订,
不再继续监控。

## 配置 (.env)

| 关键参数 | 默认 | 说明 |
|---|---|---|
| `BUY_AMOUNT_SOL` | 1 | 每次买入金额 |
| `BUY_PRIORITY_FEE_SOL` | 0.0005 | 买入优先费 |
| `SELL_PRIORITY_FEE_SOL` | 0.0005 | 普通卖出优先费 |
| `RUG_PRIORITY_FEE_SOL` | 0.005 | RUG 紧急卖出优先费 (10×) |
| `RUG_TIP_SOL` | 0.001 | RUG 时的 tip |
| `RUG_SAME_SLOT_MIN_SELLS` | 5 | 同 slot 卖单触发阈值 |
| `RUG_SAME_SLOT_MIN_SOL` | 5 | 同 slot 累计 SOL 触发阈值 |
| `RUG_GAS_TOLERANCE_LAMPORTS` | 100 | priority fee 一致性容差 |
| `RUG_SLOT_WINDOW` | 1 | 同 slot 或相邻 N slot 算同簇 |
| `TRAILING_ACTIVATE_PCT` | 200 | trailing 激活阈值 (+%) |
| `TRAILING_DRAWDOWN_PCT` | 20 | trailing 回撤卖出 (%) |
| `MONITOR_MIN_FDV` | 30000 | 跌破移除监控 |
| `MONITOR_MIN_LP` | 10000 | 跌破移除监控 |
| `KLINE_INTERVAL_SEC` | 15 | K线周期 |
| `EMA_FAST` / `EMA_SLOW` | 9 / 20 | EMA 周期 |
| `EMA_WARMUP_BARS` | 2 | 买入后多少根 K 线内不允许 EMA 卖出 |

## RUG 检测逻辑

满足**所有**条件时触发:
1. 滑动窗口 `[slot - N, slot]` 内有 ≥ 5 笔卖单
2. 累计 SOL ≥ 5
3. 来自 ≥ 3 个不同 owner
4. priority fee 高度一致 (差距 ≤ 100 lamports)

任一不满足都不触发,避免误杀正常拉盘后的获利了结。

## 未实现 / 后续可扩展

- 多钱包池: `Trader` 已留接口,加 wallet 数组并轮询即可
- holders 实时计算: 现在用 birdeye overview, 可换 helius 自算 (heliusMeta.js 已就绪)
- age 计算: heliusMeta.js 已就绪,需在 strategy 里调用
- 买入失败重试 / 部分成交补单
