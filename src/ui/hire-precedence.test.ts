import { describe, expect, test } from 'bun:test';
import { render } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import React from 'react';
import { ORQ_HOME } from '../paths.ts';
import { App } from './App.tsx';
import { MODAL_GUARD_MS } from './keymap.tsx';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits for a condition instead of a fixed time (deterministic under load). */
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for the condition');
    await sleep(10);
  }
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

// Enough roles in the (temporary, test-setup) library for the bar to need «Más…».
function seedLibrary() {
  const dir = path.join(ORQ_HOME, 'roles');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, `rol-${i}.md`), `---\nid: rol-${i}\nname: Rol de prueba ${i}\ncolor: cyan\n---\nPrueba.\n`);
}

// In-memory session that can announce changes (a new alert).
function fakeHq() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-prec-'));
  const listeners: (() => void)[] = [];
  const hq = {
    runId: 'fake-run',
    cwd: dir,
    permMode: 'auto',
    profile: 'max',
    store: { dir },
    version: 0,
    messages: [],
    notices: [] as object[],
    agents: new Map([['cto', { id: 'cto', status: 'idle', role: { id: 'cto', name: 'CTO', title: 'CTO', color: 'cyan', accessory: 'none', writes: false }, timeline: [], inbox: [], children: [], sessionId: 'abcdef12', tmux: 'fake-cto', stopBlocks: 0 }]]),
    on: (_: string, f: () => void) => void listeners.push(f),
    off() {},
    answerOf: () => undefined,
    hire() {},
    alert() {
      hq.notices.push({ id: 'n1', kind: 'info', from: 'cto', text: 'nuevo aviso' });
      hq.version++;
      for (const f of listeners) f();
    },
  };
  return hq;
}

describe('hire bar keeps its keys', () => {
  test('bar open + a new alert ⇒ Tab still opens «Más…»', async () => {
    seedLibrary();
    const hq = fakeHq();
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 });
    let out = '';
    stdout.on('data', (d) => (out += String(d)));
    const inst = render(React.createElement(App, { initialHq: hq as never, initialTab: 'office' }), {
      stdin: stdin as never,
      stdout: stdout as never,
      stderr: stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    });
    await until(() => strip(out).includes('Contratar'));
    stdin.write('c');
    await until(() => strip(out).includes('Más… (+'));
    hq.alert(); // office/grid re-registers with the alerts footer
    await until(() => strip(out).includes('nuevo aviso'));
    out = '';
    // The first navigation key only reveals the keyboard cursor (app-wide); the second acts.
    stdin.write('\t');
    await until(() => out.length > 0);
    await sleep(MODAL_GUARD_MS);
    stdin.write('\t');
    await until(() => strip(out).includes('roles libres'));
    inst.unmount();
  });
});
