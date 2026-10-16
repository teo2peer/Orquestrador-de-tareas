import { describe, expect, test } from 'bun:test';
import type { Role } from '../types.ts';
import { barFit, chipWidth, filterChunk, filterRoles, freeRoles, groupedRows, moreWidth } from './hire-list.ts';

const role = (id: string, extra: Partial<Role> = {}): Role => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  title: id,
  accessory: 'none',
  color: 'cyan',
  writes: false,
  description: '',
  prompt: '',
  scope: 'global',
  file: '',
  ...extra,
});

describe('free roles', () => {
  test('without the hired ones, area roles or duplicates', () => {
    const lib = [role('cto'), role('qa'), role('qa'), role('ux'), role('area-x', { area: { paths: ['x'] } })];
    expect(freeRoles(lib, ['cto']).map((r) => r.id)).toEqual(['qa', 'ux']);
  });
});

describe('filter', () => {
  const lib = [role('frontend', { name: 'Frontend Developer', description: 'Interfaces con Ink' }), role('dba', { name: 'Administrador de BD', pack: 'vendor' })];
  test('words, any field, accents and case ignored', () => {
    expect(filterRoles(lib, 'ink front').map((r) => r.id)).toEqual(['frontend']);
    expect(filterRoles(lib, 'ADMINISTRADOR vendor').map((r) => r.id)).toEqual(['dba']);
    expect(filterRoles(lib, 'interfáces').map((r) => r.id)).toEqual(['frontend']);
    expect(filterRoles(lib, '   ')).toEqual(lib);
    expect(filterRoles(lib, 'nada')).toEqual([]);
  });
});

describe('bar fit and «Más… (+N)»', () => {
  const many = Array.from({ length: 30 }, (_, i) => role(`rol${String(i).padStart(2, '0')}`));
  test('everything fits: no «Más»', () => {
    expect(barFit(many.slice(0, 3), 80, 2)).toEqual({ start: 0, count: 3, more: 0 });
  });
  test('N counts exactly the roles not shown, with room left for the button', () => {
    const w = 60;
    const f = barFit(many, w, 2);
    expect(f.count).toBeGreaterThan(0);
    expect(f.more).toBe(many.length - f.count);
    // Second row: the chips plus the button fit in the width.
    const perRow = Math.floor(w / chipWidth(many[0]!));
    expect(f.count).toBeLessThanOrEqual(perRow * 2);
    const lastRow = f.count - perRow;
    expect(lastRow * chipWidth(many[0]!) + moreWidth(f.more)).toBeLessThanOrEqual(w);
  });
  test('a shifted window still reports every hidden role', () => {
    const f = barFit(many, 60, 2, 10);
    expect(f.start).toBe(10);
    expect(f.more).toBe(many.length - f.count);
  });
});

describe('popup rows', () => {
  test('grouped by pack, «Propios» first; index follows the visual order', () => {
    const { rows, order } = groupedRows([role('zeta', { pack: 'vendor' }), role('ana'), role('beto', { pack: 'agency' })]);
    expect(rows.map((r) => (r.kind === 'group' ? `#${r.label}` : r.role.id))).toEqual(['#Propios', 'ana', '#agency', 'beto', '#vendor', 'zeta']);
    expect(order.map((r) => r.id)).toEqual(['ana', 'beto', 'zeta']);
  });
});

describe('filter chunks', () => {
  test('line breaks become spaces; control characters are dropped', () => {
    expect(filterChunk('qa')).toBe('qa');
    expect(filterChunk('k8s\r\nops\x07')).toBe('k8s ops');
  });
});
