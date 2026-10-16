import { describe, expect, test } from 'bun:test';
import { CARD_H, CARD_W, officeBudget } from './Office.tsx';
import { gridLayout } from './widgets.tsx';

// Cards visible on the office floor for a terminal (no side panel, no alerts, composer closed).
function visibleCards(cols: number, rows: number, cardW: number, cardH: number) {
  const bodyH = rows - (rows < 30 ? 1 : 3) - 1;
  const { floorH } = officeBudget(bodyH, 0, false, false);
  if (floorH < cardH) return 0; // too short: the office falls back to the list
  const { perRow, visibleRows } = gridLayout(cardW, cardH, cols, floorH);
  return perRow * visibleRows;
}

const BEFORE = { w: 34, h: 15 };

describe('compact agent cards', () => {
  test('about 26-28 columns; 7 rows so two rows fit the 80×24 floor', () => {
    expect(CARD_W).toBeGreaterThanOrEqual(26);
    expect(CARD_W).toBeLessThanOrEqual(28);
    expect(CARD_H).toBe(7);
  });
  for (const [cols, rows] of [
    [80, 24],
    [160, 48],
  ] as const)
    test(`${cols}×${rows}: at least twice as many cards visible as before`, () => {
      const before = visibleCards(cols, rows, BEFORE.w, BEFORE.h);
      const after = visibleCards(cols, rows, CARD_W, CARD_H);
      if (process.env.SHOW) console.log(`${cols}×${rows}: antes ${before}, después ${after}`);
      expect(after).toBeGreaterThanOrEqual(Math.max(2, before * 2));
    });
});

import { render } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import React from 'react';
import { App } from './App.tsx';
import { g } from './glyphs.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const agent = (id: string, name: string, extra: object = {}) => ({
  id,
  role: { id, name, title: name, color: 'cyan', accessory: 'none', writes: true, description: '', prompt: '', scope: 'global', file: '' },
  status: 'idle',
  timeline: [],
  inbox: [],
  children: [],
  sessionId: 'abcdef12',
  tmux: `fake-${id}`,
  stopBlocks: 0,
  ...extra,
});

describe('compact card content (AC2)', () => {
  test('name, lead, area, state, waiting with FYIs, task and the blocked/question mark', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-cards-'));
    const hq = {
      runId: 'fake',
      cwd: dir,
      permMode: 'auto',
      profile: 'balanced',
      lead: 'cto',
      store: { dir },
      on() {},
      off() {},
      version: 0,
      messages: [],
      notices: [],
      answerOf: () => undefined,
      effectiveModel: () => 'claude-sonnet-4',
      agents: new Map<string, unknown>([
        ['cto', agent('cto', 'CTO', { status: 'working', task: 'Repartir B7', ctxTokens: 84_000, lastOut: '→ qa: prueba esto' })],
        // No task yet (''), working: the card shows what it is doing (lastTool).
        ['be', agent('be', 'BE', { status: 'working', task: '', lastTool: 'Edit src/x.ts' })],
        ['ui', { ...agent('ui', 'UI', { status: 'waiting', notice: 'pide permiso para Bash' }), role: { ...agent('ui', 'UI').role, area: { paths: ['src/ui'] } } }],
        ['qa', agent('qa', 'QA', { status: 'dormant', inbox: [{}, {}] })],
      ]),
    };
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 160, rows: 40 });
    let out = '';
    stdout.on('data', (d) => (out += String(d)));
    const inst = render(React.createElement(App, { initialHq: hq as never, initialTab: 'office' }), { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false, debug: true });
    await sleep(150);
    const f = strip(out);
    expect(f).toContain('● Tarjetas');
    expect(f).toContain(`${g.star} CTO`);
    expect(f).toContain('● trab'); // the state gives way before ctx in the narrow column
    expect(f).toContain('ctx 84k');
    expect(f).toContain('sonnet');
    expect(f).toContain('• Repartir B7');
    expect(f).toContain('• Edit src/x.ts');
    expect(f).toContain(`UI ${g.area}`);
    expect(f).toContain(`${g.warning} pide permiso`);
    expect(f).toContain('en espera');
    expect(f).toContain('• 2 avisos');
    inst.unmount();
  });
});

import { STATUS as ST, statusAria } from './theme.ts';
describe('waiting reads «te espera»', () => {
  test('label and aria', () => {
    expect(ST.waiting.label).toBe('te espera');
    expect(statusAria('waiting')).toBe('te espera: necesita tu respuesta');
    expect(statusAria('dormant')).toBe('en espera');
  });
});

import { shortModel } from './Office.tsx';
describe('model on the card', () => {
  test('short name only when there is one; nothing for the default', () => {
    expect(shortModel('claude-sonnet-4-5')).toBe('sonnet');
    expect(shortModel(undefined)).toBe('');
  });
});
