/**
 * BFF 进程入口：严格校验配置后启动，并处理优雅退出。
 * 配置错误必须让进程明确失败，而不是带着不安全默认值启动。
 */

import { ConfigError, describeConfig, loadConfig } from './config.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[parrot-webui] 配置错误：${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const app = buildServer(config);

  // 有界会话清理：定期回收过期会话/预登录，避免内存随匿名访问增长
  const sweeper = setInterval(() => {
    app.webui.store.sweep();
  }, 60_000);
  sweeper.unref();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void (async () => {
        app.log.info({ signal }, '正在优雅退出');
        try {
          await app.close();
          process.exit(0);
        } catch (error) {
          app.log.error({ err: String(error) }, '退出时发生错误');
          process.exit(1);
        }
      })();
    });
  }

  try {
    await app.listen({ port: config.port, host: config.bindHost });
    app.log.info(
      { config: describeConfig(config), instanceName: config.instanceName },
      'parrot-webui 已启动（对外只能通过既有域名的 /webui/ 访问）',
    );
  } catch (error) {
    app.log.error({ err: String(error) }, '启动失败');
    process.exit(1);
  }
}

void main();
