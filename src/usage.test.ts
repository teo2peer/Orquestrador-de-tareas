import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUsage, readUsage, recordUsage, usageFile, usageLine } from './usage.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-usage-test-'));
const prevEnv = process.env.ORQ_USAGE_FILE;
process.env.ORQ_USAGE_FILE = path.join(dir, 'sub', 'usage.json');
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.ORQ_USAGE_FILE;
  else process.env.ORQ_USAGE_FILE = prevEnv;
});
beforeEach(() => fs.rmSync(path.join(dir, 'sub'), { recursive: true, force: true }));

// Shape documented for the statusLine stdin (code.claude.com/docs/en/statusline).
const SAMPLE = {
  session_id: 'abc',
  model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
    spend_limit: { used_percentage: 62.8, resets_at: 1740787200, used_usd: 314.12, limit_usd: 500, period: 'monthly' },
  },
};

describe('parseUsage', () => {
  test('five_hour and seven_day with reset times in ms; no fable without a source', () => {
    expect(parseUsage(SAMPLE)).toEqual([
      { key: 'five_hour', label: '5 h', pct: 23.5, resetsAt: 1738425600000 },
      { key: 'seven_day', label: 'Semanal', pct: 41.2, resetsAt: 1738857600000 },
    ]);
  });

  test('per-model windows (e.g. fable) are not shown', () => {
    expect(parseUsage({ rate_limits: { seven_day_fable: { used_percentage: 12 } } })).toEqual([]);
  });

  test('missing or malformed rate limits give no metrics', () => {
    for (const x of [null, undefined, 'x', {}, { rate_limits: null }, { rate_limits: { five_hour: { used_percentage: 'n/a' } } }]) expect(parseUsage(x)).toEqual([]);
  });
});

describe('recordUsage / readUsage', () => {
  test('nothing recorded yet', () => {
    expect(readUsage()).toEqual({ snapshot: null });
  });

  test('writes atomically and reads back', () => {
    recordUsage(SAMPLE, 1000);
    expect(readUsage().snapshot).toEqual({ metrics: parseUsage(SAMPLE), updatedAt: 1000 });
    expect(fs.readdirSync(path.dirname(usageFile())).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('payloads without rate limits keep the last snapshot', () => {
    recordUsage(SAMPLE, 1000);
    recordUsage({ model: { display_name: 'Opus' } }, 2000);
    expect(readUsage().snapshot!.updatedAt).toBe(1000);
  });

  test('unchanged usage is rewritten at most once a minute; changes are written at once', () => {
    recordUsage(SAMPLE, 1000);
    recordUsage(SAMPLE, 30_000);
    expect(readUsage().snapshot!.updatedAt).toBe(1000);
    recordUsage(SAMPLE, 70_000);
    expect(readUsage().snapshot!.updatedAt).toBe(70_000);
    recordUsage({ rate_limits: { five_hour: { used_percentage: 50 } } }, 71_000);
    expect(readUsage().snapshot).toEqual({ metrics: [{ key: 'five_hour', label: '5 h', pct: 50 }], updatedAt: 71_000 });
  });

  test('inside the same window a lower percentage is ignored; a new window resets it', () => {
    const at = (pct: number, resets: number) => ({ rate_limits: { five_hour: { used_percentage: pct, resets_at: resets } } });
    recordUsage(at(40, 100), 1000);
    recordUsage(at(30, 100), 2000);
    expect(readUsage().snapshot!.metrics[0]!.pct).toBe(40);
    recordUsage(at(45, 100), 3000);
    expect(readUsage().snapshot!.metrics[0]!.pct).toBe(45);
    recordUsage(at(5, 200), 4000);
    expect(readUsage().snapshot!.metrics[0]).toMatchObject({ pct: 5, resetsAt: 200_000 });
  });

  test('a failed write leaves no temporary file behind', () => {
    fs.mkdirSync(usageFile(), { recursive: true }); // rename onto a directory fails
    expect(() => recordUsage(SAMPLE, 1)).not.toThrow();
    expect(fs.readdirSync(path.dirname(usageFile())).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    fs.rmSync(usageFile(), { recursive: true });
  });

  test('a corrupt file is reported, and recording never throws', () => {
    fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
    fs.writeFileSync(usageFile(), '{nope');
    const r = readUsage();
    expect(r.snapshot).toBeNull();
    expect(r.error).toBeTruthy();
    expect(() => recordUsage(SAMPLE, 1)).not.toThrow();
    expect(readUsage().snapshot!.updatedAt).toBe(1);
  });
});

describe('statusline', () => {
  test('usageLine', () => {
    expect(usageLine(SAMPLE)).toBe('Opus · 5 h 24% · Semanal 41%');
    expect(usageLine({})).toBe('orq');
  });

  test('the command records usage and never fails', () => {
    const script = path.join(import.meta.dir, 'statusline.ts');
    const env = { ...process.env, ORQ_USAGE_FILE: usageFile() };
    const ok = Bun.spawnSync([process.execPath, script], { stdin: Buffer.from(JSON.stringify(SAMPLE)), env });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toBe('Opus · 5 h 24% · Semanal 41%\n');
    expect(readUsage().snapshot!.metrics).toHaveLength(2);
    const bad = Bun.spawnSync([process.execPath, script], { stdin: Buffer.from('not json'), env });
    expect(bad.exitCode).toBe(0);
    expect(bad.stdout.toString()).toBe('orq\n');
  });

  test('the command gives up after 1 s when stdin never closes', async () => {
    const script = path.join(import.meta.dir, 'statusline.ts');
    const p = Bun.spawn([process.execPath, script], { stdin: 'pipe', stdout: 'pipe' });
    const t0 = Date.now();
    expect(await p.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await new Response(p.stdout).text()).toBe('orq\n');
    p.stdin.end();
  });
});
