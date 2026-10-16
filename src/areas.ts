import fs from 'node:fs';
import path from 'node:path';
import { makeId } from './library.ts';
import type { Role } from './types.ts';

/*
 * Team composition by code area: one writer per disjoint set of paths.
 *
 * Path semantics (relative to cwd, no leading "./", trailing "/" ignored):
 *   "src/ui"  a directory, recursive (or a single file)
 *   "src/*"   only the files directly inside src/ (not its subdirectories)
 *   "*"       only the files directly in the root
 */

export const DEFAULT_AREA_LIMIT = 8;

export type AreaProposal = {
  id: string;
  name: string;
  paths: string[];
  description: string;
  writes: boolean;
  files: number;
  /** Library role id the area agent builds on ('' = generic area owner). Editable. */
  base: string;
  /** One line: why this area exists and why that base. */
  reason: string;
};
/** `agents` holds area ids; `files` the real files both writers share (at most 20). */
export type AreaIssue = { level: 'error' | 'warning'; message: string; agents?: string[]; path?: string; files?: string[] };

const EXCLUDED = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.orq', 'coverage', '.next', 'target', '__pycache__', '.venv']);
const ROOT_NAME = 'raíz';
const OTHERS_NAME = 'otros';

// Named colours known by the UI (see NAMED in ui/sprites.ts); white/gray left out on purpose.
const COLORS = ['green', 'blue', 'magenta', 'cyan', 'orange', 'teal', 'purple', 'pink', 'yellow', 'red'];
// Same list as ACCESSORIES in ui/sprites.ts, duplicated to keep the core free of UI imports.
const ACCESSORIES = ['tie', 'glasses', 'cap', 'headset', 'beret', 'visor', 'bowtie', 'helmet', 'hood', 'tophat', 'crown', 'none'];

export const areaId = (name: string) => `area-${makeId(name)}`;

const normalize = (p: string) => {
  const s = path.posix.normalize(p.trim().replace(/\\/g, '/')).replace(/\/{2,}/g, '/');
  return s === '.' || s === './' ? '' : s.replace(/^\.\//, '').replace(/(.)\/+$/, '$1');
};

/** Why a path cannot be owned (absolute, "..", unsupported glob, whole project), or undefined. */
function invalidPath(raw: string): string | undefined {
  const p = normalize(raw);
  if (!p || p === '/' || p === '.') return 'apunta a todo el proyecto: usa "*" para los ficheros sueltos de la raíz o carpetas concretas';
  if (p.startsWith('/') || /^[a-zA-Z]:\//.test(p)) return 'es absoluta: usa rutas relativas al proyecto';
  if (p.split('/').includes('..')) return 'sale del proyecto ("..")';
  const body = p === '*' ? '' : p.endsWith('/*') ? p.slice(0, -2) : p;
  if (/[*?[\]{}]/.test(body)) return 'usa un patrón no soportado: solo se admite "dir/*" o "*"';
  return undefined;
}

/** "dir/*" or "*" → the directory whose direct files it covers; otherwise undefined. */
const looseDir = (p: string) => (p === '*' ? '' : p.endsWith('/*') ? p.slice(0, -2) : undefined);
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const contains = (dir: string, p: string) => dir === '' || p === dir || p.startsWith(dir + '/');
/** Without a filesystem, a basename with an extension is taken as a file. */
const looksLikeFile = (p: string) => /[^/.][^/]*\.[^/.]+$/.test(p);

function overlap(a: string, b: string, isFile: (p: string) => boolean): boolean {
  const x = normalize(a);
  const y = normalize(b);
  const lx = looseDir(x);
  const ly = looseDir(y);
  if (lx !== undefined && ly !== undefined) return lx === ly;
  if (lx === undefined && ly === undefined) return contains(x, y) || contains(y, x);
  const [dir, other] = lx !== undefined ? [lx, y] : [ly!, x];
  // A recursive path covering the loose dir, or a file sitting directly in it.
  if (contains(other, dir)) return true;
  return parentOf(other) === dir && isFile(other);
}

export function pathsOverlap(a: string, b: string): boolean {
  return overlap(a, b, looksLikeFile);
}

// ------------------------------------------------------------------ files

const MAX_WALK_FILES = 50_000;
const GIT_TIMEOUT_MS = 5000;
const excluded = (f: string) => f.split('/').some((seg) => EXCLUDED.has(seg));

function git(cwd: string, args: string[]): string[] | undefined {
  const r = Bun.spawnSync(['git', ...args, '-z'], { cwd, stdout: 'pipe', stderr: 'ignore', timeout: GIT_TIMEOUT_MS });
  if (r.exitCode !== 0) return undefined;
  return r.stdout.toString().split('\0').filter(Boolean);
}

function gitFiles(cwd: string): string[] | undefined {
  try {
    const files = git(cwd, ['ls-files', '-co', '--exclude-standard']);
    if (!files?.length) return undefined;
    // -c also lists tracked files deleted from the worktree.
    const deleted = new Set(git(cwd, ['ls-files', '-d']) ?? []);
    return files.filter((f) => !excluded(f) && !deleted.has(f));
  } catch {
    return undefined;
  }
}

function walkFiles(cwd: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_WALK_FILES) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!EXCLUDED.has(e.name)) walk(p);
      } else if (e.isFile()) out.push(p);
    }
  };
  walk('');
  return out;
}

/**
 * Project files relative to cwd, without dependency/build/vcs directories: git's tracked +
 * untracked non-ignored files, or a filesystem walk (capped) outside git or when git lists none.
 * Callers may cache it per cwd and pass it to proposeAreas/validateAreas/detectStack.
 */
export function listProjectFiles(cwd: string): string[] {
  try {
    if (!fs.statSync(cwd).isDirectory()) return [];
    const files = gitFiles(cwd) ?? walkFiles(cwd);
    return files.map((f) => f.replace(/\\/g, '/')).filter((f) => !excluded(f));
  } catch {
    return [];
  }
}

// --------------------------------------------------------------- proposal

type Candidate = { name: string; paths: string[]; files: string[]; origin: string };

/** Direct subdirectories (with files) and loose files of a directory. */
function split(dir: string, files: string[]) {
  const subdirs = new Map<string, string[]>();
  const loose: string[] = [];
  for (const f of files) {
    const rest = dir ? f.slice(dir.length + 1) : f;
    const i = rest.indexOf('/');
    if (i < 0) loose.push(f);
    else {
      const sub = dir ? `${dir}/${rest.slice(0, i)}` : rest.slice(0, i);
      if (!subdirs.has(sub)) subdirs.set(sub, []);
      subdirs.get(sub)!.push(f);
    }
  }
  const out: Candidate[] = [...subdirs].map(([sub, list]) => ({
    name: sub,
    paths: [sub],
    files: list,
    origin: dir ? `Subdirectorio de ${dir} (${dir} reunía ≥25% de los ficheros)` : 'Directorio de primer nivel',
  }));
  if (loose.length)
    out.push({
      name: dir ? `${dir}/*` : ROOT_NAME,
      paths: [dir ? `${dir}/*` : '*'],
      files: loose,
      origin: dir ? `Ficheros sueltos de ${dir}` : 'Ficheros sueltos de la raíz',
    });
  return { out, hasSubdirs: subdirs.size > 0 };
}

function describe(files: string[]) {
  const count = new Map<string, number>();
  for (const f of files) {
    const base = f.slice(f.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot) : base;
    count.set(ext, (count.get(ext) ?? 0) + 1);
  }
  const top = [...count]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([e]) => e);
  return `${files.length} fichero${files.length === 1 ? '' : 's'} · ${top.join(', ')}`;
}

// Heuristic base role of an area, from file names, extensions and directories.
const TEST_DIR = /^(tests?|__tests__|specs?|e2e)$/i;
const TEST_FILE = /\.(test|spec)\.[^.]+$|_test\.[^.]+$/;
const BASES = ['frontend', 'backend', 'devops', 'dba'] as const;
const CLASSIFY: Record<(typeof BASES)[number], { ext?: RegExp; seg?: RegExp; name?: RegExp }> = {
  frontend: { ext: /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html|astro)$/i, seg: /^(ui|frontend|web|client|components|pages|views|styles|assets)$/i },
  backend: {
    ext: /\.(php|py|go|rs|java|rb|cs|kt|ex|exs)$/i,
    seg: /^(server|api|backend|services|controllers|handlers|routes)$/i,
    name: /(server|mcp|api|hq|handler|controller|service|repository|router)/i,
  },
  devops: {
    seg: /^(\.github|\.circleci|docker|deploy|infra|k8s|helm)$/i,
    name: /^(Dockerfile.*|Containerfile|Jenkinsfile|(docker-)?compose.*\.ya?ml|\.gitlab-ci\.yml|bitbucket-pipelines\.yml|.*\.tf)$/i,
  },
  dba: { ext: /\.sql$/i, seg: /^(migrations?|sql)$/i },
};

function classify(file: string): (typeof BASES)[number] | undefined {
  const segs = file.split('/');
  const base = segs.pop()!;
  for (const b of BASES) {
    const c = CLASSIFY[b];
    if (c.ext?.test(base) || c.name?.test(base) || segs.some((s) => c.seg?.test(s))) return b;
  }
  return undefined;
}

function guessBase(c: Candidate): { base: string; writes: boolean; why: string } {
  const testDir = c.paths.some((p) => looseDir(p) === undefined && TEST_DIR.test(p.split('/').pop()!));
  if (testDir || c.files.every((f) => TEST_FILE.test(f)))
    return { base: 'qa', writes: false, why: 'base qa: contiene tests, solo lectura por defecto' };
  const count = new Map<string, number>();
  for (const f of c.files) {
    const b = classify(f);
    if (b) count.set(b, (count.get(b) ?? 0) + 1);
  }
  const [best, second] = BASES.map((b) => [b, count.get(b) ?? 0] as const).sort((x, y) => y[1] - x[1]) as [readonly [string, number], readonly [string, number]];
  // A clear majority of the area, or a clear winner among its classified files.
  if (best[1] && (best[1] * 10 >= c.files.length * 4 || (best[1] >= 2 && best[1] >= second[1] * 2)))
    return { base: best[0], writes: true, why: `base ${best[0]}: ${best[1]} de ${c.files.length} ficheros son de ${best[0]}` };
  return { base: '', writes: true, why: 'sin rol base claro: dueño de área genérico' };
}

/**
 * Deterministic split of the project into at most `limit` disjoint writer areas:
 * top-level directories (+ root files), expanding directories that hold >=25% of the
 * files and merging the smallest areas into "otros" when there are too many.
 */
export function proposeAreas(cwd: string, opts: { limit?: number; files?: string[] } = {}): AreaProposal[] {
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_AREA_LIMIT));
  const files = opts.files ?? listProjectFiles(cwd);
  if (!files.length) return [];
  const total = files.length;

  let areas = split('', files).out;

  // Expand, biggest first, every directory with subdirectories holding >=25% of the files, while it fits.
  const done = new Set<string>();
  for (;;) {
    const candidates = areas
      .filter((a) => a.paths.length === 1 && looseDir(a.paths[0]!) === undefined && !done.has(a.paths[0]!) && a.files.length * 4 >= total)
      .sort((a, b) => b.files.length - a.files.length || (a.paths[0]! < b.paths[0]! ? -1 : 1));
    let changed = false;
    for (const big of candidates) {
      done.add(big.paths[0]!);
      const { out, hasSubdirs } = split(big.paths[0]!, big.files);
      if (!hasSubdirs || areas.length - 1 + out.length > limit) continue;
      areas = [...areas.filter((a) => a !== big), ...out];
      changed = true;
      break;
    }
    if (!changed) break;
  }

  // Merge the smallest areas into "otros" until the limit is met.
  if (areas.length > limit) {
    const bySize = [...areas].sort((a, b) => a.files.length - b.files.length || (a.paths[0]! < b.paths[0]! ? -1 : 1));
    const merged = bySize.slice(0, areas.length - limit + 1);
    const others: Candidate = {
      name: OTHERS_NAME,
      paths: merged.flatMap((a) => a.paths).sort(),
      files: merged.flatMap((a) => a.files),
      origin: `Fusión de las ${merged.length} áreas más pequeñas (límite ${limit})`,
    };
    areas = [...areas.filter((a) => !merged.includes(a)), others];
  }

  areas.sort((a, b) => {
    if ((a.name === OTHERS_NAME) !== (b.name === OTHERS_NAME)) return a.name === OTHERS_NAME ? 1 : -1;
    return a.paths[0]! < b.paths[0]! ? -1 : a.paths[0]! > b.paths[0]! ? 1 : 0;
  });

  const seen = new Set<string>();
  return areas.map((a) => {
    let id = areaId(a.name);
    for (let n = 2; seen.has(id); n++) id = `${areaId(a.name)}-${n}`;
    seen.add(id);
    const g = guessBase(a);
    return { id, name: a.name, paths: a.paths, description: describe(a.files), writes: g.writes, files: a.files.length, base: g.base, reason: `${a.origin}; ${g.why}.` };
  });
}

// ------------------------------------------------------------- validation

/** Most specific path covered by both (normalized) overlapping paths. */
function collision(x: string, y: string) {
  const lx = looseDir(x);
  const ly = looseDir(y);
  if (lx === undefined && ly === undefined) return x.length >= y.length ? x : y;
  if (lx !== undefined && ly !== undefined) return x;
  const [loose, other] = lx !== undefined ? [x, y] : [y, x];
  return contains(other, looseDir(loose)!) ? loose : other;
}

const covers = (p: string, file: string) => {
  const dir = looseDir(p);
  return dir !== undefined ? parentOf(file) === dir : contains(p, file);
};

/** Real project files (see listProjectFiles) covered by any of the paths. */
export function resolvePaths(cwd: string, paths: string[], files = listProjectFiles(cwd)): string[] {
  const ps = paths.map(normalize);
  return files.filter((f) => ps.some((p) => covers(p, f))).sort();
}

const MAX_ISSUE_FILES = 20;

/**
 * Problems of a set of areas; any 'error' must block the launch. Paths are checked against the
 * real project files (`files`, default listProjectFiles(cwd)), case-sensitively.
 */
export function validateAreas(areas: AreaProposal[], cwd: string, files?: string[]): AreaIssue[] {
  const issues: AreaIssue[] = [];
  if (!areas.length) return [{ level: 'error', message: 'No hay ninguna área: añade al menos una.' }];

  const ids = new Map<string, number>();
  for (const a of areas) ids.set(a.id, (ids.get(a.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) issues.push({ level: 'error', message: `Id de área duplicado: "${id}" (${n} veces).`, agents: [id] });

  const project = files ?? listProjectFiles(cwd);
  const projectSet = new Set(project);
  const isFile = (p: string) => projectSet.has(p);

  const bad = new Set<AreaProposal>();
  for (const a of areas)
    for (const p of a.paths) {
      const why = invalidPath(p);
      if (!why) continue;
      bad.add(a);
      issues.push({ level: 'error', message: `La ruta "${p}" de "${a.name}" ${why}.`, agents: [a.id], path: p });
    }

  const writers = areas.filter((a) => a.writes && !bad.has(a));
  const owned = new Map(writers.map((a) => [a, new Set(resolvePaths(cwd, a.paths, project))]));
  for (let i = 0; i < writers.length; i++)
    for (let j = i + 1; j < writers.length; j++) {
      const a = writers[i]!;
      const b = writers[j]!;
      const fb = owned.get(b)!;
      const shared = [...owned.get(a)!].filter((f) => fb.has(f));
      let at: string | undefined;
      let pair = '';
      for (const pa of a.paths)
        for (const pb of b.paths)
          if (!at && overlap(pa, pb, isFile)) {
            const x = normalize(pa);
            const y = normalize(pb);
            // The more specific path is where both writers collide.
            at = collision(x, y);
            pair = `"${x || '.'}" / "${y || '.'}"`;
          }
      if (shared.length) {
        at ??= shared[0]!;
        issues.push({
          level: 'error',
          message: `"${a.name}" y "${b.name}" pueden escribir en "${at}": comparten ${shared.length} fichero${shared.length === 1 ? '' : 's'}${pair ? ` (${pair})` : ''}.`,
          agents: [a.id, b.id],
          path: at,
          files: shared.slice(0, MAX_ISSUE_FILES),
        });
      } else if (at)
        issues.push({
          level: 'warning',
          message: `Las rutas de "${a.name}" y "${b.name}" se solapan en "${at}" (${pair}), aunque hoy no comparten ficheros.`,
          agents: [a.id, b.id],
          path: at,
        });
    }

  for (const a of areas) {
    if (!a.paths.length)
      issues.push(
        a.writes
          ? { level: 'error', message: `"${a.name}" puede escribir pero no tiene rutas asignadas.`, agents: [a.id] }
          : { level: 'warning', message: `"${a.name}" no tiene rutas asignadas.`, agents: [a.id] },
      );
    for (const p of a.paths) {
      if (invalidPath(p)) continue;
      const n = normalize(p);
      if (looseDir(n) !== undefined) continue;
      if (project.some((f) => contains(n, f))) continue;
      // Case-insensitive filesystems (macOS) would accept it, but ownership is by exact name.
      const lower = n.toLowerCase();
      const real = project.find((f) => f.toLowerCase() === lower || f.toLowerCase().startsWith(lower + '/'))?.slice(0, n.length);
      if (real)
        issues.push({ level: 'error', message: `La ruta "${n}" de "${a.name}" no coincide en mayúsculas: usa el nombre exacto "${real}".`, agents: [a.id], path: n });
      else
        issues.push({ level: 'warning', message: `La ruta "${n}" de "${a.name}" no existe en el proyecto (o no tiene ficheros).`, agents: [a.id], path: n });
    }
  }
  return issues;
}

// ------------------------------------------------------------------ roles

/**
 * Ephemeral role (session only, never saved by itself) that owns the paths of one area.
 * When `area.base` is a library role, its body follows the area section.
 */
export function areaRole(area: AreaProposal, index: number, library: Role[] = []): Role {
  const paths = area.paths.map((p) => `- \`${p}\``).join('\n') || '- (none assigned yet: ask your coordinator)';
  const verb = area.writes ? 'implement changes' : 'validate (read-only: run the checks, report and request changes from the owners)';
  const base = area.base ? library.find((r) => r.id === area.base) : undefined;
  return {
    id: area.id,
    name: area.name,
    title: `Área ${area.name}`,
    accessory: ACCESSORIES[index % ACCESSORIES.length]!,
    color: COLORS[index % COLORS.length]!,
    writes: area.writes,
    model: base?.model,
    description: `${area.paths.join(', ')} — ${base ? `${base.title} owning this code area` : 'owner of this code area'} (${area.description})`,
    prompt: `## Mission
You are the owner of a code area of this project. You ${verb} inside your OWNED PATHS correctly,
minimally and with tests, and you are the reference for anyone who needs something there.

## OWNED PATHS
${paths}

Path semantics: a directory is recursive; \`dir/*\` means only the files directly inside \`dir\`
(not its subdirectories); \`*\` means only the files directly in the project root.

## Rules
- Never edit files outside your OWNED PATHS; when a change is needed elsewhere, ask its owner via delegate_task/send_message.
- If no colleague owns the path you need, ask your coordinator instead of editing it yourself.
- Read the surrounding code first and match its conventions; keep changes minimal, no drive-by refactors.
- Use the project's own scripts to test; fix the code, never weaken tests.
${
      area.writes
        ? '- Test files (`*.test.*`, `*.spec.*`) inside your OWNED PATHS are yours too.\n'
        : '- You are the READ-ONLY area that validates: never edit files, not even inside your OWNED PATHS. Run the checks, report findings with evidence and ask the owners of the affected paths for the changes.\n'
    }- Report what you changed, the commands you ran and their results, and anything left open.${
      base ? `\n\n## Base role: ${base.title}\n${base.prompt || base.description}` : ''
    }`,
    scope: 'project',
    file: '',
    area: { paths: [...area.paths] },
  };
}

/** Fallback lead of an area team when the library has no suitable coordinator role. */
export function coordinatorRole(): Role {
  return {
    id: 'coordinator',
    name: 'Coordinador',
    title: 'Coordinador',
    accessory: 'headset',
    color: 'white',
    writes: false,
    description: 'Splits the work between the code areas by their OWNED PATHS, integrates and validates. Never edits.',
    prompt: `## Mission
You coordinate a team organised by code areas: each colleague owns a disjoint set of paths
(listed in its description and in its "## OWNED PATHS"). You turn the user's goal into tasks,
route each task to the owner of the paths it touches, and integrate and validate the result.

## Rules
- You never edit files yourself.
- Split work by OWNED PATHS: every change goes to the agent that owns the path. If a change spans
  several areas, give each owner its part and state the contract between the parts.
- Never ask an agent to edit paths outside its OWNED PATHS. If no area owns a path, decide who
  should own it and tell both the agent and the user.
- Sequence dependent work (contract first, then consumers) and run the project's validation
  after integrating. Report the outcome to the user with evidence.`,
    scope: 'project',
    file: '',
  };
}
