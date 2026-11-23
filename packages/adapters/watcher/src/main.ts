import { CodexWatcher, postTurn } from './codex-watcher.ts';

const daemonUrl = process.env.ATLAS_DAEMON_URL ?? 'http://127.0.0.1:7788';
const watcher = new CodexWatcher({
  mode: 'tail',
  deliver: (payload) => postTurn(daemonUrl, payload),
  onTurn: (payload) => {
    console.log(`delivered session=${payload.sessionId} turn=${payload.turnIndex}`);
  },
});
await watcher.start();
console.log(`codex watcher (read-only, tail mode) -> ${daemonUrl}`);

const shutdown = () => {
  watcher.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);