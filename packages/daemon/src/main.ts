import { fileURLToPath } from 'node:url';
import { DeepSeekClient, loadConfig } from './deepseek-client.ts';
import { FsStorage, atlasHome } from './fs-storage.ts';
import { AtlasDaemon } from './server.ts';

const config = await loadConfig();
const home = atlasHome();
const daemon = new AtlasDaemon({
  model: new DeepSeekClient(config),
  home,
  port: config.port ?? 7788,
  retryIntervalMs: 30_000,
  storageFactory: (sessionId) => new FsStorage(sessionId, home),
  webDir: process.env.ATLAS_WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url)),
});
const port = await daemon.start();
console.log(`thought-atlas daemon listening on http://127.0.0.1:${port}`);

const shutdown = () => {
  void daemon.stop().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);