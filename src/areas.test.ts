import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_AREA_LIMIT, areaId, listProjectFiles, resolvePaths, areaRole, coordinatorRole, pathsOverlap, proposeAreas, validateAreas, type AreaProposal } from './areas.ts';

const REPO = path.resolve(import.meta.dir, '..');
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** Temporary non-git directory with the given files. */
function fixture(files: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-areas-test-'));
  tmpDirs.push(dir);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  return dir;
}

const area = (name: string, paths: string[], writes = true, base = ''): AreaProposal => ({ id: areaId(name), name, paths, description: '', writes, files: 1, base, reason: '' });

describe('pathsOverlap', () => {
  test.each([
    ['src', 'src/ui', true],
    ['src/ui/', './src/ui', true],
    ['src', 'srcx', false],
    ['src/*', 'src/ui', false],
    ['src/*', 'src/hq.ts', true],
    ['src/*', 'src', true],
    ['src/*', 'src/*', true],
    ['src/*', 'src/ui/*', false],
    ['*', 'src', false],
    ['*', 'README.md', true],
    ['defaults', 'src', false],
  ])('%s vs %s → %p', (a, b, expected) => {
    expect(pathsOverlap(a, b)).toBe(expected);
    expect(pathsOverlap(b, a)).toBe(expected);
  });
});

describe('proposeAreas', () => {
  test('AC3: this repo gives disjoint areas, no ignored dirs, within the limit', () => {
    const areas = proposeAreas(REPO);
    expect(areas.length).toBeGreaterThan(0);
    expect(areas.length).toBeLessThanOrEqual(DEFAULT_AREA_LIMIT);
    const paths = areas.flatMap((a) => a.paths);
    expect(paths.some((p) => /(^|\/)(node_modules|\.git|\.orq)(\/|$)/.test(p))).toBe(false);
    expect(validateAreas(areas, REPO).filter((i) => i.level === 'error')).toEqual([]);
    expect(new Set(areas.map((a) => a.id)).size).toBe(areas.length);
    // Other top-level dirs may come and go; these must be separate areas.
    expect(paths).toEqual(expect.arrayContaining(['*', 'defaults/departments', 'defaults/roles', 'src/*', 'src/ui']));
    expect(Object.fromEntries(areas.map((a) => [a.paths[0], a.base]))).toMatchObject({ 'src/ui': 'frontend', 'src/*': 'backend', 'defaults/roles': '' });
    // Every top-level directory with files is covered by some area.
    for (const top of ['src', 'defaults']) expect(paths.some((p) => p === top || p.startsWith(`${top}/`))).toBe(true);
    expect(areas.every((a) => a.writes && a.files > 0 && a.description.length > 0)).toBe(true);
  });

  test('AC4: empty dir gives no areas; a single file gives one root area', () => {
    expect(proposeAreas(fixture([]))).toEqual([]);
    expect(proposeAreas(path.join(os.tmpdir(), 'orq-areas-does-not-exist'))).toEqual([]);
    const one = proposeAreas(fixture(['README.md']));
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ paths: ['*'], files: 1, writes: true });
  });

  test('a directory ignored by a parent git repo falls back to walking the files', () => {
    const parent = fixture(['.gitignore', 'sub/a/x.ts', 'sub/b.ts']);
    fs.writeFileSync(path.join(parent, '.gitignore'), 'sub/\n');
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: parent }).exitCode).toBe(0);
    expect(listProjectFiles(path.join(parent, 'sub')).sort()).toEqual(['a/x.ts', 'b.ts']);
  });

  test('git: deleted tracked files are left out', () => {
    const repo = fixture(['a/x.ts', 'a/y.ts']);
    const g = (...args: string[]) => Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo }).exitCode;
    expect(g('init', '-q')).toBe(0);
    expect(g('add', '.')).toBe(0);
    expect(g('commit', '-qm', 'x')).toBe(0);
    fs.rmSync(path.join(repo, 'a/y.ts'));
    expect(listProjectFiles(repo)).toEqual(['a/x.ts']);
  });

  test('excluded directories are skipped at any level', () => {
    const dir = fixture(['a/x.ts', 'node_modules/p/i.js', 'a/node_modules/q.js', 'dist/out.js', 'b/.venv/lib.py', 'b/y.py']);
    const areas = proposeAreas(dir);
    expect(areas.map((a) => a.paths).flat()).toEqual(['a', 'b']);
    expect(areas.reduce((n, a) => n + a.files, 0)).toBe(2);
  });

  test('AC5: more than 8 folders are merged down to the limit, each covered exactly once', () => {
    const tops = Array.from({ length: 12 }, (_, i) => `dir${String(i).padStart(2, '0')}`);
    const files = tops.flatMap((d, i) => Array.from({ length: i + 1 }, (_, k) => `${d}/f${k}.ts`));
    const dir = fixture([...files, 'README.md']);
    const areas = proposeAreas(dir);
    expect(areas.length).toBeLessThanOrEqual(8);
    const paths = areas.flatMap((a) => a.paths);
    for (const t of [...tops, '*']) expect(paths.filter((p) => p === t)).toHaveLength(1);
    expect(paths).toHaveLength(tops.length + 1);
    expect(areas.at(-1)!.name).toBe('otros');
    expect(validateAreas(areas, dir).filter((i) => i.level === 'error')).toEqual([]);
    expect(proposeAreas(dir, { limit: 3 })).toHaveLength(3);
  });

  test('a directory holding most files is expanded into subdirs + loose files', () => {
    const dir = fixture(['src/a.ts', 'src/b.ts', 'src/ui/x.tsx', 'src/ui/y.tsx', 'src/ui/z.tsx', 'docs/r.md', 'package.json']);
    const areas = proposeAreas(dir);
    expect(areas.map((a) => a.paths[0])).toEqual(['*', 'docs', 'src/*', 'src/ui']);
    expect(areas.find((a) => a.paths[0] === 'src/ui')!.description).toContain('.tsx');
    expect(validateAreas(areas, dir)).toEqual([]);
  });

  test('base role and reason per area; test directories are read-only qa', () => {
    const dir = fixture(['web/App.tsx', 'web/b.css', 'api/server.py', 'tests/x.test.ts', 'db/migrations/001.sql', '.github/workflows/ci.yml', 'docs/a.md']);
    const byPath = Object.fromEntries(proposeAreas(dir).map((a) => [a.paths[0], a]));
    expect(byPath['web']).toMatchObject({ base: 'frontend', writes: true });
    expect(byPath['api']).toMatchObject({ base: 'backend', writes: true });
    expect(byPath['tests']).toMatchObject({ base: 'qa', writes: false });
    expect(byPath['db']).toMatchObject({ base: 'dba' });
    expect(byPath['.github']).toMatchObject({ base: 'devops' });
    expect(byPath['docs']).toMatchObject({ base: '' });
    for (const a of Object.values(byPath)) expect(a.reason).toMatch(/^[^\n]+$/);
  });

  test('proposing areas writes nothing', () => {
    const dir = fixture(['a/x.ts', 'b/y.ts']);
    const before = fs.readdirSync(dir, { recursive: true });
    proposeAreas(dir);
    validateAreas(proposeAreas(dir), dir);
    expect(fs.readdirSync(dir, { recursive: true })).toEqual(before);
  });

  test('is deterministic', () => {
    expect(proposeAreas(REPO)).toEqual(proposeAreas(REPO));
  });
});

describe('validateAreas', () => {
  const dir = fixture(['src/ui/a.tsx', 'src/hq.ts']);

  test('0 areas is an error', () => {
    expect(validateAreas([], dir)).toEqual([expect.objectContaining({ level: 'error' })]);
  });

  test('AC9: overlapping writers is an error naming both agents and the path', () => {
    const issues = validateAreas([area('Backend', ['src']), area('Frontend', ['src/ui'])], dir);
    const err = issues.find((i) => i.level === 'error')!;
    expect(err.message).toContain('Backend');
    expect(err.message).toContain('Frontend');
    expect(err.message).toContain('src/ui');
    expect(err.agents).toEqual([areaId('Backend'), areaId('Frontend')]);
    expect(err.path).toBe('src/ui');
    expect(err.files).toEqual(['src/ui/a.tsx']);
  });

  test('read-only areas may overlap; loose pattern vs subdir does not', () => {
    expect(validateAreas([area('A', ['src']), area('B', ['src/ui'], false)], dir)).toEqual([]);
    expect(validateAreas([area('A', ['src/*']), area('B', ['src/ui'])], dir)).toEqual([]);
    expect(validateAreas([area('A', ['src/*']), area('B', ['src/hq.ts'])], dir).some((i) => i.level === 'error' && i.path === 'src/hq.ts')).toBe(true);
  });

  test('duplicate ids are errors; missing paths and read-only areas without paths are warnings', () => {
    const issues = validateAreas([area('A', ['nope']), area('A', [], false), area('B', ['src/ui'])], dir);
    expect(issues.filter((i) => i.level === 'error')).toEqual([expect.objectContaining({ agents: [areaId('A')] })]);
    expect(issues.filter((i) => i.level === 'warning').map((i) => i.path ?? null)).toEqual(['nope', null]);
  });

  test('a writer area without paths is an error', () => {
    expect(validateAreas([area('A', [])], dir)).toEqual([expect.objectContaining({ level: 'error', agents: [areaId('A')] })]);
  });

  test('pattern overlap without shared real files is only a warning', () => {
    const issues = validateAreas([area('A', ['src/ui']), area('B', ['src/ui/empty'])], dir);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warning', agents: [areaId('A'), areaId('B')], path: 'src/ui/empty' }));
  });

  test.each(['/etc', '../x', 'src/../..', 'src/**', 'src/*.ts', 'src/u?', 'src/[ab]', 'src/{a,b}', '/', '.', './', ''])('invalid path %p is an error naming area and path', (p) => {
    const issues = validateAreas([area('Mala', [p]), area('B', ['src/ui'])], dir);
    const err = issues.find((i) => i.level === 'error')!;
    expect(err).toMatchObject({ agents: [areaId('Mala')], path: p });
    expect(err.message).toContain('Mala');
    expect(err.message).toContain(`"${p}"`);
  });

  test('valid patterns and normalized forms are accepted', () => {
    expect(validateAreas([area('A', ['src//ui/', './src/*']), area('B', ['*'])], dir).filter((i) => i.level === 'error')).toEqual([]);
  });

  test('a path matching a real one only case-insensitively is an error with the exact name', () => {
    const issues = validateAreas([area('A', ['SRC']), area('B', ['src'])], dir);
    expect(issues).toEqual([expect.objectContaining({ level: 'error', agents: [areaId('A')], path: 'SRC' })]);
    expect(issues[0]!.message).toContain('usa el nombre exacto "src"');
    expect(issues[0]!.message).toContain('"A"');
    expect(validateAreas([area('A', ['src/UI/a.tsx'])], dir)[0]!.message).toContain('"src/ui/a.tsx"');
    expect(validateAreas([area('A', ['nope'])], dir)).toEqual([expect.objectContaining({ level: 'warning', path: 'nope' })]);
  });

  test('uses the injected file list instead of listing the project', () => {
    const issues = validateAreas([area('A', ['lib']), area('B', ['lib/x'])], dir, ['lib/x/y.ts', 'lib/z.ts']);
    expect(issues).toEqual([expect.objectContaining({ level: 'error', path: 'lib/x', files: ['lib/x/y.ts'] })]);
    expect(proposeAreas(dir, { files: ['a/b.ts', 'c.md'] }).map((a) => a.paths[0])).toEqual(['*', 'a']);
  });

  test('resolvePaths lists the real files of directories and loose patterns', () => {
    expect(resolvePaths(dir, ['src/*'])).toEqual(['src/hq.ts']);
    expect(resolvePaths(dir, ['src'])).toEqual(['src/hq.ts', 'src/ui/a.tsx']);
    expect(resolvePaths(dir, ['*'])).toEqual([]);
  });
});

describe('roles', () => {
  test('areaRole owns its paths and forbids editing outside them', () => {
    const a = { ...area('src/ui', ['src/ui', 'src/*']), description: '3 ficheros · .tsx' };
    const r = areaRole(a, 0);
    expect(r).toMatchObject({ id: 'area-src-ui', writes: true, scope: 'project', file: '', area: { paths: ['src/ui', 'src/*'] } });
    expect(r.prompt).toContain('## OWNED PATHS');
    expect(r.prompt).toContain('- `src/ui`');
    expect(r.prompt).toContain('Never edit files outside your OWNED PATHS; when a change is needed elsewhere, ask its owner via delegate_task/send_message');
    expect(r.description.startsWith('src/ui, src/*')).toBe(true);
    expect(r.title).toContain('src/ui');
    const r2 = areaRole(a, 1);
    expect(r2.color).not.toBe(r.color);
    expect(r2.accessory).not.toBe(r.accessory);
  });

  test('areaRole builds on its base library role, generic otherwise', () => {
    const lib = [{ ...coordinatorRole(), id: 'frontend', title: 'Frontend Developer', prompt: 'FRONTEND BODY', writes: true }];
    const r = areaRole(area('src/ui', ['src/ui'], true, 'frontend'), 0, lib);
    expect(r.prompt).toContain('## OWNED PATHS');
    expect(r.prompt).toContain('FRONTEND BODY');
    expect(r.prompt.indexOf('## OWNED PATHS')).toBeLessThan(r.prompt.indexOf('FRONTEND BODY'));
    expect(r.description.startsWith('src/ui')).toBe(true);
    const g = areaRole(area('docs', ['docs'], true, 'frontend'), 0, []);
    expect(g.prompt).not.toContain('Base role');
    const qa = areaRole(area('tests', ['tests'], false, 'qa'), 2, []);
    expect(qa.writes).toBe(false);
    expect(qa.prompt).toContain('READ-ONLY');
    expect(qa.prompt).not.toContain('are yours too');
    expect(g.file).toBe('');
  });

  test('coordinatorRole is a read-only lead', () => {
    expect(coordinatorRole()).toMatchObject({ id: 'coordinator', writes: false });
    expect(coordinatorRole().prompt).toContain('OWNED PATHS');
  });
});
