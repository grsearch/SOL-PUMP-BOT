'use strict';
//
// 入口: 启动顺序
//   1. WsHub
//   2. RugDetector
//   3. Slipstream (发送通道)
//   4. MultiSender (需要 shredstream 后注入)
//   5. Trader (依赖 sender)
//   6. HeliusLaserStream + Shredstream (shredstream 需要 trader.getCachedReserves)
//   7. ConfirmTracker
//   8. Strategy
//   9. HTTP server
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
const { ConfirmTracker } = require('./trade/confirmTracker');
const { Strategy } = require('./strategy/strategy');
const { makeServer } = require('./server');

async function main() {
  log.info('=== SOL Pump Bot 启动 ===');

  const wsHub = new WsHub();
  const rugDetector = new RugDetector();

  const slipstream = new SlipstreamClient();
  // 先创 sender (shredstream=null), trader 依赖 sender 创建后, 再创 shredstream, 反向注入
  const sender = new MultiSender({ shredstream: null, slipstream });
  const trader = new Trader({ sender });

  // 现在 trader 已就绪, 创 shredstream + helius (shredstream 引用 trader)
  const heliusLs = new HeliusLaserStream({
    onSell: (ev) => rugDetector.ingest(ev),
  });
  const shredstream = new ShredstreamClient({
    onSell: (ev) => rugDetector.ingest(ev),
    trader,
  });
  // 反向注入: sender 把 shredstream 引用补上 (将来用 shred 发送时生效)
  sender.shredstream = shredstream;

  heliusLs.connect().catch(e => log.error(`helius-ls connect: ${e.message}`));
  shredstream.connect().catch(e => log.error(`shredstream connect: ${e.message}`));

  let strategy = null;
  const confirmTracker = new ConfirmTracker({
    walletPubkey: trader.wallet.publicKey,
    onConfirmed: (info) => {
      try { strategy?.onTxConfirmed(info); }
      catch (e) { log.error(`onTxConfirmed err: ${e.message}`); }
    },
  });

  strategy = new Strategy({
    trader, rugDetector, wsHub, confirmTracker,
    dataSources: [heliusLs, shredstream],
  });

  // v4: 启动时从 db 恢复未结束的持仓
  // 等几秒让 SOL 价格、reserveCache 等填充, 提高恢复质量
  setTimeout(() => {
    strategy.recoverPositions().catch(e => log.error(`recoverPositions err: ${e.message}`));
  }, 3000);

  const app = makeServer({ strategy, wsHub });
  const server = http.createServer(app);
  wsHub.attach(server);

  server.listen(cfg.port, () => {
    log.info(`✅ listening on :${cfg.port}`);
    log.info(`   webhook  → POST /webhook/add-token  ${cfg.webhookSecret ? '(secret 已启用)' : '⚠️ 无 secret, 公网部署务必配置'}`);
    log.info(`   dashboard → GET / (user: ${cfg.dashboard.user})`);
  });

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${sig}, 准备关闭...`);
    server.close();
    strategy.stop();
    trader.stop?.();
    const deadline = Date.now() + 10_000;
    while (strategy.hasPendingTrades() && Date.now() < deadline) {
      log.info('等待 pending trades 完成...');
      await new Promise(r => setTimeout(r, 500));
    }
    if (strategy.hasPendingTrades()) {
      log.warn('超时仍有 pending trades, 强制退出 (检查 dashboard/db 残留持仓!)');
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
