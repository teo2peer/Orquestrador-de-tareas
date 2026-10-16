import { describe, expect, test } from 'bun:test';
import { Box, render } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import React from 'react';
import { g } from './glyphs.ts';
import { KeymapProvider, MODAL_GUARD_MS } from './keymap.tsx';
import { ageText, deferred, fmtTokens, loadPrefs, resumeAdvice, savePrefs } from './prefs.ts';
import type { ResumeEstimate } from '../resume.ts';
import { ResumeDialog } from './Sessions.tsx';

const h = React.createElement;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

function mount(el: React.ReactElement) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 });
  let out = '';
  stdout.on('data', (d) => (out += String(d)));
  const inst = render(el, { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false, debug: true });
  return {
    press: async (s: string, wait = 40) => (stdin.write(s), await sleep(wait)),
    // Last painted dialog, flattened (wrapped lines and borders joined by single spaces).
    frame: () => strip(out).slice(strip(out).lastIndexOf('╭')).replace(/[│╭╮╰╯─\s]+/g, ' '),
    unmount: () => inst.unmount(),
  };
}

const run = { runId: 'r1', title: 'Refactor del modo por partes', startedAt: 0 } as never;
type Est = ResumeEstimate;
const COLD: Est = { full: 180_000, fullWarm: 20_000, fullCold: 180_000, light: 9000, lightPerAgent: 3000, agents: [], recommended: 'light', reason: { kind: 'cold', maxAgeMs: 3 * 3_600_000 } };
const WARM: Est = { ...COLD, full: 20_000, recommended: 'full', reason: { kind: 'warm', maxAgeMs: 12 * 60_000 } };
// `est: null` = the estimate is still being computed (the recommendation is always there).
const dialog = (initial: 'light' | 'full', onResume: (m: string) => void, est: Est = COLD, pending = false) =>
  h(KeymapProvider, { children: h(Box, { width: 100, height: 30 }, h(ResumeDialog, { run, rec: est, est: pending ? null : est, initial, width: 100, height: 30, onClose: () => onResume('close'), onResume })) });

describe('resume dialog', () => {
  test('cold session: Ligera recommended and preselected, with the reason; ↓ + ↵ resumes full', async () => {
    const picked: string[] = [];
    const t = mount(dialog(COLD.recommended, (m) => picked.push(m)));
    await sleep(MODAL_GUARD_MS + 30);
    const f = t.frame();
    expect(f).toContain('¿Cómo reanudar «Refactor del modo por partes»?');
    expect(f).toContain(`${g.radioOn} 1 Ligera`);
    expect(f).toMatch(/Ligera[^│]*recomendada/);
    expect(f).toContain('Sesión de hace 3 h: Ligera es más barata');
    expect(f).toContain('Ligera · ≈ 9 k tokens en total (≈ 3 k por agente)');
    expect(f).toContain('Cifras aproximadas.');
    expect(f).toContain(`≈ 180 k tokens en total ${g.sep} más caro`);
    await t.press('\x1b[B');
    expect(t.frame()).toContain(`${g.radioOn} 2 Completa`);
    await t.press('\r');
    expect(picked).toEqual(['full']);
    t.unmount();
  });

  test('warm session: Completa recommended and preselected, warm estimate without «más caro»', async () => {
    const t = mount(dialog(WARM.recommended, () => {}, WARM));
    await sleep(60);
    const f = t.frame();
    expect(f).toContain(`${g.radioOn} 2 Completa`);
    expect(f).toMatch(/Completa[^│]*recomendada/);
    expect(f).toContain('≈ 20 k tokens en total');
    expect(f).not.toContain('más caro');
    expect(f).toContain('Sesión de hace 12 min: la caché sigue activa, Completa sale más barata');
    t.unmount();
  });
});

describe('resume dialog while estimating', () => {
  test('opens at once with the recommendation and the reason; figures read «calculando…»', async () => {
    const t = mount(dialog(WARM.recommended, () => {}, WARM, true));
    await sleep(60);
    const f = t.frame();
    expect(f).toContain(`${g.radioOn} 2 Completa ${g.sep} calculando…`);
    expect(f).toContain(`Ligera ${g.sep} calculando…`);
    expect(f).toContain('la caché sigue activa');
    t.unmount();
  });
});

describe('resume advice', () => {
  test('12 min (warm), 3 h (cold), unknown', () => {
    expect(resumeAdvice({ kind: 'warm', maxAgeMs: 12 * 60_000 })).toBe('Sesión de hace 12 min: la caché sigue activa, Completa sale más barata');
    expect(resumeAdvice({ kind: 'cold', maxAgeMs: 3 * 3_600_000 })).toBe('Sesión de hace 3 h: Ligera es más barata');
    expect(resumeAdvice({ kind: 'unknown' })).toBe('Sin datos de antigüedad: Ligera es la opción segura');
    expect(ageText(3 * 24 * 3_600_000)).toBe('3 días');
    // floor: a warm cache under an hour never reads as «1 h».
    expect(ageText(59 * 60_000)).toBe('59 min');
    expect(ageText(60 * 60_000 - 1)).toBe('59 min');
    expect(ageText(60 * 60_000)).toBe('1 h');
  });
});

describe('prefs', () => {
  test('merge on save, survive a broken file (temp file, never ~/.orq)', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orq-prefs-')), 'ui.json');
    savePrefs({ resumeMode: 'full' }, file);
    savePrefs({ profile: 'saver' }, file);
    expect(loadPrefs(file)).toEqual({ resumeMode: 'full', profile: 'saver' });
    fs.writeFileSync(file, JSON.stringify({ profile: 'turbo', resumeMode: 'half' }));
    expect(loadPrefs(file)).toEqual({});
    fs.writeFileSync(file, '{');
    expect(loadPrefs(file)).toEqual({});
    fs.rmSync(path.dirname(file), { recursive: true });
  });
  test('token counts', () => {
    expect(fmtTokens(950)).toBe('950');
    expect(fmtTokens(3_200)).toBe('3 k');
    expect(fmtTokens(1_234_567)).toBe('1,2 M');
  });
});

describe('deferred estimate', () => {
  test('cancel (close / resume / unmount) drops the pending estimate; a new run replaces the old one', async () => {
    const d = deferred();
    const ran: string[] = [];
    d.run(() => ran.push('a'));
    expect(d.pending).toBe(true);
    d.cancel();
    await sleep(10);
    expect(ran).toEqual([]);
    expect(d.pending).toBe(false);
    d.run(() => ran.push('b'));
    d.run(() => ran.push('c'));
    await sleep(10);
    expect(ran).toEqual(['c']);
  });
});
