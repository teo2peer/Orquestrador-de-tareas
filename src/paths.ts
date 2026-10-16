import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_ROOT = path.resolve(import.meta.dir, '..');
/** The user's real orq home; tests and smoke runs must never use it (see test-setup.ts). */
export const REAL_ORQ_HOME = path.join(os.homedir(), '.orq');
export const ORQ_HOME = process.env.ORQ_HOME ?? REAL_ORQ_HOME;
export const PROJECT_DIR = process.cwd();
export const PROJECT_ORQ = path.join(PROJECT_DIR, '.orq');
/** Git-ignored folder with the owner's private roles/departments, merged into ORQ_HOME. */
export const PRIVATE_DIR = path.join(APP_ROOT, 'private');
export const MCP_SCRIPT = path.join(APP_ROOT, 'src', 'mcp-server.ts');
export const HOOK_SCRIPT = path.join(APP_ROOT, 'src', 'hook.ts');

export const libDir = (scope: 'global' | 'project', kind: 'roles' | 'departments') =>
  path.join(scope === 'global' ? ORQ_HOME : PROJECT_ORQ, kind);

/**
 * Smoke/render tests of the app must run as `ORQ_SAFE=1 ORQ_HOME=$(mktemp -d) bun src/cli.tsx`.
 * The real protection is that temporary ORQ_HOME (and, in `bun test`, the private tmux socket of
 * test-setup.ts); ORQ_SAFE=1 is a safety net: the app refuses to start on the real ~/.orq and
 * tmux only touches sessions of runs created by that process. Throws with the reason, or returns.
 */
export function assertSafeHome(env: Record<string, string | undefined> = process.env, home = ORQ_HOME) {
  if (env.ORQ_SAFE === '1' && path.resolve(home) === path.resolve(REAL_ORQ_HOME))
    throw new Error(`ORQ_SAFE=1 refuses to use the real ${REAL_ORQ_HOME}: run with ORQ_HOME=$(mktemp -d)`);
}

/** Copy files missing in `dest` from `src` (never overwrites user files). */
function seedMissing(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const from = path.join(src, f);
    const to = path.join(dest, f);
    if (fs.statSync(from).isFile() && !fs.existsSync(to)) fs.copyFileSync(from, to);
  }
}

/**
 * Seed ~/.orq with the default company on first run, then add any private roles/departments
 * from `private/` (never overwrites user files).
 */
export function ensureHome() {
  try {
    assertSafeHome();
  } catch (e: any) {
    console.error(`orq: ${e.message}`);
    process.exit(2);
  }
  for (const kind of ['roles', 'departments'] as const) {
    const dest = libDir('global', kind);
    if (!fs.existsSync(dest)) seedMissing(path.join(APP_ROOT, 'defaults', kind), dest);
    seedMissing(path.join(PRIVATE_DIR, kind), dest);
  }
  fs.mkdirSync(path.join(ORQ_HOME, 'packs'), { recursive: true });
}
