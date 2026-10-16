import { describe, expect, test } from 'bun:test';
import { Box, render } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import React from 'react';
import { AppProvider, DRAFT_NOTE, useDraft } from './app-context.tsx';
import { saveDrafts, loadDrafts } from './drafts.ts';
import { KeymapProvider } from './keymap.tsx';
import { TextArea } from './widgets.tsx';

const h = React.createElement;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

// Just what AppProvider touches: no claude, no tmux, no real run.
const fakeHq = (dir: string) => ({ store: { dir }, on() {}, off() {}, messages: [], notices: [], agents: new Map(), version: 0 }) as never;

function Box1({ probe }: { probe: { value?: string; set?: (v: string) => void } }) {
  const d = useDraft('composer:x');
  probe.value = d.value;
  probe.set = d.set;
  return h(TextArea, { id: 'composer', value: d.value, onChange: d.set, width: 60, rows: 2, note: d.recovered ? DRAFT_NOTE : undefined });
}

describe('composer draft after reconnecting', () => {
  test('a run with drafts.json shows the draft and the note at once; typing keeps it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-run-'));
    saveDrafts(dir, { 'composer:x': 'tarea a medias' });
    const probe: { value?: string; set?: (v: string) => void } = {};
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    let out = '';
    stdout.on('data', (d) => (out += String(d)));
    const inst = render(h(KeymapProvider, { children: h(AppProvider, { initialHq: fakeHq(dir), children: h(Box, { width: 80, height: 10 }, h(Box1, { probe })) }) }), {
      stdin: stdin as never,
      stdout: stdout as never,
      stderr: stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    });
    await sleep(50);
    expect(probe.value).toBe('tarea a medias');
    expect(strip(out)).toContain('tarea a medias');
    expect(strip(out)).toContain('Borrador recuperado');
    probe.set!('tarea a medias, seguida');
    await sleep(20);
    inst.unmount(); // flushes the pending write
    expect(loadDrafts(dir)).toEqual({ 'composer:x': 'tarea a medias, seguida' });
    fs.rmSync(dir, { recursive: true });
  });
});
