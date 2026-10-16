import { describe, expect, test } from 'bun:test';
import { Box, render } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import React from 'react';
import { ReplyPopup } from './App.tsx';
import { AppProvider } from './app-context.tsx';
import { g } from './glyphs.ts';
import { KeymapProvider, MODAL_GUARD_MS } from './keymap.tsx';
import { picks } from './pick.ts';

const h = React.createElement;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

type Calls = { reply: [string, string][]; notice: [string, boolean][] };

// Only what ReplyPopup and AppProvider touch: no claude, no tmux, no real run.
function fakeHq(calls: Calls, msg?: object, notice?: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-reply-'));
  return {
    store: { dir },
    on() {},
    off() {},
    version: 0,
    messages: msg ? [msg] : [],
    notices: notice ? [notice] : [],
    agents: new Map([['cto', { id: 'cto', role: { name: 'CTO' } }]]),
    answerOf: () => undefined,
    reply: (id: string, body: string) => calls.reply.push([id, body]),
    answerNotice: (id: string, ok: boolean) => calls.notice.push([id, ok]),
  } as never;
}

function mount(hq: never, target: object) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 40 });
  let out = '';
  stdout.on('data', (d) => (out += String(d)));
  const inst = render(h(KeymapProvider, { children: h(AppProvider, { initialHq: hq, children: h(Box, { width: 100, height: 40 }, h(ReplyPopup, { target, width: 100, height: 40 })) }) }), {
    stdin: stdin as never,
    stdout: stdout as never,
    stderr: stdout as never,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });
  return {
    press: async (s: string, wait = 40) => (stdin.write(s), await sleep(wait)),
    // Last painted popup (from its title), flattened.
    frame: () => strip(out).slice(strip(out).lastIndexOf(`${g.sep} CTO ${g.sep}`)).replace(/[│╭╮╰╯─\s]+/g, ' '),
    unmount: () => inst.unmount(),
  };
}

const question = { id: 'm1', ts: 0, from: 'cto', to: 'user', type: 'question', body: '¿SQLite o Postgres?', options: ['Postgres', 'SQLite (recomendado)'] };

describe('reply popup: choose, then confirm', () => {
  test('a number only selects and previews; ↵ (after the guard) sends «opción»', async () => {
    const calls: Calls = { reply: [], notice: [] };
    const t = mount(fakeHq(calls, question), { msg: question });
    await sleep(MODAL_GUARD_MS + 40);
    let f = t.frame();
    expect(f).toContain('SQLite recomendada');
    expect(f).not.toContain('(recomendado)');
    expect(f).toContain('(Elige una opción o escribe)');
    await t.press('\r'); // nothing chosen: nothing sent
    expect(calls.reply).toEqual([]);
    await t.press('1');
    expect(calls.reply).toEqual([]);
    f = t.frame();
    expect(f).toContain('«SQLite»');
    await t.press('\r'); // inside the guard after a key pick: ignored
    expect(calls.reply).toEqual([]);
    await sleep(MODAL_GUARD_MS);
    await t.press('\r');
    expect(calls.reply).toEqual([['m1', 'SQLite']]);
    t.unmount();
  });

  test('Esc closes without sending and keeps the selection', async () => {
    picks.clear();
    const calls: Calls = { reply: [], notice: [] };
    const t = mount(fakeHq(calls, question), { msg: question });
    await sleep(MODAL_GUARD_MS + 40);
    await t.press('\x1b[B'); // cursor to 2
    await t.press(' '); // select Postgres
    await t.press('\x1b', 80);
    expect(calls.reply).toEqual([]);
    expect(picks.get('m1')).toBe('Postgres');
    t.unmount();
  });

  test('decisions: A only selects; the consequence shows; ↵ confirms', async () => {
    const calls: Calls = { reply: [], notice: [] };
    const alert = { id: 'n1', kind: 'hire', from: 'cto', role: 'qa', text: 'para probar' };
    const t = mount(fakeHq(calls, undefined, alert), { alert });
    await sleep(MODAL_GUARD_MS + 40);
    await t.press('a');
    expect(calls.notice).toEqual([]);
    const f = t.frame();
    expect(f).toContain('consume cuota');
    expect(f).toContain('Confirmar: aceptar (↵)');
    await sleep(MODAL_GUARD_MS);
    await t.press('\r');
    expect(calls.notice).toEqual([['n1', true]]);
    t.unmount();
  });
});
