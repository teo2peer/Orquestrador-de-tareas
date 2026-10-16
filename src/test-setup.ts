// Preloaded by `bun test` (bunfig.toml), before any module reads its environment:
// tests never write to the real ~/.orq nor touch the real orq tmux server.
import { afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Always a fresh temporary home, unless a test home is given explicitly.
const owned = !process.env.ORQ_TEST_HOME;
const home = process.env.ORQ_TEST_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'orq-test-home-'));
process.env.ORQ_HOME = home;
process.env.ORQ_USAGE_FILE = path.join(home, 'usage.json');
// Always a private tmux server for this process, whatever was inherited (tmux.ts reads it at import).
const socket = `orq-test-${process.pid}`;
process.env.ORQ_TMUX_SOCKET = socket;
// Guarded tmux: only sessions of runs created by this process (tmux.ts).
process.env.ORQ_TEST = '1';

const cleanup = () => {
  // Only the server this setup created.
  spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  if (owned) fs.rmSync(home, { recursive: true, force: true });
};
try {
  // A global hook in the preload runs once, after every test file.
  afterAll(cleanup);
} catch {
  // Preloaded outside the test runner (e.g. `bun --preload`): clean up on exit.
  process.on('exit', cleanup);
}
