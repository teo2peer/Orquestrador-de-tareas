import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteDepartment, deptRulesFile, saveDepartment } from './library.ts';

const dept = { id: 'ops', name: 'Ops', icon: '■', color: 'cyan', category: 'General', description: '', roles: ['a', 'b'], lead: 'a', scope: 'project' as const };

describe('department rules', () => {
  test('are saved beside the YAML, removed when emptied and deleted with the department', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-lib-'));
    const file = saveDepartment({ ...dept, rules: '## Contexto\nDocumentar siempre.\n' }, base);
    expect(fs.readFileSync(deptRulesFile(file), 'utf8')).toBe('## Contexto\nDocumentar siempre.\n');
    saveDepartment({ ...dept, rules: '  ' }, base);
    expect(fs.existsSync(deptRulesFile(file))).toBe(false);
    saveDepartment({ ...dept, rules: 'x' }, base);
    deleteDepartment(file);
    expect(fs.existsSync(file) || fs.existsSync(deptRulesFile(file))).toBe(false);
    fs.rmSync(base, { recursive: true });
  });
});
