import { describe, expect, test } from 'bun:test';
import { render } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import React from 'react';
import { App } from './App.tsx';
import { MODAL_GUARD_MS } from './keymap.tsx';
import { picks } from './pick.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

// A pending decision in a fake session (no claude, no tmux, no real run).
function fakeHq(kind: 'hire' | 'bypass', calls: [string, boolean][]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-alt-'));
  return {
    runId: 'fake-run',
    cwd: dir,
    permMode: 'auto',
    profile: 'max',
    store: { dir },
    on() {},
    off() {},
    version: 0,
    messages: [],
    notices: [{ id: 'n1', kind, from: 'cto', role: 'qa', text: 'para probar' }],
    agents: new Map([['cto', { id: 'cto', status: 'idle', role: { name: 'CTO', color: 'cyan' }, timeline: [] }]]),
    answerOf: () => undefined,
    answerNotice: (id: string, ok: boolean) => calls.push([id, ok]),
  } as never;
}

describe('Alt+A / Alt+R never act on an alert by themselves', () => {
  for (const kind of ['hire', 'bypass'] as const)
    test(`${kind}: Alt+A opens the popup with «aceptar» chosen; nothing runs until ↵`, async () => {
      picks.clear();
      const calls: [string, boolean][] = [];
      const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
      const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 40 });
      let out = '';
      stdout.on('data', (d) => (out += String(d)));
      const inst = render(React.createElement(App, { initialHq: fakeHq(kind, calls), initialTab: 'roles' }), {
        stdin: stdin as never,
        stdout: stdout as never,
        stderr: stdout as never,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      });
      await sleep(100);
      stdin.write('\x1ba'); // Alt+A
      await sleep(MODAL_GUARD_MS + 60);
      expect(calls).toEqual([]);
      expect(picks.get('n1')).toBe('accept');
      expect(strip(out)).toContain('Confirmar: aceptar (↵)');
      stdin.write('\r');
      await sleep(60);
      expect(calls).toEqual([['n1', true]]);
      inst.unmount();
    });
});
