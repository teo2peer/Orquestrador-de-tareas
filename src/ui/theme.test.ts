import { describe, expect, test } from 'bun:test';
import { asciiMode, glyphs, safeText } from './glyphs.ts';
import { c, detectTheme, fgOn, isTruecolor, reducedMotion } from './theme.ts';

describe('theme', () => {
  test('ORQ_THEME wins, then COLORFGBG background', () => {
    expect(detectTheme({ ORQ_THEME: 'light', COLORFGBG: '15;0' })).toBe('light');
    expect(detectTheme({ COLORFGBG: '0;15' })).toBe('light');
    expect(detectTheme({ COLORFGBG: '15;0' })).toBe('dark');
    expect(detectTheme({})).toBe('dark');
  });

  test('c() gives hex on truecolor, Bright ANSI names on dark ANSI-16', () => {
    expect(c('primary', { theme: 'dark', truecolor: true })).toBe('#4fc3f7');
    expect(c('danger', { theme: 'dark', truecolor: false })).toBe('redBright');
    expect(c('success', { theme: 'light', truecolor: true })).toBe('#1a7f37');
    expect(isTruecolor({ COLORTERM: 'truecolor' })).toBe(true);
    expect(isTruecolor({ COLORTERM: '' })).toBe(false);
  });

  test('fgOn picks a readable text colour for a fill', () => {
    for (const bg of ['green', 'yellow', 'cyan', 'cyanBright', 'redBright', 'white']) expect(fgOn(bg)).toBe('black');
    for (const bg of ['red', 'blue', 'magenta']) expect(fgOn(bg)).toBe('whiteBright');
    expect(fgOn('#4fc3f7')).toBe('black');
    expect(fgOn('#264f78')).toBe('whiteBright');
  });

  test('reducedMotion: ORQ_REDUCED_MOTION, --reduce-motion or a screen reader', () => {
    expect(reducedMotion({ ORQ_REDUCED_MOTION: '1' }, [])).toBe(true);
    expect(reducedMotion({}, ['bun', 'cli.tsx', '--reduce-motion'])).toBe(true);
    expect(reducedMotion({ INK_SCREEN_READER: 'true' }, [])).toBe(true);
    expect(reducedMotion({}, [])).toBe(false);
  });

  test('surface: opaque overlay background with readable text', () => {
    expect(c('surface', { theme: 'dark', truecolor: true })).toBe('#1c1c1c');
    expect(c('surface', { theme: 'light', truecolor: false })).toBe('white');
    expect(fgOn(c('surface', { theme: 'dark', truecolor: true }))).toBe('whiteBright');
    expect(fgOn(c('surface', { theme: 'light', truecolor: true }))).toBe('black');
  });
});

describe('glyphs', () => {
  test('ASCII when forced or when the locale is not UTF-8', () => {
    expect(asciiMode({ ORQ_ASCII: '1', LANG: 'es_ES.UTF-8' })).toBe(true);
    expect(asciiMode({ LANG: 'es_ES.UTF-8' })).toBe(false);
    expect(asciiMode({ LC_ALL: 'C', LANG: 'es_ES.UTF-8' })).toBe(true);
    expect(asciiMode({})).toBe(true);
  });

  test('every glyph has a pure ASCII fallback', () => {
    for (const [k, v] of Object.entries(glyphs(true))) expect([k, /^[\x20-\x7e]+$/.test(v)]).toEqual([k, true]);
  });

  test('safeText swaps problematic symbols and keeps letters', () => {
    expect(safeText('♛ Dirección', false)).toBe('◆ Dirección');
    expect(safeText('＋ Nuevo', false)).toBe('+ Nuevo');
    expect(safeText('■ Empresa', true)).toBe('* Empresa');
    expect(safeText('⚠ Ojo', true)).toBe('! Ojo');
  });
});
