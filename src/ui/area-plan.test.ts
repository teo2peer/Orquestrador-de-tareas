import { describe, expect, test } from 'bun:test';
import { type AreaIssue, areaId, coordinatorRole } from '../areas.ts';
import type { Role } from '../types.ts';
import {
  type PlanArea,
  type RolePlan,
  addArea,
  addMember,
  addPath,
  baseOptions,
  buildAreaTeam,
  clampSel,
  cycleBase,
  cycleLead,
  defaultLeadId,
  formatPaths,
  isOutside,
  issueText,
  launchGate,
  leadCandidates,
  mergeAreas,
  missingFrom,
  pathKind,
  refreshArea,
  resolveLead,
  planIssues,
  remapIds,
  removeArea,
  removePath,
  renameArea,
  roleTeam,
  saveConflicts,
  toggleIncluded,
  toggleMember,
  toggleWrites,
} from './area-plan.ts';

const area = (name: string, paths: string[], writes = true): PlanArea => ({ id: areaId(name), name, paths, description: '', writes, files: 1, base: '', reason: '' });
const role = (id: string, extra: Partial<Role> = {}): Role => ({
  id,
  name: id.toUpperCase(),
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
const plan = [area('UI', ['src/ui']), area('Core', ['src/*'])];

describe('paths', () => {
  test('format with a cap', () => {
    expect(formatPaths(['a', 'b/*'])).toBe('a, b/*');
    expect(formatPaths(['a', 'b', 'c', 'd'], 2)).toBe('a, b +2');
  });
  test('outside the directory', () => {
    for (const p of ['/etc', '../x', 'a/../../b', '..', 'C:\\x']) expect([p, isOutside(p)]).toEqual([p, true]);
    for (const p of ['src', 'src/*', '*', 'a/../b', './src']) expect([p, isOutside(p)]).toEqual([p, false]);
  });
  test('kind', () => {
    expect(pathKind('src/*', false)).toBe('solo directos');
    expect(pathKind('*', false)).toBe('solo directos');
    expect(pathKind('README.md', true)).toBe('fichero');
    expect(pathKind('src', false)).toBe('recursivo');
  });
  test('add: trimmed, no duplicates; outside the directory is refused and never added', () => {
    expect(addPath(plan, 0, ' ./src/cli.tsx ', '~/orq').areas[0]!.paths).toEqual(['src/ui', 'src/cli.tsx']);
    expect(addPath(plan, 0, 'src/ui', '~/orq').areas[0]!.paths).toEqual(['src/ui']);
    const out = addPath(plan, 0, '../other', '~/orq');
    expect(out.error).toBe('La ruta debe estar dentro de ~/orq.');
    expect(out.areas).toBe(plan);
    expect(addPath(plan, 0, '  ', '~/orq')).toEqual({ areas: plan });
  });
  test('remove', () => expect(removePath(plan, 0, 0)[0]!.paths).toEqual([]));
});

describe('editing the plan', () => {
  test('rename recomputes the id with areaId', () => {
    const next = renameArea(plan, 0, 'Interfaz web');
    expect(next[0]).toMatchObject({ name: 'Interfaz web', id: areaId('Interfaz web'), paths: ['src/ui'] });
    expect(next[1]).toBe(plan[1]!);
  });
  test('writer, include and remove touch only that area; nothing is mutated', () => {
    expect(toggleWrites(plan, 0)[0]!.writes).toBe(false);
    expect(toggleIncluded(plan, 1)[1]!.off).toBe(true);
    expect(toggleIncluded(toggleIncluded(plan, 1), 1)[1]!.off).toBe(false);
    expect(removeArea(plan, 0).map((a) => a.name)).toEqual(['Core']);
    expect(plan[0]!.writes).toBe(true);
    expect(plan).toHaveLength(2);
  });
  test('add appends an empty writer with a free name, also from an empty plan', () => {
    expect(addArea([])).toMatchObject([{ id: areaId('Área 1'), name: 'Área 1', paths: [], writes: true, files: 0, base: '' }]);
    const clash = addArea([area('Área 2', ['x']), area('Área 3', ['y'])]);
    expect(clash[2]!.name).toBe('Área 4');
    expect(new Set(clash.map((a) => a.id)).size).toBe(3);
  });
  test('merge: union of paths into the target, which keeps its name and position', () => {
    const three = [...plan, area('Tests', ['tests'], false)];
    const m = mergeAreas(three, 2, 0);
    expect(m.map((a) => a.name)).toEqual(['UI', 'Core']);
    expect(m[0]).toMatchObject({ paths: ['src/ui', 'tests'], files: 2, writes: true });
    expect(m[0]!.reason).toContain('Tests');
    expect(mergeAreas(three, 1, 1)).toBe(three);
  });
});

describe('hand edits', () => {
  test('after adding, the selection is the new area (not the previous one)', () => {
    const next = addArea(plan);
    const sel = clampSel(next.length - 1, next.length);
    expect(next[sel]!.name).toBe('Área 3');
    // The bug: clamping to the old length selected the previous area.
    expect(plan[clampSel(next.length - 1, plan.length)]!.name).toBe('Core');
    expect(clampSel(-5, 3)).toBe(-1);
    expect(clampSel(0, 0)).toBe(-1);
  });
  test('editing paths recomputes files, reason and description from the cached file list', () => {
    const files = [
      ...Array.from({ length: 11 }, (_, i) => `defaults/departments/d${i}.yaml`),
      ...Array.from({ length: 37 }, (_, i) => `defaults/roles/r${i}.md`),
      'src/a.ts',
    ];
    const one = [{ ...area('defaults/departments', ['defaults/departments']), files: 11, reason: 'propuesta', description: 'old' }];
    const edited = refreshArea(addPath(removePath(one, 0, 0), 0, 'defaults', '~/orq').areas, 0, '/nowhere', files);
    expect(edited[0]).toMatchObject({ paths: ['defaults'], files: 48, reason: 'Editada a mano · 48 ficheros', description: '48 ficheros en defaults' });
    expect(refreshArea(removePath(one, 0, 0), 0, '/nowhere', files)[0]).toMatchObject({ files: 0, description: 'sin rutas' });
    // Merging also goes through refreshArea in the review.
    const merged = refreshArea(mergeAreas([...one, area('Roles', ['defaults/roles'])], 1, 0), 0, '/nowhere', files);
    expect(merged[0]!.files).toBe(48);
  });
});

describe('base role', () => {
  const lib = [role('frontend'), role('qa'), role('area-x', { area: { paths: ['x'] } })];
  test('options: generic first, then library roles, never area roles', () => expect(baseOptions(lib)).toEqual(['', 'frontend', 'qa']));
  test('cycles both ways and wraps', () => {
    expect(cycleBase(plan, 0, lib)[0]!.base).toBe('frontend');
    expect(cycleBase(plan, 0, lib, -1)[0]!.base).toBe('qa');
    expect(cycleBase(cycleBase(cycleBase(plan, 0, lib), 0, lib), 0, lib)[0]!.base).toBe('');
    expect(cycleBase(plan, 0, lib)[1]).toBe(plan[1]!);
  });
  test('the area agent builds on its base role', () => {
    const team = buildAreaTeam([{ ...plan[0]!, base: 'frontend' }], role('cto'), [role('frontend', { prompt: 'FRONTEND BODY', model: 'sonnet' })]);
    expect(team[1]!.prompt).toContain('FRONTEND BODY');
    expect(team[1]!.model).toBe('sonnet');
  });
});

describe('lead', () => {
  test('default: cto ?? pm ?? library coordinator ?? generic coordinator (as in stack.ts)', () => {
    expect(defaultLeadId([role('pm'), role('cto')])).toBe('cto');
    expect(defaultLeadId([role('qa'), role('pm')])).toBe('pm');
    const libCoord = role('coordinator', { prompt: 'MINE' });
    expect(defaultLeadId([role('qa'), libCoord])).toBe('coordinator');
    expect(leadCandidates([role('qa'), libCoord]).find((r) => r.id === 'coordinator')).toBe(libCoord);
    expect(leadCandidates([libCoord]).filter((r) => r.id === 'coordinator')).toHaveLength(1);
    expect(defaultLeadId([role('qa')])).toBe(coordinatorRole().id);
    expect(defaultLeadId([role('cto', { area: { paths: ['x'] } })])).toBe(coordinatorRole().id);
  });
  test('candidates: cto, pm, coordinator first, generic coordinator last, never area roles; c cycles', () => {
    const lib = [role('qa'), role('pm'), role('cto'), role('area-x', { area: { paths: ['x'] } })];
    expect(leadCandidates(lib).map((r) => r.id)).toEqual(['cto', 'pm', 'qa', coordinatorRole().id]);
    expect(cycleLead(lib, 'cto')).toBe('pm');
    expect(cycleLead(lib, 'cto', -1)).toBe(coordinatorRole().id);
  });
  test('a lead id no longer in the library falls back to the default lead', () => {
    expect(resolveLead([role('pm'), role('cto')], 'gone').id).toBe('cto');
    expect(resolveLead([role('qa')], 'gone').id).toBe(coordinatorRole().id);
    expect(resolveLead([role('pm'), role('cto')], 'pm').id).toBe('pm');
  });
  test('the lead of an area team never writes, whatever role is chosen', () => {
    const team = buildAreaTeam(plan, role('frontend', { writes: true }));
    expect(team[0]).toMatchObject({ id: 'frontend', writes: false });
    expect(team[0]!.area).toBeUndefined();
  });
  test('team: exactly one agent without paths, first; excluded areas are left out', () => {
    const team = buildAreaTeam(toggleIncluded([...plan, area('Docs', ['docs'])], 1), role('cto'));
    expect(team.map((r) => r.id)).toEqual(['cto', areaId('UI'), areaId('Docs')]);
    expect(team.filter((r) => !r.area)).toHaveLength(1);
    expect(team[1]!.area?.paths).toEqual(['src/ui']);
  });
});

describe('validation and launch gate', () => {
  const overlap: AreaIssue = { level: 'error', message: 'core text', agents: [areaId('UI'), areaId('Core')], path: 'src/ui/x.ts', files: ['src/ui/x.ts', 'src/ui/y.ts'] };
  const warn: AreaIssue = { level: 'warning', message: '"Core" no tiene rutas asignadas.', agents: [areaId('Core')] };
  test('overlap copy names both areas and the shared files (path when there are none)', () => {
    const nameOf = (id: string) => (id === areaId('UI') ? 'UI' : 'Core');
    expect(issueText(overlap, nameOf)).toBe('«UI» y «Core» comparten rutas: src/ui/x.ts, src/ui/y.ts. Quita la ruta de una, fusiónalas o marca una como lectora.');
    expect(issueText({ ...overlap, files: [] }, nameOf)).toContain('comparten rutas: src/ui/x.ts.');
    expect(issueText({ level: 'warning', message: 'm', path: 'p' })).toBe('m (p)');
  });
  test('errors block, warnings do not', () => {
    expect(launchGate(planIssues(plan, [warn]))).toMatchObject({ blocked: false, errors: [] });
    const g = launchGate(planIssues(plan, [warn, overlap]));
    expect(g.blocked).toBe(true);
    expect(g.reason).toBe('1 conflicto: revisa antes de lanzar');
    expect(g.errors[0]!.text).toContain('«UI» y «Core»');
    expect(g.warnings).toHaveLength(1);
  });
  test('no included areas, empty or duplicate names block', () => {
    expect(launchGate(planIssues(plan.map((a) => ({ ...a, off: true })), [])).errors[0]!.text).toBe('No hay agentes. Incluye al menos un área.');
    expect(planIssues(renameArea(plan, 0, ' '), []).map((i) => i.text)).toContain('Escribe un nombre.');
    const dup = planIssues(renameArea(plan, 1, 'ui'), [{ level: 'error', message: 'Id de área duplicado: "area-ui" (2 veces).' }]);
    expect(dup.map((i) => i.text)).toEqual(['Ya hay un área «ui».']);
  });
  test('no writers only warns', () => {
    const issues = planIssues(plan.map((a) => ({ ...a, writes: false })), []);
    expect(issues).toEqual([{ level: 'warning', text: 'Nadie puede escribir. Marca al menos un área como escritora.', agents: [] }]);
    expect(launchGate(issues).blocked).toBe(false);
  });
  test('a running session blocks code areas', () => expect(launchGate([], true)).toMatchObject({ blocked: true, reason: 'Detén la sesión para componer por partes' }));
});

describe('auto by role', () => {
  const p: RolePlan = {
    members: [
      { role: role('cto'), reason: 'cto: coordina', generated: false },
      { role: role('frontend'), reason: 'frontend: Ink', generated: false },
      { role: role('dba'), reason: 'dba: generado', generated: true },
    ],
    off: [],
    lead: 'cto',
  };
  test('team: lead first, excluded left out, generated ids listed', () => {
    expect(roleTeam(p)).toEqual({ roles: p.members.map((m) => m.role), lead: 'cto', generated: ['dba'] });
    const noLead = roleTeam(toggleMember(p, 'cto'));
    expect(noLead.lead).toBe('frontend');
    expect(noLead.roles.map((r) => r.id)).toEqual(['frontend', 'dba']);
    expect(roleTeam({ ...p, lead: 'dba' }).roles[0]!.id).toBe('dba');
  });
  test('add a role by hand; adding an excluded one re-includes it', () => {
    const added = addMember(p, role('qa'));
    expect(added.members.at(-1)).toMatchObject({ reason: 'qa: añadido a mano', generated: false });
    expect(addMember(toggleMember(p, 'dba'), role('dba'))).toEqual(p);
  });
  test('with a session open only the missing roles are added', () => {
    expect(missingFrom(p.members.map((m) => m.role), ['cto', 'frontend']).map((r) => r.id)).toEqual(['dba']);
  });
});

describe('save in the project', () => {
  test('id clash lines, capped', () => {
    expect(saveConflicts({ a: 'a', b: 'b' })).toEqual([]);
    expect(saveConflicts({ frontend: 'frontend-2' })).toEqual(['Ya existe el rol «frontend» en este proyecto: se guardará como «frontend-2».']);
    expect(saveConflicts({ a: 'a-2', b: 'b-2', c: 'c-2', d: 'd' })).toHaveLength(3);
    expect(saveConflicts({ a: 'a-2', b: 'b-2', c: 'c-2' }).at(-1)).toBe('+1 más');
  });
  test('the launched team uses the saved ids', () => {
    const r = remapIds([role('coordinator'), role('area-ui')], 'coordinator', { coordinator: 'coordinator-2', 'area-ui': 'area-ui' });
    expect(r.lead).toBe('coordinator-2');
    expect(r.roles.map((x) => x.id)).toEqual(['coordinator-2', 'area-ui']);
  });
});

import { reviewHeader } from './AreaEditor.tsx';

describe('review header width', () => {
  test('fits at 80 columns, also with «Deshacer»; long labels when there is room', () => {
    for (const undo of [false, true]) expect(reviewHeader(78, undo).width).toBeLessThanOrEqual(78);
    expect(reviewHeader(78, true).back).toBe('Volver');
    expect(reviewHeader(150, true).back).toBe('Volver a la vista previa');
  });
});
