import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HQ } from './hq.ts';
import { ORQ_HOME, REAL_ORQ_HOME, assertSafeHome } from './paths.ts';
import { forgetRun, stopRunSessions } from './runs.ts';
import * as tmux from './tmux.ts';
import { usageFile } from './usage.ts';

describe('test isolation (test-setup.ts)', () => {
  test('tests never use the real ~/.orq nor the real tmux server', () => {
    expect(path.resolve(ORQ_HOME)).not.toBe(path.resolve(path.join(os.homedir(), '.orq')));
    expect(fs.realpathSync(ORQ_HOME).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(usageFile().startsWith(REAL_ORQ_HOME)).toBe(false);
    expect(process.env.ORQ_TEST).toBe('1');
    expect(process.env.ORQ_TMUX_SOCKET).not.toBe('orq');
  });
});

describe('tmux guard', () => {
  test('sessions and runs of other processes are refused', () => {
    const foreign = 'orq-20260101-120000-cto';
    expect(() => tmux.killSession(foreign)).toThrow('refusing to touch foreign session "orq-20260101-120000-cto"');
    expect(() => tmux.sendKeys(`${foreign}:claude`, ['Enter'])).toThrow(/foreign session/);
    expect(() => tmux.sendLiteral(foreign, '/clear')).toThrow(/foreign session/);
    expect(() => tmux.paste(foreign, 'x')).toThrow(/foreign session/);
    expect(() => tmux.newSession(foreign, os.tmpdir(), 'true')).toThrow(/foreign session/);
    expect(() => tmux.killSession('orq-whatever')).toThrow(/foreign session/);
    expect(() => stopRunSessions('20260101-120000')).toThrow('refusing to touch foreign run "20260101-120000"');
    expect(() => forgetRun('20260101-120000')).toThrow(/foreign run/);
  });

  test('sessions of a run created in this process are allowed', () => {
    const hq = new HQ({ roles: [], permMode: 'auto', cwd: os.tmpdir(), resume: { runId: '19990101-000077', cwd: os.tmpdir(), dir: '', permMode: 'auto', startedAt: 0, updatedAt: 0, agents: [] } });
    expect(() => tmux.killSession(`orq-${hq.runId}-cto`)).not.toThrow();
    expect(() => tmux.sendKeys(`orq-${hq.runId}-cto:claude`, ['C-u'])).not.toThrow();
    expect(() => stopRunSessions(hq.runId)).not.toThrow();
    expect(() => forgetRun(hq.runId)).not.toThrow();
  });
});

describe('raw tmux commands', () => {
  test('read-only commands pass; writes need an own session target; kill-server is refused', () => {
    expect(() => tmux.listSessions()).not.toThrow();
    expect(() => tmux.captureText('orq-20260101-120000-cto:claude')).not.toThrow();
    expect(() => tmux.tmux(['send-keys', '-t', 'orq-20260101-120000-cto:claude', 'Enter'])).toThrow(/foreign session/);
    expect(() => tmux.tmux(['kill-server'])).toThrow(/without an own session target/);
    expect(() => tmux.tmux(['has-session', '-t', 'x', ';', 'kill-session', '-t', 'orq-20260101-120000-a'])).toThrow(/foreign session/);
  });
});

describe('test-setup', () => {
  test('replaces an inherited real tmux socket and home', () => {
    const root = path.resolve(import.meta.dir, '..');
    const p = Bun.spawnSync(
      [process.execPath, '--preload', './src/test-setup.ts', '-e', 'console.log(JSON.stringify([process.env.ORQ_TMUX_SOCKET, process.env.ORQ_HOME, process.env.ORQ_USAGE_FILE]))'],
      { cwd: root, env: { ...process.env, ORQ_TMUX_SOCKET: 'orq', ORQ_HOME: REAL_ORQ_HOME, ORQ_TEST_HOME: '' }, stdout: 'pipe' },
    );
    const [socket, home, usage] = JSON.parse(p.stdout.toString()) as string[];
    expect(socket).toMatch(/^orq-test-\d+$/);
    expect(home).not.toBe(REAL_ORQ_HOME);
    expect(fs.realpathSync(path.dirname(home!))).toBe(fs.realpathSync(os.tmpdir()));
    expect(usage).toBe(path.join(home!, 'usage.json'));
    expect(fs.existsSync(home!)).toBe(false); // cleaned on exit
  });
});

describe('safe start', () => {
  test('ORQ_SAFE=1 refuses the real ~/.orq', () => {
    expect(() => assertSafeHome({ ORQ_SAFE: '1' }, REAL_ORQ_HOME)).toThrow(/refuses to use the real/);
    expect(() => assertSafeHome({ ORQ_SAFE: '1' }, `${REAL_ORQ_HOME}/`)).toThrow(/refuses/);
    expect(() => assertSafeHome({ ORQ_SAFE: '1' }, os.tmpdir())).not.toThrow();
    expect(() => assertSafeHome({}, REAL_ORQ_HOME)).not.toThrow();
  });

  test('the app exits with a clear message', () => {
    const p = Bun.spawnSync([process.execPath, '-e', "import('./src/paths.ts').then((m) => m.ensureHome())"], {
      cwd: path.resolve(import.meta.dir, '..'),
      env: { ...process.env, ORQ_SAFE: '1', ORQ_HOME: REAL_ORQ_HOME },
      stderr: 'pipe',
    });
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain('ORQ_SAFE=1 refuses to use the real');
  });
});

