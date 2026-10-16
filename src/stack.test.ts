import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { areaRole, proposeAreas } from './areas.ts';
import { parseFrontmatter, planSaveIds, saveGeneratedTeam, saveRole } from './library.ts';
import { detectStack, proposeRoleTeam } from './stack.ts';
import type { Role } from './types.ts';

const REPO = path.resolve(import.meta.dir, '..');
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tmp(files: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-stack-test-'));
  tmpDirs.push(dir);
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  return dir;
}

const role = (id: string, extra: Partial<Role> = {}): Role => ({
  id,
  name: id,
  title: id,
  accessory: 'none',
  color: 'blue',
  writes: true,
  description: '',
  prompt: `${id} body`,
  scope: 'global',
  file: `/lib/${id}.md`,
  ...extra,
});
const LIBRARY = ['cto', 'pm', 'frontend', 'backend', 'devops', 'dba', 'qa', 'reviewer', 'ux'].map((id) => role(id));

describe('detectStack', () => {
  test('labels of this repo, in a stable order', () => {
    const { signals } = detectStack(REPO);
    for (const s of ['TypeScript', 'Bun', 'Ink (TUI)', 'React', 'MCP server', 'Bun.serve', 'Tests']) expect(signals).toContain(s);
    expect(signals).not.toContain('Docker');
    expect(signals.indexOf('TypeScript')).toBeLessThan(signals.indexOf('MCP server'));
    expect(detectStack(REPO)).toEqual({ signals });
  });

  test('docker, CI, SQL and python projects', () => {
    const dir = tmp({ Dockerfile: '', '.github/workflows/ci.yml': '', 'db/migrations/001.sql': '', 'pyproject.toml': '', 'api/main.py': '' });
    expect(detectStack(dir).signals).toEqual(['Python', 'Carpeta de API', 'Docker', 'GitHub Actions', 'SQL', 'Migraciones']);
  });

  test('empty or missing directory', () => {
    expect(detectStack(tmp()).signals).toEqual([]);
    expect(detectStack(path.join(os.tmpdir(), 'orq-stack-missing')).signals).toEqual([]);
  });
});

describe('proposeRoleTeam', () => {
  test('AC13: this repo gives cto, frontend, backend, qa, reviewer', () => {
    const team = proposeRoleTeam(REPO, LIBRARY);
    expect(team.lead).toBe('cto');
    expect(team.members.map((m) => m.role.id)).toEqual(['cto', 'frontend', 'backend', 'qa', 'reviewer']);
    expect(team.members.every((m) => !m.generated && /^[^\n]+$/.test(m.reason))).toBe(true);
    expect(team.members.find((m) => m.role.id === 'frontend')!.reason).toContain('Ink');
  });

  test('a coordinator role in the library is reused as lead before generating one', () => {
    const team = proposeRoleTeam(tmp({ 'a.md': '' }), [role('coordinator'), role('qa'), role('reviewer')]);
    expect(team.lead).toBe('coordinator');
    expect(team.members[0]).toMatchObject({ generated: false, role: { file: '/lib/coordinator.md' } });
  });

  test('reuses an injected file list', () => {
    const dir = tmp({ 'package.json': '{"dependencies":{"ink":"1"}}' });
    expect(detectStack(dir, ['package.json', 'web/App.tsx', 'Dockerfile']).signals).toEqual(['TypeScript', 'Node.js', 'Ink (TUI)', 'Componentes UI', 'Carpeta de UI', 'Docker']);
    expect(proposeRoleTeam(dir, LIBRARY, ['package.json', 'Dockerfile']).members.map((m) => m.role.id)).toEqual(['cto', 'frontend', 'devops', 'qa', 'reviewer']);
  });

  test('Bun.serve is only scanned in Bun projects', () => {
    expect(detectStack(tmp({ 'server.ts': 'Bun.serve({})' })).signals).not.toContain('Bun.serve');
    expect(detectStack(tmp({ 'server.ts': 'Bun.serve({})', 'bun.lock': '' })).signals).toContain('Bun.serve');
  });

  test('AC15: deterministic', () => {
    expect(proposeRoleTeam(REPO, LIBRARY)).toEqual(proposeRoleTeam(REPO, LIBRARY));
  });

  test('lead falls back to pm, then to a generated coordinator; missing roles are generated', () => {
    const dir = tmp({ Dockerfile: '', 'schema.sql': '' });
    expect(proposeRoleTeam(dir, LIBRARY.filter((r) => r.id !== 'cto')).lead).toBe('pm');
    const team = proposeRoleTeam(dir, []);
    expect(team.lead).toBe('coordinator');
    expect(team.members.map((m) => [m.role.id, m.generated])).toEqual([
      ['coordinator', true],
      ['devops', true],
      ['dba', true],
      ['qa', true],
      ['reviewer', true],
    ]);
    expect(team.members.every((m) => m.role.file === '' && m.role.prompt.length > 0)).toBe(true);
  });

  test('AC17: proposing teams and areas never writes files', () => {
    const dir = tmp({ 'src/a.ts': '', 'web/App.tsx': '', 'package.json': '{"dependencies":{"react":"1"}}' });
    const before = fs.readdirSync(dir, { recursive: true }).sort();
    proposeRoleTeam(dir, []);
    detectStack(dir);
    proposeAreas(dir);
    expect(fs.readdirSync(dir, { recursive: true }).sort()).toEqual(before);
  });
});

describe('saveGeneratedTeam', () => {
  test('ids taken in the global library are suffixed too', () => {
    const base = tmp();
    const global = tmp({ 'roles/area-src.md': '---\nid: area-src\n---\n', 'departments/equipo.yaml': 'id: equipo\n' });
    expect(planSaveIds(['area-src', 'area-x'], 'roles', base, global)).toEqual({ 'area-src': 'area-src-2', 'area-x': 'area-x' });
    const out = saveGeneratedTeam({ name: 'Equipo', roles: [areaRole({ id: 'area-src', name: 'src', paths: ['src'], description: '', writes: true, files: 1, base: '', reason: '' }, 0)], lead: 'area-src', generatedIds: ['area-src'] }, base, global);
    expect(out.idMap).toEqual({ 'area-src': 'area-src-2' });
    expect(path.basename(out.deptFile)).toBe('equipo-2.yaml');
    expect(fs.readdirSync(path.join(global, 'roles'))).toEqual(['area-src.md']);
  });

  test('AC19: saves only generated roles in the project library, suffixing taken ids', () => {
    const base = tmp();
    const global = tmp();
    saveRole({ ...role('area-src'), scope: 'project' }, base);
    const areas = [
      { id: 'area-src', name: 'src', paths: ['src'], description: '', writes: true, files: 1, base: '', reason: '' },
      { id: 'area-docs', name: 'docs', paths: ['docs'], description: '', writes: true, files: 1, base: '', reason: '' },
    ];
    const roles = [LIBRARY[0]!, ...areas.map((a, i) => areaRole(a, i))];
    expect(planSaveIds(['area-src', 'area-docs'], 'roles', base, global)).toEqual({ 'area-src': 'area-src-2', 'area-docs': 'area-docs' });

    const out = saveGeneratedTeam({ name: 'Mi equipo', roles, lead: 'cto', generatedIds: ['area-src', 'area-docs'] }, base, global);
    expect(out.idMap).toEqual({ 'area-src': 'area-src-2', 'area-docs': 'area-docs' });
    expect(out.roleFiles.map((f) => path.relative(base, f)).sort()).toEqual(['roles/area-docs.md', 'roles/area-src-2.md']);
    expect(fs.readdirSync(path.join(base, 'roles')).sort()).toEqual(['area-docs.md', 'area-src-2.md', 'area-src.md']);
    const saved = fs.readFileSync(path.join(base, 'roles', 'area-src-2.md'), 'utf8');
    expect(saved).toContain('id: area-src-2');
    expect(saved).toContain('## OWNED PATHS');
    const dept = fs.readFileSync(out.deptFile, 'utf8');
    expect(path.relative(base, out.deptFile)).toBe('departments/mi-equipo.yaml');
    expect(dept).toContain('lead: cto');
    expect(dept).toMatch(/roles:\n\s+- cto\n\s+- area-src-2\n\s+- area-docs/);

    // A second save of the same team suffixes the department too.
    const again = saveGeneratedTeam({ name: 'Mi equipo', roles, lead: 'cto', generatedIds: ['area-src', 'area-docs'] }, base, global);
    expect(path.basename(again.deptFile)).toBe('mi-equipo-2.yaml');
    expect(again.idMap).toEqual({ 'area-src': 'area-src-3', 'area-docs': 'area-docs-2' });
  });

  test('role tools and userSettings are saved in the frontmatter', () => {
    const base = tmp();
    const file = saveRole({ ...role('researcher2'), scope: 'project', tools: ['WebFetch', 'WebSearch'], userSettings: false }, base);
    const { data } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    expect(data).toMatchObject({ tools: ['WebFetch', 'WebSearch'], userSettings: false });
  });
});
