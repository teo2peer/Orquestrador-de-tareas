// Display rules for token costs: context size per agent and its warning level.
import fs from 'node:fs';
import path from 'node:path';
import type { CostProfile } from '../types.ts';
import { profileFlags } from '../hq.ts';
import { g } from './glyphs.ts';

/** Context above this (tokens) reads as high; above the compaction limit, as too big. */
export const CTX_HIGH = 100_000;
export const CTX_LIMIT = 120_000;

/** "84k" / "1,2M". */
export function kTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('es-ES', { maximumFractionDigits: 1 })}M`;
  return `${Math.round(n / 1000)}k`;
}

export type CtxLevel = 'normal' | 'high' | 'over';

/** «ctx 84k» (normal) · «ctx 110k» (high, WARN) · «⚠ ctx 150k» (over the limit, DANGER); '' without data. */
export function ctxLabel(tokens: number | undefined, limit = CTX_LIMIT): { text: string; level: CtxLevel; aria: string } {
  if (tokens === undefined || tokens <= 0) return { text: '', level: 'normal', aria: '' };
  const level: CtxLevel = tokens > limit ? 'over' : tokens >= CTX_HIGH ? 'high' : 'normal';
  const k = kTok(tokens);
  const thousands = `${Math.round(tokens / 1000)} mil`;
  return {
    text: `${level === 'over' ? `${g.warning} ` : ''}ctx ${k}`,
    level,
    aria: `Contexto ${thousands} tokens${level === 'over' ? ', demasiado alto' : level === 'high' ? ', alto' : ''}`,
  };
}

/**
 * «Entrada en caché 78 % · Salida 6 % · coste ≈ 1,2M» for a run's token mix (share of the
 * tokens read from cache and written as output; cost in input-token equivalents). '' when empty.
 */
export function tokenMix(byType: Record<'input' | 'cacheWrite' | 'cacheRead' | 'output', { tokens: number; cost: number }>): string {
  const total = byType.input.tokens + byType.cacheWrite.tokens + byType.cacheRead.tokens + byType.output.tokens;
  if (!total) return '';
  const pct = (n: number) => `${Math.round((n / total) * 100)} %`;
  const cost = byType.input.cost + byType.cacheWrite.cost + byType.cacheRead.cost + byType.output.cost;
  return `Entrada en caché ${pct(byType.cacheRead.tokens)} ${g.sep} Salida ${pct(byType.output.tokens)} ${g.sep} coste ≈ ${kTok(cost)} (en tokens de entrada)`;
}

// What each profile does, from hq's own list (single source: if a flag changes there, the UI follows).
const PROFILE_LEAD: Record<CostProfile, string> = {
  saver: 'Experimental (en pruebas ha gastado más; úsalo para medir)',
  balanced: 'Sin medir todavía',
  max: 'Máximo: cada agente conserva toda su conversación y tus herramientas MCP.',
};
/** Help of a profile: «Experimental (…): flag · flag · …»; Máximo has no flags. */
export function profileHelp(profile: CostProfile, flags: (p: CostProfile) => string[] = profileFlags): string {
  const f = flags(profile);
  return f.length ? `${PROFILE_LEAD[profile]}: ${f.join(` ${g.sep} `)}.` : PROFILE_LEAD[profile];
}

/** Project folders whose skills / slash commands a profile without skills cannot use. */
export const SKILL_DIRS = ['.claude/skills', '.claude/commands'];

/** Fixed skill folders plus any `.<tool>/skills` at the repo root (vendor skill systems). */
function dotSkillDirs(cwd: string): string[] {
  try {
    const dots = fs.readdirSync(cwd, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('.') && e.name !== '.claude');
    return [...SKILL_DIRS, ...dots.map((e) => `${e.name}/skills`)];
  } catch {
    return SKILL_DIRS;
  }
}
const skillsCache = new Map<string, string>();

/**
 * Warning for a profile that turns skills off (per profileFlags) in a repo that has them;
 * '' otherwise. Memoized per (profile, cwd) when using the real file system.
 */
export function skillsWarning(
  profile: CostProfile,
  cwd: string,
  exists?: (p: string) => boolean,
  flags: (p: CostProfile) => string[] = profileFlags,
  candidates: (cwd: string) => string[] = dotSkillDirs,
): string {
  const key = `${profile}\0${cwd}`;
  if (!exists && skillsCache.has(key)) return skillsCache.get(key)!;
  const has = exists ?? fs.existsSync;
  const off = flags(profile).some((f) => /skills/i.test(f));
  const found = off ? candidates(cwd).filter((d) => has(path.join(cwd, d))) : [];
  const out = found.length ? `Este repo usa skills (${found.join(', ')}): con este perfil los agentes no podrán usarlas.` : '';
  if (!exists) skillsCache.set(key, out);
  return out;
}
