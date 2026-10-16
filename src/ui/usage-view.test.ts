import { describe, expect, test } from 'bun:test';
import { g } from './glyphs.ts';
import { bar, crossings, levelOf, metricViews, resetText, topbarUsage } from './usage-view.ts';

const now = new Date(2026, 9, 13, 15, 0).getTime();
const at = (h: number, m = 0) => new Date(2026, 9, 13, h, m).getTime();
const snap = (five: number, week: number, updatedAt = now - 60_000) => ({
  updatedAt,
  metrics: [
    { key: 'five_hour' as const, label: '5 h', pct: five, resetsAt: at(17, 40) },
    { key: 'seven_day' as const, label: 'Semanal', pct: week, resetsAt: new Date(2026, 9, 19, 9, 0).getTime() },
  ],
});

describe('usage in the top bar', () => {
  test('thresholds', () => {
    expect([levelOf(undefined), levelOf(69), levelOf(70), levelOf(89), levelOf(90)]).toEqual(['none', 'ok', 'warn', 'warn', 'danger']);
  });
  test('variants: full with a bar on the highest, percentages, highest only', () => {
    const u = topbarUsage(snap(62, 31), now);
    expect(u.full).toBe(`5h ${bar(62)} 62% ${g.sep} Sem 31%`);
    expect(u.pcts).toBe(`5h 62% ${g.sep} Sem 31%`);
    expect(u.top).toBe('5h 62%');
    expect(u.critical).toBe(false);
    expect(u.aria).toContain('Ventana de 5 horas, 62 por ciento, se reinicia en 2 horas 40 minutos');
  });
  test('≥70 % gets ⚠; ≥90 % is critical', () => {
    expect(topbarUsage(snap(75, 31), now).top).toBe(`${g.warning} 5h 75%`);
    const u = topbarUsage(snap(20, 93), now);
    expect(u).toMatchObject({ level: 'danger', critical: true, top: `${g.warning} Sem 93%!` });
  });
  test('no data → «Uso —» without warning colour; stale data says how old', () => {
    expect(topbarUsage(null, now)).toMatchObject({ full: 'Uso —', level: 'none', critical: false });
    expect(topbarUsage(snap(62, 31, now - 20 * 60_000), now).pcts).toBe(`5h 62% ${g.sep} Sem 31% (hace 20 min)`);
    expect(topbarUsage(snap(62, 31, now - 20 * 60_000), now).top).toBe('5h 62% ~');
    expect(topbarUsage(snap(62, 31), now).top).toBe('5h 62%');
  });
  test('a window that reset after the data was taken shows —', () => {
    const old = { updatedAt: at(9), metrics: [{ key: 'five_hour' as const, label: '5 h', pct: 80, resetsAt: at(12) }] };
    expect(metricViews(old, now)[0]).toMatchObject({ pct: undefined, level: 'none' });
    expect(topbarUsage(old, now).full).toBe('Uso —');
  });
  test('the 90 % toast fires once per metric and window', () => {
    const seen = new Set<string>();
    expect(crossings(snap(91, 10), now, seen)).toEqual([`${g.warning} Has usado el 90 % de la ventana de 5 h. Se reinicia en 2 h 40 min.`]);
    expect(crossings(snap(95, 10), now, seen)).toEqual([]);
  });
});

describe('time left until the reset', () => {
  const H = 3_600_000;
  const M = 60_000;
  const t = (ms: number) => resetText(now + ms, now);
  test('days, days and hours, hours and minutes, minutes, under a minute', () => {
    expect(t(4 * 24 * H + 5 * H)).toBe('en 4 días');
    expect(t(72 * H)).toBe('en 3 días');
    expect(t(29 * H + 10 * M)).toBe('en 1 día y 5 h');
    expect(t(48 * H)).toBe('en 2 días');
    expect(t(51 * H)).toBe('en 2 días y 3 h');
    expect(t(5 * H + 20 * M)).toBe('en 5 h 20 min');
    expect(t(5 * H)).toBe('en 5 h');
    expect(t(42 * M + 30_000)).toBe('en 42 min');
    expect(t(30_000)).toBe('en menos de 1 min');
  });
  test('screen readers get hours and minutes spelled out', () => {
    expect(resetText(now + 51 * H, now, true)).toBe('en 2 días y 3 horas');
    expect(resetText(now + 1 * H + 1 * M, now, true)).toBe('en 1 hora 1 minuto');
  });
  test('the 90 % toast says how long is left', () => {
    const s = { updatedAt: now - M, metrics: [{ key: 'five_hour' as const, label: '5 h', pct: 92, resetsAt: now + H + 15 * M }] };
    expect(crossings(s, now, new Set())).toEqual([`${g.warning} Has usado el 90 % de la ventana de 5 h. Se reinicia en 1 h 15 min.`]);
  });
});
