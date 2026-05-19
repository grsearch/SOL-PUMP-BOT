'use strict';
//
// 入口: 启动顺序
//   1. WsHub
//   2. RugDetector
//   3. HeliusLaserStream + Shredstream (双数据源都喂给 rugDetector.ingest)
//   4. Slipstream (发送通道)
//   5. MultiSender + Trader
//   6. Strategy (接收数据源数组 + trader + rugDetector)
//   7. HTTP server (webhook + dashboard)
//
// 关闭流程: SIGINT/SIGTERM 时等待 BUYING/SELLING 完成, 最多 10s 强制退
//

const http = require('http');
const cfg = require('./config');
const log = require('./utils/logger').child('main');

const { WsHub } = require('./ws/wsHub');
const { RugDetector } = require('./monitor/rugDetector');
const { HeliusLaserStream } = require('./data/heliusLaserStream');
const { ShredstreamClient } = require('./data/shredstream');
const { SlipstreamClient } = require('./data/slipstream');
const { MultiSender } = require('./trade/sender');
const { Trader } = require('./trade/trader');
const { Strategy } = require('./strategy/strategy');
const { makeServer } = require('./server');

async function main() {
  log.info('=== SOL Pump Bot 启动 ===');

  const wsHub = new WsHub();
  const rugDetector = new RugDetector();

  // 数据源
  const heliusLs = new HeliusLaserStream({
    onSell: (ev) => rugDetector.ingest(ev),
  });
  const shredstream = new ShredstreamClient({
    onSell: (ev) => rugDetector.ingest(ev),
  });
  heliusLs.connect().catch(e => log.error(`helius-ls connect: ${e.message}`));
  shredstream.connect().catch(e => log.error(`shredstream connect: ${e.message}`));

  const slipstream = new SlipstreamClient();
  const sender = new MultiSender({ shredstream, slipstream });
  const trader = new Trader({ sender });

  // 注入数据源, 让 strategy 自动同步 watch/unwatch
  const strategy = new Strategy({
    trader, rugDetector, wsHub,
    dataSources: [heliusLs, shredstream],
  });

  const app = makeServer({ strategy, wsHub });
  const server = http.createServer(app);
  wsHub.attach(server);

  server.listen(cfg.port, () => {
    log.info(`✅ listening on :${cfg.port}`);
    log.info(`   webhook  → POST /webhook/add-token  ${cfg.webhookSecret ? '(secret 已启用)' : '⚠️ 无 secret, 公网部署务必配置'}`);
    log.info(`   dashboard → GET / (user: ${cfg.dashboard.user})`);
  });

  // ─── 优雅退出 ─────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${sig}, 准备关闭...`);

    // 1. 立即停 server,拒绝新连接
    server.close();
    // 2. 停掉所有后台 timer
    strategy.stop();
    trader.stop?.();

    // 3. 等待持仓/卖出完成, 最多 10 秒
    const deadline = Date.now() + 10_000;
    while (strategy.hasPendingTrades() && Date.now() < deadline) {
      log.info('等待 pending trades 完成...');
      await new Promise(r => setTimeout(r, 500));
    }
    if (strategy.hasPendingTrades()) {
      log.warn('超时仍有 pending trades, 强制退出 (检查 dashboard / db 处理残留持仓!)');
    }
    log.info('bye');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error(`fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});
