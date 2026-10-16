import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyText, osc52, tmuxPassthrough } from './clipboard.ts';
import { DRAFTS_FILE, createDraftStore, draftWriter, loadDrafts, saveDrafts } from './drafts.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orq-drafts-'));

describe('drafts on disk', () => {
  test('round trip; empty drafts are dropped and an empty set removes the file', () => {
    const dir = tmp();
    saveDrafts(dir, { 'composer:cto': 'hola', reply: '' });
    expect(loadDrafts(dir)).toEqual({ 'composer:cto': 'hola' });
    saveDrafts(dir, { 'composer:cto': '' });
    expect(fs.existsSync(path.join(dir, DRAFTS_FILE))).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });
  test('missing dir, missing or broken file → no drafts', () => {
    expect(loadDrafts(undefined)).toEqual({});
    const dir = tmp();
    expect(loadDrafts(dir)).toEqual({});
    fs.writeFileSync(path.join(dir, DRAFTS_FILE), '{nope');
    expect(loadDrafts(dir)).toEqual({});
    fs.writeFileSync(path.join(dir, DRAFTS_FILE), JSON.stringify({ a: 'x', b: 3 }));
    expect(loadDrafts(dir)).toEqual({ a: 'x' });
    fs.rmSync(dir, { recursive: true });
  });
  test('the writer coalesces a burst and flush writes what is pending', () => {
    const dir = tmp();
    const w = draftWriter(dir, 10_000);
    w.schedule({ a: 'h' });
    w.schedule({ a: 'ho' });
    expect(loadDrafts(dir)).toEqual({});
    w.flush();
    expect(loadDrafts(dir)).toEqual({ a: 'ho' });
    fs.rmSync(dir, { recursive: true });
  });
});

describe('draft store', () => {
  test('drafts never leak between runs; loose ones join the first run', () => {
    const [a, b] = [tmp(), tmp()];
    const s = createDraftStore();
    s.set('search:teams', 'loose');
    s.attach(a);
    expect(s.get('search:teams')).toBe('loose');
    s.set('composer:cto', 'del run A');
    s.detach();
    expect(loadDrafts(a)).toEqual({ 'search:teams': 'loose', 'composer:cto': 'del run A' });
    expect(s.get('composer:cto')).toBe('');
    s.attach(b);
    expect(s.get('composer:cto')).toBe('');
    expect(s.get('search:teams')).toBe('');
    s.detach();
    for (const d of [a, b]) fs.rmSync(d, { recursive: true });
  });
  test('attaching a run with a drafts.json shows it at once and bumps the version', () => {
    const dir = tmp();
    saveDrafts(dir, { 'composer:x': 'pendiente' });
    const s = createDraftStore();
    const v = s.version;
    s.attach(dir);
    expect(s.version).toBe(v + 1);
    expect(s.get('composer:x')).toBe('pendiente');
    s.attach(dir); // same run: no reload
    expect(s.version).toBe(v + 1);
    s.detach();
    fs.rmSync(dir, { recursive: true });
  });
  test('saving is atomic (no temp file left behind)', () => {
    const dir = tmp();
    saveDrafts(dir, { a: 'x' });
    expect(fs.readdirSync(dir)).toEqual([DRAFTS_FILE]);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('clipboard', () => {
  const runner = (passthrough: string, pbcopy = true) => {
    const calls: string[][] = [];
    return { calls, run: (cmd: string[]) => (calls.push(cmd), cmd[0] === 'pbcopy' ? { ok: pbcopy, out: '' } : { ok: true, out: passthrough }) };
  };
  test('plain OSC 52 always; tmux passthrough only with allow-passthrough on', () => {
    expect(osc52('hola')).toBe('\x1b]52;c;aG9sYQ==\x07');
    const out: string[] = [];
    let r = runner('off\n');
    expect(copyText('hola', { write: (s) => out.push(s), tty: true, platform: 'linux', env: { TMUX: '/t' }, run: r.run })).toBe(true);
    expect(out).toEqual([osc52('hola')]);
    out.length = 0;
    r = runner('on\n');
    copyText('hola', { write: (s) => out.push(s), tty: true, platform: 'linux', env: { TMUX: '/t' }, run: r.run });
    expect(out).toEqual([osc52('hola'), tmuxPassthrough(osc52('hola'))]);
  });
  test('pbcopy on macOS; false when nothing could work', () => {
    const r = runner('', true);
    expect(copyText('x', { write: () => {}, tty: false, platform: 'darwin', env: {}, run: r.run })).toBe(true);
    expect(r.calls).toEqual([['pbcopy']]);
    expect(copyText('x', { write: () => {}, tty: false, platform: 'darwin', env: {}, run: runner('', false).run })).toBe(false);
    expect(copyText('x', { write: () => {}, tty: false, platform: 'linux', env: {} })).toBe(false);
  });
});
