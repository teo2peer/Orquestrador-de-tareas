import { describe, expect, test } from 'bun:test';
import { TITLE_MAX, cleanTitle, renameSession } from './Sessions.tsx';

describe('session titles', () => {
  test('single spaces, trimmed, at most 60 characters; empty stays empty', () => {
    expect(cleanTitle('  Refactor   del modo\npor partes ')).toBe('Refactor del modo por partes');
    expect(cleanTitle('   ')).toBe('');
    expect(cleanTitle('x'.repeat(80))).toHaveLength(TITLE_MAX);
  });
});

describe('renaming', () => {
  const spy = () => {
    const calls: string[][] = [];
    return { calls, renameRun: (id: string, t: string) => (calls.push([id, t]), true) };
  };
  test('a run served by another orq window is refused and nothing is written', async () => {
    const r = spy();
    const err = await renameSession('r1', 'Nuevo', { hq: null, isServed: async () => true, renameRun: r.renameRun });
    expect(err).toContain('otra ventana');
    expect(r.calls).toEqual([]);
  });
  test('a stopped run is renamed on disk; the open one through hq; empty is refused', async () => {
    const r = spy();
    expect(await renameSession('r1', '  Nuevo  título ', { hq: null, isServed: async () => false, renameRun: r.renameRun })).toBeNull();
    expect(r.calls).toEqual([['r1', 'Nuevo título']]);
    const titles: string[] = [];
    expect(await renameSession('r2', 'Vivo', { hq: { runId: 'r2', setTitle: (t) => titles.push(t) }, isServed: async () => true, renameRun: r.renameRun })).toBeNull();
    expect(titles).toEqual(['Vivo']);
    expect(await renameSession('r1', '   ', { hq: null, isServed: async () => false, renameRun: r.renameRun })).toBe('Escribe un título.');
    expect(await renameSession('r1', 'x', { hq: null, isServed: async () => false, renameRun: () => false })).toBe('No se pudo renombrar la sesión.');
  });
});
