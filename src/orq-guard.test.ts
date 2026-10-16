import { describe, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { denyRules, orqDataAccess } from './orq-guard.ts';

const cwd = '/work/my project';
const home = path.join(os.homedir(), '.orq');
const blocked = (tool: string, input: Record<string, unknown>) => orqDataAccess(tool, input, cwd, home) !== undefined;

describe('orqDataAccess', () => {
  test('file tools: relative, absolute, home and glob paths into .orq', () => {
    expect(blocked('Read', { file_path: '.orq/runs/1/events.jsonl' })).toBe(true);
    expect(blocked('Read', { file_path: `${cwd}/.orq/runs/1/LOG.md` })).toBe(true);
    expect(blocked('Read', { file_path: '~/.orq/private/x/mcp.json' })).toBe(true);
    expect(blocked('Edit', { file_path: `${home}/roles/a.md` })).toBe(true);
    expect(blocked('Grep', { pattern: 'x', path: '.orq' })).toBe(true);
    expect(blocked('Glob', { pattern: '**/.orq/**' })).toBe(true);
  });

  test('file tools: normal project files pass', () => {
    expect(blocked('Read', { file_path: 'src/orq.ts' })).toBe(false);
    expect(blocked('Read', { file_path: 'docs/.orqrc' })).toBe(false);
    expect(blocked('Grep', { pattern: '\\.orq', path: 'src' })).toBe(false);
    expect(blocked('mcp__company__send_message', { body: 'mira .orq/runs' })).toBe(false);
  });

  test('Bash: paths into .orq are blocked, escaped searches and look-alikes pass', () => {
    for (const command of ['cat .orq/runs/1/events.jsonl', 'ls ~/.orq', 'tail "$HOME/.orq/index/a.json"', 'cd .orq && ls', `head '${cwd}/.orq/runs/x'`, 'find ./.orq -name "*.md"'])
      expect(blocked('Bash', { command })).toBe(true);
    for (const command of ['grep -rn "\\.orq" src', 'bun test', 'cat src/foo.orq.ts', 'ls docs'])
      expect(blocked('Bash', { command })).toBe(false);
  });

  test('deny rules use absolute // paths for the project and ORQ_HOME', () => {
    expect(denyRules(cwd, home)).toEqual([`Read(//work/my project/.orq/**)`, `Edit(//work/my project/.orq/**)`, `Read(/${home}/**)`, `Edit(/${home}/**)`]);
  });
});
