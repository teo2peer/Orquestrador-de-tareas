import fs from 'node:fs';
import path from 'node:path';
import { ORQ_HOME } from './paths.ts';

/*
 * Claude subscription usage (per account), taken from the JSON Claude Code pipes to the
 * statusLine command (see statusline.ts). Documented fields (Claude Code 2.1.x):
 *   rate_limits.five_hour / seven_day: { used_percentage: 0-100, resets_at: epoch seconds }
 * Only present for Pro/Max subscribers and after the first API response. Per-model windows
 * (e.g. Fable) are not exposed to the statusLine and are not shown.
 * In orq sessions the statusLine is set by orq (each agent's settings.json, see hq.ts launch).
 */

export type UsageMetric = { key: 'five_hour' | 'seven_day'; label: string; pct: number; resetsAt?: number };
export type UsageSnapshot = { metrics: UsageMetric[]; updatedAt: number };

const LABEL: Record<UsageMetric['key'], string> = { five_hour: '5 h', seven_day: 'Semanal' };
/** Rewrite an unchanged snapshot at most this often (the statusLine runs on every update). */
const REFRESH_MS = 60_000;

export const usageFile = () => process.env.ORQ_USAGE_FILE ?? path.join(ORQ_HOME, 'usage.json');

function metric(key: UsageMetric['key'], w: unknown): UsageMetric | undefined {
  if (!w || typeof w !== 'object') return undefined;
  const pct = Number((w as any).used_percentage);
  if (!Number.isFinite(pct)) return undefined;
  const resets = Number((w as any).resets_at);
  return {
    key,
    label: LABEL[key],
    pct: Math.min(100, Math.max(0, pct)),
    ...(Number.isFinite(resets) && resets > 0 ? { resetsAt: resets * 1000 } : {}),
  };
}

/** Metrics of a statusLine JSON payload ([] when it carries no rate limits). */
export function parseUsage(statusJson: unknown): UsageMetric[] {
  const rl = (statusJson as any)?.rate_limits;
  if (!rl || typeof rl !== 'object') return [];
  return [metric('five_hour', rl.five_hour), metric('seven_day', rl.seven_day)].filter((m): m is UsageMetric => !!m);
}

/** Persist the usage of a statusLine payload (atomic write). Never throws. */
export function recordUsage(statusJson: unknown, now = Date.now()): void {
  let tmp: string | undefined;
  try {
    const prev = readUsage().snapshot;
    // Usage only grows inside a window: a lower value for the same reset time comes from a
    // session with older data (several agents share the account), so it is ignored.
    const metrics = parseUsage(statusJson).map((m) => {
      const old = prev?.metrics.find((p) => p.key === m.key && p.resetsAt === m.resetsAt);
      return old && old.pct > m.pct ? { ...m, pct: old.pct } : m;
    });
    if (!metrics.length) return;
    if (prev && JSON.stringify(prev.metrics) === JSON.stringify(metrics) && now - prev.updatedAt < REFRESH_MS) return;
    const file = usageFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ metrics, updatedAt: now } satisfies UsageSnapshot));
    fs.renameSync(tmp, file);
  } catch {
    /* usage is best-effort: never break the status line */
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}

/** Last recorded usage; `error` when the file exists but cannot be read. */
export function readUsage(): { snapshot: UsageSnapshot | null; error?: string } {
  const file = usageFile();
  try {
    if (!fs.existsSync(file)) return { snapshot: null };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data?.metrics) || !Number.isFinite(data?.updatedAt)) return { snapshot: null, error: 'usage.json con formato inválido' };
    return { snapshot: data as UsageSnapshot };
  } catch (e: any) {
    return { snapshot: null, error: `No se pudo leer el uso de Claude: ${e?.message ?? e}` };
  }
}

/** One short line for the status bar, e.g. "Opus · 5 h 23% · Semanal 41%". */
export function usageLine(statusJson: unknown): string {
  const model = String((statusJson as any)?.model?.display_name ?? '').trim();
  const parts = parseUsage(statusJson).map((m) => `${m.label} ${Math.round(m.pct)}%`);
  return [model, ...parts].filter(Boolean).join(' · ') || 'orq';
}
