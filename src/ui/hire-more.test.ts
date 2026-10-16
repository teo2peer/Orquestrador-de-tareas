import { describe, expect, test } from 'bun:test';
import { Box, render } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import React from 'react';
import { AppProvider, useApp } from './app-context.tsx';
import { freeRoles } from './hire-list.ts';
import { KeymapProvider, MODAL_GUARD_MS } from './keymap.tsx';
import { HireModal } from './Office.tsx';

const h = React.createElement;
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

// In-memory session: `hire` is a spy (no claude, no tmux, no real run).
function fakeHq(hired: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-hire-'));
  const hq = {
    runId: 'fake',
    store: { dir },
    on() {},
    off() {},
    version: 0,
    messages: [],
    notices: [],
    agents: new Map<string, unknown>(),
    hire(r: { id: string }) {
      hired.push(r.id);
      hq.agents.set(r.id, {});
    },
  };
  return hq as never;
}

const role = (id: string, pack?: string) => ({ id, name: id.toUpperCase(), title: id, accessory: 'none', color: 'cyan', writes: id !== 'qa', description: `Rol ${id} de prueba`, prompt: '', scope: 'global' as const, file: '', pack });
const LIBRARY = [role('frontend'), { ...role('backend'), name: 'Backend Developer' }, role('qa'), role('dba', 'acme'), role('devops', 'acme'), { ...role('k8s-ops', 'acme'), name: 'K8s Ops' }];

function mount(hired: string[], closed: string[], initial?: string) {
  const probe: { free?: string[] } = {};
  function Probe() {
    const { hq } = useApp();
    probe.free = hq ? freeRoles(LIBRARY, (hq as any).agents.keys()).map((r) => r.id) : [];
    return h(HireModal, { width: 80, height: 24, onClose: () => closed.push('esc'), library: LIBRARY, initial });
  }
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  let out = '';
  stdout.on('data', (d) => (out += String(d)));
  const inst = render(h(KeymapProvider, { children: h(AppProvider, { initialHq: fakeHq(hired), children: h(Box, { width: 80, height: 24 }, h(Probe)) }) }), {
    stdin: stdin as never,
    stdout: stdout as never,
    stderr: stdout as never,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });
  return {
    probe,
    press: async (s: string, wait = 40) => (stdin.write(s), await sleep(wait)),
    frame: () => strip(out).slice(strip(out).lastIndexOf('Contratar ·')),
    unmount: () => inst.unmount(),
  };
}

describe('«Más…» of Contratar', () => {
  test('a filter with no match says so; Esc closes without hiring', async () => {
    const hired: string[] = [];
    const closed: string[] = [];
    const t = mount(hired, closed);
    await sleep(MODAL_GUARD_MS + 40);
    for (const ch of 'zzqx') await t.press(ch);
    expect(t.frame()).toContain('Ningún rol coincide');
    for (let i = 0; i < 4; i++) await t.press('\x7f');
    for (const ch of 'dev') await t.press(ch);
    expect(t.frame()).toContain('DEVOPS');
    expect(t.frame()).not.toContain('FRONTEND');
    await t.press('\x1b', 60);
    expect(closed).toEqual(['esc']);
    expect(hired).toEqual([]);
    t.unmount();
  });

  test('Space only selects; ↵ hires and the list updates without closing', async () => {
    const hired: string[] = [];
    const closed: string[] = [];
    const t = mount(hired, closed);
    await sleep(MODAL_GUARD_MS + 40);
    const before = t.probe.free!;
    expect(t.frame()).toContain('acme');
    await t.press(' ');
    expect(hired).toEqual([]);
    expect(t.frame()).toContain('Contratar ');
    await t.press('\r', 60); // right after picking: ignored (guard)
    expect(hired).toEqual([]);
    await sleep(MODAL_GUARD_MS);
    await t.press('\r', 60);
    expect(hired).toHaveLength(1);
    expect(before).toContain(hired[0]!);
    expect(t.probe.free).not.toContain(hired[0]!);
    expect(closed).toEqual([]);
    t.unmount();
  });
});

describe('«Más…» filter and preselection', () => {
  const type = async (t: ReturnType<typeof mount>, text: string) => {
    for (const ch of text) await t.press(ch === ' ' ? ' ' : ch, 20);
  };
  test('«k8s»: j/k and digits are text once a filter is typed', async () => {
    const t = mount([], []);
    await sleep(MODAL_GUARD_MS + 40);
    await type(t, 'k8s');
    const f = t.frame();
    expect(f).toContain('Filtro: k8s');
    expect(f).toContain('K8s Ops');
    expect(f).not.toContain('Backend Developer');
    t.unmount();
  });
  test('«backend dev»: Space is text in a filter', async () => {
    const t = mount([], []);
    await sleep(MODAL_GUARD_MS + 40);
    await type(t, 'backend dev');
    const f = t.frame();
    expect(f).toContain('Filtro: backend dev');
    expect(f).toContain('Backend Developer');
    expect(f).not.toContain('K8s Ops');
    t.unmount();
  });
  test('↵ on a row with nothing picked only picks it; a chip of the bar arrives preselected', async () => {
    const hired: string[] = [];
    let t = mount(hired, []);
    await sleep(MODAL_GUARD_MS + 40);
    await t.press('\r', 60);
    expect(hired).toEqual([]);
    expect(t.frame()).toContain('Contratar FRONTEND (↵)');
    t.unmount();
    t = mount(hired, [], 'dba');
    await sleep(MODAL_GUARD_MS + 40);
    expect(t.frame()).toContain('Contratar DBA (↵)');
    await t.press('\r', 60);
    expect(hired).toEqual(['dba']);
    t.unmount();
  });
});

describe('«Más…» filter takes whole chunks', () => {
  test('several characters at once (fast typing / unbracketed paste) go to the filter', async () => {
    const t = mount([], []);
    await until(() => t.frame().includes('Filtro:'));
    await sleep(MODAL_GUARD_MS);
    await t.press('qa', 0);
    await until(() => t.frame().includes('Filtro: qa'));
    expect(t.frame()).toContain('QA');
    expect(t.frame()).not.toContain('FRONTEND');
    await t.press('\x15', 0); // Ctrl+U clears
    await until(() => !t.frame().includes('Filtro: qa'));
    await t.press('k8s\nops', 0);
    await until(() => t.frame().includes('Filtro: k8s ops'));
    t.unmount();
  });
  test('a bracketed paste goes into the filter exactly once', async () => {
    const t = mount([], []);
    await until(() => t.frame().includes('Filtro:'));
    await sleep(MODAL_GUARD_MS);
    await t.press('\x1b[200~back\nend\x1b[201~', 0);
    await until(() => t.frame().includes('Filtro: back end'));
    await sleep(60); // a second delivery would show up by now
    expect(t.frame()).toContain('Filtro: back end█');
    expect(t.frame()).not.toContain('back endback end');
    t.unmount();
  });
});
