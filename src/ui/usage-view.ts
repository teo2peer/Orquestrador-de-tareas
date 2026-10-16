// How the Claude usage (src/usage.ts) reads in the top bar and the «Uso de Claude» modal:
// thresholds, the degrading variants of the top-bar label, stale data and reset times.
import type { UsageMetric, UsageSnapshot } from '../usage.ts';
import { g } from './glyphs.ts';

export type UsageLevel = 'none' | 'ok' | 'warn' | 'danger';
/** <70 % normal · 70-89 % warning · ≥90 % danger. */
export const levelOf = (pct: number | undefined): UsageLevel => (pct === undefined ? 'none' : pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok');

/** Data older than this shows «(hace X min)». */
export const STALE_MS = 15 * 60_000;
const SHORT: Record<UsageMetric['key'], string> = { five_hour: '5h', seven_day: 'Sem' };
const LONG: Record<UsageMetric['key'], string> = { five_hour: 'Ventana de 5 h', seven_day: 'Semanal' };
const ARIA: Record<UsageMetric['key'], string> = { five_hour: 'Ventana de 5 horas', seven_day: 'Semanal' };

/** "▰▰▰▱▱" for `pct` in `n` segments. */
export const bar = (pct: number, n = 5) => {
  const on = Math.max(0, Math.min(n, Math.round((pct / 100) * n)));
  return g.barOn.repeat(on) + g.barOff.repeat(n - on);
};

/**
 * Time left until a reset: «en 4 días», «en 1 día y 5 h», «en 5 h 20 min», «en 42 min»,
 * «en menos de 1 min». `long` spells hours and minutes out (for screen readers).
 */
export function resetText(at: number, now: number, long = false): string {
  const mins = Math.floor((at - now) / 60_000);
  const H = long ? (n: number) => `${n} ${n === 1 ? 'hora' : 'horas'}` : (n: number) => `${n} h`;
  const M = long ? (n: number) => `${n} ${n === 1 ? 'minuto' : 'minutos'}` : (n: number) => `${n} min`;
  const D = (n: number) => `${n} ${n === 1 ? 'día' : 'días'}`;
  if (mins < 1) return long ? 'en menos de 1 minuto' : 'en menos de 1 min';
  const h = Math.floor(mins / 60);
  if (h < 1) return `en ${M(mins)}`;
  if (h < 24) return `en ${H(h)}${mins % 60 ? ` ${M(mins % 60)}` : ''}`;
  const d = Math.floor(h / 24);
  if (h >= 72) return `en ${D(d)}`;
  return `en ${D(d)}${h % 24 ? ` y ${H(h % 24)}` : ''}`;
}

export const agoMin = (updatedAt: number, now: number) => Math.max(0, Math.round((now - updatedAt) / 60_000));

export type MetricView = { key: UsageMetric['key']; short: string; long: string; pct?: number; level: UsageLevel; resetsAt?: number; aria: string };

/** A metric whose window already reset after the data was taken has no current value (—). */
export function metricViews(snap: UsageSnapshot | null, now: number): MetricView[] {
  const keys: UsageMetric['key'][] = ['five_hour', 'seven_day'];
  return keys.map((key) => {
    const m = snap?.metrics.find((x) => x.key === key);
    const outdated = !!m?.resetsAt && m.resetsAt <= now && snap!.updatedAt < m.resetsAt;
    const pct = m && !outdated ? Math.round(m.pct) : undefined;
    const reset = m?.resetsAt && !outdated ? `, se reinicia ${resetText(m.resetsAt, now, true)}` : '';
    return {
      key,
      short: SHORT[key],
      long: LONG[key],
      pct,
      level: levelOf(pct),
      resetsAt: outdated ? undefined : m?.resetsAt,
      aria: pct === undefined ? `${ARIA[key]}, sin datos` : `${ARIA[key]}, ${pct} por ciento${reset}`,
    };
  });
}

/** Shown in the help and the usage modal (orq owns the agents' statusLine). */
export const USAGE_NOTE = 'En las sesiones de orq, la barra de estado de Claude la gestiona orq para leer el uso.';

export type TopbarUsage = {
  /** Variants from widest to narrowest; the layout picks the first that fits. */
  full: string;
  pcts: string;
  top: string;
  level: UsageLevel;
  /** ≥90 %: never leaves the screen (goes to the footer at worst). */
  critical: boolean;
  aria: string;
};

/** Top-bar label: «5h ▰▰▰▱▱ 62% · Sem 31%» → «5h 62% · Sem 31%» → «5h 62%»; «Uso —» without data. */
export function topbarUsage(snap: UsageSnapshot | null, now: number): TopbarUsage {
  const views = metricViews(snap, now);
  const known = views.filter((v) => v.pct !== undefined);
  if (!known.length) return { full: 'Uso —', pcts: 'Uso —', top: 'Uso —', level: 'none', critical: false, aria: 'Uso de Claude, sin datos' };
  const highest = known.reduce((a, b) => (b.pct! > a.pct! ? b : a));
  const level = highest.level;
  const warn = level === 'warn' || level === 'danger' ? `${g.warning} ` : '';
  const stale = snap && now - snap.updatedAt > STALE_MS ? ` (hace ${agoMin(snap.updatedAt, now)} min)` : '';
  // ≥90 % also reads without colour: "93%!".
  const val = (v: MetricView) => (v.pct === undefined ? '—' : `${v.pct}%${v.level === 'danger' ? '!' : ''}`);
  const part = (v: MetricView, withBar: boolean) => `${v.short} ${withBar && v === highest ? `${bar(v.pct!)} ` : ''}${val(v)}`;
  return {
    full: warn + views.map((v) => part(v, true)).join(` ${g.sep} `) + stale,
    pcts: warn + views.map((v) => part(v, false)).join(` ${g.sep} `) + stale,
    // The narrowest variant still flags old data, with a bare «~».
    top: warn + part(highest, false) + (stale ? ' ~' : ''),
    level,
    critical: level === 'danger',
    aria: views.map((v) => v.aria).join('; '),
  };
}

/** Toast keys already shown: one per metric and window (crossing 90 %). */
export function crossings(snap: UsageSnapshot | null, now: number, seen: Set<string>): string[] {
  const out: string[] = [];
  for (const v of metricViews(snap, now)) {
    if (v.level !== 'danger') continue;
    const id = `${v.key}:${v.resetsAt ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(`${g.warning} Has usado el 90 % de la ${v.key === 'five_hour' ? 'ventana de 5 h' : 'cuota semanal'}.${v.resetsAt ? ` Se reinicia ${resetText(v.resetsAt, now)}.` : ''}`);
  }
  return out;
}
