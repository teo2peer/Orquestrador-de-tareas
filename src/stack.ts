import fs from 'node:fs';
import path from 'node:path';
import { coordinatorRole, listProjectFiles } from './areas.ts';
import type { Role } from './types.ts';

/*
 * "Auto by role": detect the project stack from its files and propose a team of
 * library roles. Deterministic, read-only (never writes files).
 */

export type RoleTeamProposal = { lead: string; members: { role: Role; reason: string; generated: boolean }[] };

type Category = 'ui' | 'server' | 'devops' | 'db' | 'test';
type Signal = { label: string; cat?: Category; evidence: string };
type Ctx = { cwd: string; files: string[]; deps: Set<string>; has: (f: string) => boolean };
const usesBun = (c: Ctx) => c.has('bun.lock') || c.has('bun.lockb') || c.deps.has('@types/bun');

const UI_DIR = /^(ui|frontend|web|client)$/i;
const API_DIR = /^(api|server|backend)$/i;
const TEST_DIR = /^(tests?|__tests__|specs?|e2e)$/i;
const TEST_FILE = /\.(test|spec)\.[^.]+$|_test\.[^.]+$/;
const UI_FILE = /\.(tsx|jsx|vue|svelte)$/;
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;
const MAX_SCAN = 500;
const MAX_SCAN_BYTES = 512 * 1024;
const SCAN_BUDGET_BYTES = 8 * 1024 * 1024;

const dirsMatching = (files: string[], re: RegExp) => {
  const out = new Set<string>();
  for (const f of files) {
    const segs = f.split('/').slice(0, -1);
    const i = segs.findIndex((s) => re.test(s));
    if (i >= 0) out.add(segs.slice(0, i + 1).join('/'));
  }
  return [...out].sort();
};

const dep = (name: string, label: string, cat?: Category) => (c: Ctx) => (c.deps.has(name) ? { label, cat, evidence: `${name} en package.json` } : undefined);
const file = (label: string, cat: Category | undefined, re: RegExp) => (c: Ctx) => {
  const hit = c.files.find((f) => re.test(f));
  return hit ? { label, cat, evidence: hit } : undefined;
};

/** Ordered detectors: the order of the signals is the order of this list. */
const DETECTORS: ((c: Ctx) => Signal | undefined)[] = [
  file('TypeScript', undefined, /(^|\/)tsconfig\.json$|\.tsx?$/),
  (c) => (usesBun(c) ? { label: 'Bun', evidence: 'bun.lock' } : undefined),
  (c) => (c.has('package.json') && !c.has('bun.lock') && !c.has('bun.lockb') ? { label: 'Node.js', evidence: 'package.json' } : undefined),
  dep('ink', 'Ink (TUI)', 'ui'),
  dep('react', 'React', 'ui'),
  dep('vue', 'Vue', 'ui'),
  dep('svelte', 'Svelte', 'ui'),
  dep('next', 'Next.js', 'ui'),
  dep('@angular/core', 'Angular', 'ui'),
  (c) => {
    const ui = c.files.filter((f) => UI_FILE.test(f));
    if (!ui.length) return undefined;
    const dirs = new Map<string, number>();
    for (const f of ui) {
      const d = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
      dirs.set(d, (dirs.get(d) ?? 0) + 1);
    }
    const [top] = [...dirs].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
    const ext = path.extname(ui.find((f) => f.startsWith(`${top}/`)) ?? ui[0]!);
    return { label: 'Componentes UI', cat: 'ui', evidence: `${top}/*${ext}` };
  },
  (c) => {
    const d = dirsMatching(c.files, UI_DIR)[0];
    return d ? { label: 'Carpeta de UI', cat: 'ui', evidence: `${d}/` } : undefined;
  },
  dep('@modelcontextprotocol/sdk', 'MCP server', 'server'),
  dep('express', 'Express', 'server'),
  dep('hono', 'Hono', 'server'),
  dep('fastify', 'Fastify', 'server'),
  dep('koa', 'Koa', 'server'),
  (c) => {
    if (!usesBun(c)) return undefined;
    let budget = SCAN_BUDGET_BYTES;
    const hit = c.files
      .filter((f) => SOURCE.test(f) && !TEST_FILE.test(f))
      .slice(0, MAX_SCAN)
      .find((f) => {
        if (budget <= 0) return false;
        try {
          const p = path.join(c.cwd, f);
          const size = fs.statSync(p).size;
          if (size > MAX_SCAN_BYTES || size > budget) return false;
          budget -= size;
          return fs.readFileSync(p, 'utf8').includes('Bun.serve(');
        } catch {
          return false;
        }
      });
    return hit ? { label: 'Bun.serve', cat: 'server', evidence: hit } : undefined;
  },
  file('PHP (Composer)', 'server', /^composer\.json$/),
  file('Python', 'server', /^(pyproject\.toml|setup\.py|requirements[^/]*\.txt)$/),
  file('Go', 'server', /^go\.mod$/),
  file('Rust', 'server', /^Cargo\.toml$/),
  (c) => {
    const d = dirsMatching(c.files, API_DIR)[0];
    return d ? { label: 'Carpeta de API', cat: 'server', evidence: `${d}/` } : undefined;
  },
  file('Docker', 'devops', /(^|\/)(Dockerfile[^/]*|Containerfile|(docker-)?compose[^/]*\.ya?ml)$/),
  file('GitHub Actions', 'devops', /^\.github\/workflows\//),
  file('GitLab CI', 'devops', /^\.gitlab-ci\.yml$/),
  file('CI', 'devops', /^(Jenkinsfile|bitbucket-pipelines\.yml|\.circleci\/)/),
  file('SQL', 'db', /\.sql$/),
  (c) => {
    const d = dirsMatching(c.files, /^migrations?$/)[0];
    return d ? { label: 'Migraciones', cat: 'db', evidence: `${d}/` } : undefined;
  },
  (c) => {
    const tests = c.files.filter((f) => TEST_FILE.test(f) || f.split('/').slice(0, -1).some((s) => TEST_DIR.test(s)));
    return tests.length ? { label: 'Tests', cat: 'test', evidence: `${tests.length} fichero${tests.length === 1 ? '' : 's'} de test` } : undefined;
  },
];

function readDeps(cwd: string) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }));
  } catch {
    return new Set<string>();
  }
}

function signalsOf(cwd: string, files = listProjectFiles(cwd)): Signal[] {
  const set = new Set(files);
  const ctx: Ctx = { cwd, files, deps: readDeps(cwd), has: (f) => set.has(f) };
  return DETECTORS.flatMap((d) => {
    try {
      return d(ctx) ?? [];
    } catch {
      return [];
    }
  });
}

/** Human-readable stack labels («TypeScript», «Ink (TUI)», «MCP server»…), in a stable order. */
export function detectStack(cwd: string, files?: string[]): { signals: string[] } {
  return { signals: signalsOf(cwd, files).map((s) => s.label) };
}

// ------------------------------------------------------------------ team

const GENERIC: Record<string, Pick<Role, 'name' | 'title' | 'accessory' | 'color' | 'writes' | 'description'> & { mission: string }> = {
  frontend: { name: 'Frontend', title: 'Frontend Developer', accessory: 'beret', color: 'magenta', writes: true, description: 'Implements UI changes inside the assigned paths.', mission: 'You implement user-interface changes correctly, minimally and with tests, inside the paths your coordinator assigned.' },
  backend: { name: 'Backend', title: 'Backend Developer', accessory: 'helmet', color: 'green', writes: true, description: 'Implements server-side changes inside the assigned paths.', mission: 'You implement server-side changes correctly, minimally and with tests, inside the paths your coordinator assigned.' },
  devops: { name: 'DevOps', title: 'DevOps Engineer', accessory: 'cap', color: 'orange', writes: true, description: 'Owns build, containers and CI inside the assigned paths.', mission: 'You own build, containers and CI/CD: you change them safely and verify they still work.' },
  dba: { name: 'DBA', title: 'Database Administrator', accessory: 'glasses', color: 'yellow', writes: true, description: 'Owns schema, migrations and queries.', mission: 'You own the schema, migrations and query performance; every migration must be reversible and tested.' },
  qa: { name: 'QA', title: 'QA / Tester', accessory: 'cap', color: 'green', writes: true, description: 'Writes and runs tests; validates acceptance criteria with evidence.', mission: 'You validate acceptance criteria with evidence: you write and run tests and report exact results.' },
  reviewer: { name: 'Reviewer', title: 'Code Reviewer', accessory: 'glasses', color: 'cyan', writes: false, description: 'Reviews diffs for correctness, design and conventions.', mission: 'You review diffs for correctness, design, readability and adherence to conventions, and report findings by severity.' },
};

/** Ephemeral stand-in for a required role missing from the library (session only). */
function genericRole(id: string): Role {
  const g = GENERIC[id]!;
  const { mission, ...rest } = g;
  return {
    id,
    ...rest,
    prompt: `## Mission\n${mission}\n\n## Rules\n- Stay inside your responsibility and the paths assigned to you; delegate the rest.\n- Use the project's own scripts; fix the code, never weaken tests.\n- Report what you did, the commands you ran and their results.`,
    scope: 'project',
    file: '',
  };
}

const LABEL: Record<string, string> = { frontend: 'interfaz', backend: 'servidor/API', devops: 'Docker/CI', dba: 'SQL/migraciones' };
const CAT: Record<string, Category> = { frontend: 'ui', backend: 'server', devops: 'devops', dba: 'db' };

/** Evidence of a category as one short line, e.g. "src/ui/*.tsx con Ink (TUI), React". */
function evidence(signals: Signal[], cat: Category) {
  const of = signals.filter((s) => s.cat === cat);
  const paths = of.filter((s) => !s.evidence.endsWith('package.json')).map((s) => s.evidence);
  const deps = of.filter((s) => s.evidence.endsWith('package.json')).map((s) => s.label);
  return [paths.slice(0, 2).join(', '), deps.length ? `con ${deps.join(', ')}` : ''].filter(Boolean).join(' ');
}

/**
 * Team for the detected stack: lead (cto, else pm, else a generated coordinator) + the
 * specialists the stack needs + qa + reviewer. Roles missing from the library are generated.
 */
export function proposeRoleTeam(cwd: string, library: Role[], files?: string[]): RoleTeamProposal {
  const signals = signalsOf(cwd, files);
  const lib = new Map(library.map((r) => [r.id, r]));
  const members: RoleTeamProposal['members'] = [];
  const add = (id: string, reason: string) => {
    const role = lib.get(id);
    members.push({ role: role ?? genericRole(id), reason, generated: !role });
  };

  const leadRole = lib.get('cto') ?? lib.get('pm') ?? lib.get('coordinator');
  if (leadRole) members.push({ role: leadRole, reason: `${leadRole.id}: coordina el equipo, reparte el trabajo e integra los resultados`, generated: false });
  else members.push({ role: coordinatorRole(), reason: 'coordinator: no hay cto, pm ni coordinator en la librería; se genera un coordinador', generated: true });

  for (const id of ['frontend', 'backend', 'devops', 'dba']) {
    const ev = evidence(signals, CAT[id]!);
    if (ev) add(id, `${id}: ${LABEL[id]} detectado (${ev})`);
  }
  const tests = signals.find((s) => s.cat === 'test');
  add('qa', `qa: siempre; valida los criterios de aceptación${tests ? ` (${tests.evidence})` : ''}`);
  add('reviewer', 'reviewer: siempre; revisa cada cambio antes de integrarlo');

  return { lead: members[0]!.role.id, members };
}
