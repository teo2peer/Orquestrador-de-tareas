import { describe, expect, test } from 'bun:test';
import { render } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import React from 'react';
import { App } from './App.tsx';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

const agent = (id: string, name: string) => ({
  id,
  role: { id, name, title: name, color: 'cyan', accessory: 'none', writes: true, description: '', prompt: '', scope: 'global', file: '' },
  status: 'idle',
  timeline: [],
  inbox: [],
  children: [],
  sessionId: 'abcdef123456',
  tmux: `fake-${id}`,
  stopBlocks: 0,
  ctxTokens: 84_000,
  model: 'sonnet',
});

// A session that exists only in memory: no claude, no tmux, no real run.
function fakeHq(title: string, provisional = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-office-'));
  return {
    runId: 'fake-run',
    cwd: dir,
    permMode: 'auto',
    profile: 'balanced',
    title,
    titleProvisional: provisional,
    effectiveModel: () => 'sonnet',
    lead: 'cto',
    store: { dir },
    on() {},
    off() {},
    version: 0,
    messages: [],
    notices: [],
    agents: new Map([
      ['cto', agent('cto', 'CTO')],
      ['qa', agent('qa', 'QA')],
    ]),
    answerOf: () => undefined,
  } as never;
}

function frameAt(cols: number, rows: number, provisional = false) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: cols, rows });
  let out = '';
  stdout.on('data', (d) => (out += String(d)));
  const inst = render(React.createElement(App, { initialHq: fakeHq('Refactor del modo por partes y del uso de Claude', provisional), initialTab: 'office' }), {
    stdin: stdin as never,
    stdout: stdout as never,
    stderr: stdout as never,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });
  return { frame: () => strip(out), unmount: () => inst.unmount() };
}

describe('office header renders without overlaps', () => {
  for (const [cols, rows] of [
    [120, 34],
    [80, 24],
  ] as const)
    test(`${cols}×${rows}`, async () => {
      const t = frameAt(cols, rows);
      await sleep(120);
      const lines = t.frame().split('\n');
      const head = lines.find((l) => l.includes('Tarjetas') && l.includes('Contratar'));
      expect(head).toBeDefined();
      // Stats and legend never print on top of each other («…Aurecibido»).
      expect(head!).not.toMatch(/[A-Za-z](enviado|recibido)/);
      expect(head!).toContain('[ + Contratar ]');
      expect([...head!].length).toBeLessThanOrEqual(cols);
      t.unmount();
    });
});

describe('a dormant agent', () => {
  test('reads «en espera» in the office', async () => {
    const hq = fakeHq('x') as any;
    hq.agents.get('qa').status = 'dormant';
    hq.agents.get('qa').ctxTokens = undefined;
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 34 });
    let out = '';
    stdout.on('data', (d) => (out += String(d)));
    const inst = render(React.createElement(App, { initialHq: hq, initialTab: 'office' }), { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false, debug: true });
    await sleep(120);
    expect(strip(out)).toContain('en espera');
    expect(strip(out)).toContain('arranca con'); // truncated in the narrow list column
    inst.unmount();
  });
});

describe('a dormant agent with FYIs', () => {
  test('reads «en espera · N avisos pendientes»', async () => {
    const hq = fakeHq('x') as any;
    const qa = hq.agents.get('qa');
    qa.status = 'dormant';
    qa.ctxTokens = undefined;
    qa.inbox = [{ id: 'm1' }, { id: 'm2' }];
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 160, rows: 40 });
    let out = '';
    stdout.on('data', (d) => (out += String(d)));
    const inst = render(React.createElement(App, { initialHq: hq, initialTab: 'office' }), { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false, debug: true });
    await sleep(120);
    expect(strip(out)).toContain('2 avisos');
    inst.unmount();
  });
});

describe('office header keeps [ + Contratar ]', () => {
  test('80×24 with a long provisional title', async () => {
    const t = frameAt(80, 24, true);
    await sleep(120);
    const head = t.frame().split('\n').find((l) => l.includes('Tarjetas'));
    expect(head).toContain('[ + Contratar ]');
    expect([...head!].length).toBeLessThanOrEqual(80);
    // Too narrow for a readable title: only «(prov.)» and ✎, never «R……».
    expect(head).toContain('(prov.)');
    expect(head).not.toMatch(/ Re?…/);
    t.unmount();
  });
});

describe('a dormant agent shows its model', () => {
  test('effectiveModel before it starts', async () => {
    const hq = fakeHq('x') as any;
    const qa = hq.agents.get('qa');
    qa.status = 'dormant';
    qa.model = undefined;
    hq.agents.get('cto').model = undefined;
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 160, rows: 40 });
    let out = '';
    stdout.on('data', (d) => (out += String(d)));
    const inst = render(React.createElement(App, { initialHq: hq, initialTab: 'office' }), { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false, debug: true });
    await sleep(120);
    expect(strip(out)).toContain('sonnet');
    inst.unmount();
  });
});

describe('compact unavailable', () => {
  test('an agent whose /compact had no effect offers to retry and says why', async () => {
    const hq = fakeHq('x') as any;
    hq.profile = 'saver';
    hq.agents.get('cto').compactFailed = true;
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 160, rows: 40 });
    let out = '';
    stdout.on('data', (d) => (out += String(d)));
    const inst = render(React.createElement(App, { initialHq: hq, initialTab: 'office' }), { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false, debug: true });
    await sleep(100);
    stdin.write('\r'); // first key reveals the cursor
    await sleep(40);
    stdin.write('\r'); // opens the selected agent's panel
    await sleep(120);
    expect(strip(out)).toContain('[ ↓ Reintentar compactar ]');
    // A space always separates the context text from the buttons.
    expect(strip(out)).not.toMatch(/[^ ]\[ ↓ Reintentar/);
    expect(strip(out)).toContain('la última compactación no surtió efecto');
    inst.unmount();
  });
});

describe('list view, dormant agent', () => {
  test('the model comes before the (truncated) note', async () => {
    const hq = fakeHq('x') as any;
    const qa = hq.agents.get('qa');
    qa.status = 'dormant';
    qa.model = undefined;
    qa.ctxTokens = undefined;
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 });
    let out = '';
    stdout.on('data', (d) => (out += String(d)));
    const inst = render(React.createElement(App, { initialHq: hq, initialTab: 'office' }), { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false, debug: true });
    await sleep(120);
    expect(strip(out)).toContain('● Lista');
    expect(strip(out)).toContain('sonnet · arranca');
    inst.unmount();
  });
});
