import { describe, expect, test } from 'bun:test';
import { ctxLabel, kTok, profileHelp, skillsWarning, tokenMix } from './cost.ts';
import { g } from './glyphs.ts';

describe('context per agent', () => {
  test('levels by size, with the warning glyph over the limit', () => {
    expect(ctxLabel(84_000)).toEqual({ text: 'ctx 84k', level: 'normal', aria: 'Contexto 84 mil tokens' });
    expect(ctxLabel(110_000)).toMatchObject({ text: 'ctx 110k', level: 'high', aria: 'Contexto 110 mil tokens, alto' });
    expect(ctxLabel(150_000)).toMatchObject({ text: `${g.warning} ctx 150k`, level: 'over' });
    expect(ctxLabel(undefined).text).toBe('');
    expect(ctxLabel(0).text).toBe('');
  });
  test('short token counts', () => {
    expect(kTok(84_400)).toBe('84k');
    expect(kTok(1_200_000)).toBe('1,2M');
  });
});

describe('token mix of a session', () => {
  test('cache-read and output shares, and the weighted cost', () => {
    const t = (tokens: number, w: number) => ({ tokens, cost: tokens * w });
    expect(tokenMix({ input: t(100_000, 1), cacheWrite: t(60_000, 1.25), cacheRead: t(780_000, 0.1), output: t(60_000, 5) })).toBe(
      `Entrada en caché 78 % ${g.sep} Salida 6 % ${g.sep} coste ≈ 553k (en tokens de entrada)`,
    );
    expect(tokenMix({ input: t(0, 1), cacheWrite: t(0, 1), cacheRead: t(0, 1), output: t(0, 1) })).toBe('');
  });
});

import { STATUS } from './theme.ts';
import { stateFor } from './sprites.ts';

describe('dormant agents (lazy start)', () => {
  test('«en espera», muted, and a grey sleeping sprite', () => {
    expect(STATUS.dormant).toMatchObject({ label: 'en espera' });
    expect(stateFor('dormant', false)).toBe('sleeping');
  });
});

describe('profile flags in the help', () => {
  // Fixed flags, so the tests follow the rule and not today's list in hq.ts.
  const flags = (p: string) =>
    p === 'max' ? [] : p === 'balanced' ? ['sin skills ni comandos /', 'sin auto-memoria'] : ['sin skills ni comandos /', 'sin auto-memoria', 'solo herramientas básicas'];
  test('built from profileFlags: lead text + every flag; Máximo has none', () => {
    expect(profileHelp('saver', flags)).toBe(`Experimental (en pruebas ha gastado más; úsalo para medir): sin skills ni comandos / ${g.sep} sin auto-memoria ${g.sep} solo herramientas básicas.`);
    expect(profileHelp('balanced', flags)).toBe(`Sin medir todavía: sin skills ni comandos / ${g.sep} sin auto-memoria.`);
    expect(profileHelp('max', flags)).not.toContain('sin skills');
    // Single source: a flag removed in hq disappears from the help.
    expect(profileHelp('balanced', () => ['sin auto-memoria'])).toBe('Sin medir todavía: sin auto-memoria.');
  });
  test('skills warning: .<tool>/skills, .claude/skills or .claude/commands, only if the profile turns skills off', () => {
    const only = (dir: string) => (p: string) => p.endsWith(dir);
    const dirs = () => ['.claude/skills', '.claude/commands', '.acme-ai/skills'];
    expect(skillsWarning('saver', '/repo', only('.acme-ai/skills'), flags, dirs)).toBe('Este repo usa skills (.acme-ai/skills): con este perfil los agentes no podrán usarlas.');
    expect(skillsWarning('balanced', '/repo', only('.claude/commands'), flags)).toContain('(.claude/commands)');
    expect(skillsWarning('saver', '/repo', only('.claude/skills'), flags)).toContain('(.claude/skills)');
    expect(skillsWarning('max', '/repo', only('.claude/skills'), flags)).toBe('');
    expect(skillsWarning('saver', '/repo', () => false, flags)).toBe('');
    // A profile whose flags keep skills does not warn.
    expect(skillsWarning('saver', '/repo', only('.claude/skills'), () => ['sin auto-memoria'])).toBe('');
  });
});
