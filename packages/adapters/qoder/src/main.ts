import { postTurn } from '@thought-atlas/adapter-watcher';
import { QoderWatcher } from './qoder-watcher.ts';

const daemonUrl = process.env.ATLAS_DAEMON_URL ?? 'http://127.0.0.1:7788';
const watcher = new QoderWatcher({
  deliver: (payload) => postTurn(daemonUrl, payload, 20_000),
  onTurn: (payload) => {
    console.log(`delivered session=${payload.sessionId} turn=${payload.turnIndex}`);
  },
});

await watcher.start();
console.log(`qoder watcher (read-only, whitelist) -> ${daemonUrl}`);

const shutdown = () => {
  watcher.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);