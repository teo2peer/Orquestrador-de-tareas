import os from 'node:os';
import path from 'node:path';

/**
 * Agents must never read orq's own data: `<cwd>/.orq/` (run logs, events, transcripts, launch configs)
 * and ORQ_HOME (library, index, private configs with MCP secrets). Reading it wastes context and
 * leaks other agents' conversations. Enforced twice: `permissions.deny` rules in each agent's
 * settings.json and this check in the PreToolUse hook (which also covers Bash).
 */

/** Built-in tools and the inputs that hold a path or a glob. */
const PATH_INPUTS: Record<string, string[]> = {
  Read: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Grep: ['path', 'glob'],
  Glob: ['path', 'pattern'],
};

/** `.orq` as a path segment in a shell command: `.orq/…`, `./.orq`, `~/.orq`, `/abs/.orq`, `"$HOME/.orq"`. */
const SHELL_ORQ = /(?:^|[\s'"=:(<>|;&])(?:(?:~|\$HOME|\$\{HOME\}|[^\s'"]*)\/)?\.orq(?:\/|[\s'"]|$)/;

const inside = (file: string, dir: string) => {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Absolute dirs agents may not touch. */
export function protectedDirs(cwd: string, orqHome: string) {
  return [...new Set([path.join(cwd, '.orq'), path.resolve(orqHome)])];
}

/** permissions.deny rules for an agent's settings.json (`//` = absolute path). */
export function denyRules(cwd: string, orqHome: string) {
  return protectedDirs(cwd, orqHome).flatMap((d) => [`Read(/${d}/**)`, `Edit(/${d}/**)`]);
}

/** The protected path a tool call would read or write, or undefined when it is allowed. */
export function orqDataAccess(tool: string, input: Record<string, any>, cwd: string, orqHome: string): string | undefined {
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '');
    return SHELL_ORQ.test(cmd) ? '.orq' : undefined;
  }
  const keys = PATH_INPUTS[tool];
  if (!keys) return undefined;
  const dirs = protectedDirs(cwd, orqHome);
  for (const k of keys) {
    const v = input[k];
    if (typeof v !== 'string' || !v) continue;
    // A glob or path naming the .orq segment anywhere (e.g. "**/.orq/**").
    if (/(^|\/)\.orq(\/|$)/.test(v)) return v;
    const abs = path.resolve(cwd, v.replace(/^~(?=\/|$)/, os.homedir()));
    if (dirs.some((d) => inside(abs, d))) return v;
  }
  return undefined;
}

export const ORQ_DATA_DENIED =
  "Blocked by orq: `.orq/` and `~/.orq/` hold orq's private run data (logs, events, transcripts, configs) and agents must never read, search or edit them. Use the company tools to learn about the team, and your own owned paths for deliverables. To search code for the literal text `.orq`, escape it as `\\.orq`.";
