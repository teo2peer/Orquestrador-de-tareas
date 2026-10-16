import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TTL_1H, TTL_5M, contextTokens, lastRequest, lastUsage, runTokenCost, runTokenUsage, transcriptTokens } from './tokens.ts';
import type { RunMeta } from './types.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-tokens-test-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const assistant = (id: string, usage: Record<string, number>) => JSON.stringify({ type: 'assistant', message: { id, usage, content: [] } });
function transcript(name: string, lines: string[]) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

const M1 = assistant('m1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 });
const T1 = transcript('s1.jsonl', [
  JSON.stringify({ type: 'user', message: { content: 'hi' } }),
  M1,
  // Same request split in two entries: counted once.
  assistant('m2', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }),
  assistant('m2', { input_tokens: 1, output_tokens: 7, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }),
  'not json',
  JSON.stringify({ type: 'user', message: { content: 'last' } }),
]);

describe('tokens', () => {
  test('contextTokens: input + cache read + cache creation of the last assistant request', () => {
    expect(contextTokens(T1)).toBe(1001);
    expect(contextTokens(undefined)).toBeUndefined();
    expect(contextTokens(path.join(dir, 'missing.jsonl'))).toBeUndefined();
  });

  test('transcriptTokens: every request once, input + output + cache', () => {
    expect(transcriptTokens(T1)).toBe(135 + 1008);
    expect(transcriptTokens(path.join(dir, 'missing.jsonl'))).toBe(0);
  });

  test('runTokenUsage adds previous sessions of each agent', () => {
    transcript('s0.jsonl', [assistant('old', { input_tokens: 50, output_tokens: 50 })]);
    const meta = { agents: [{ id: 'a', transcript: T1, prevSessionIds: ['s0', 'gone'] }, { id: 'b' }] } as unknown as RunMeta;
    expect(runTokenUsage(meta)).toEqual({ perAgent: { a: 1143 + 100, b: 0 }, total: 1243 });
  });

  test("requests repeated across an agent's files (after --resume) count once", () => {
    const resumed = transcript('s2.jsonl', [M1, assistant('new', { output_tokens: 7 })]);
    const meta = { agents: [{ id: 'a', transcript: resumed, prevSessionIds: ['s1'] }] } as unknown as RunMeta;
    expect(runTokenUsage(meta).total).toBe(1143 + 7);
  });

  test('a growing transcript is read only from where the last read stopped', () => {
    const f = transcript('c.jsonl', [assistant('c1', { output_tokens: 1 })]);
    const size0 = fs.statSync(f).size;
    expect(transcriptTokens(f)).toBe(1);
    const real = fs.readSync;
    const reads: { length: number; position: number }[] = [];
    (fs as any).readSync = (fd: number, buf: Buffer, off: number, length: number, position: number) => (reads.push({ length, position }), real(fd, buf, off, length, position));
    try {
      expect(transcriptTokens(f)).toBe(1);
      expect(reads).toEqual([]); // unchanged: no read at all
      const added = assistant('c2', { output_tokens: 2 }) + '\n';
      fs.appendFileSync(f, added);
      expect(transcriptTokens(f)).toBe(3);
      expect(reads).toEqual([{ length: Buffer.byteLength(added), position: size0 }]);
      // A partial last line is not counted until it is complete.
      reads.length = 0;
      const line = assistant('c3', { output_tokens: 4 });
      fs.appendFileSync(f, line.slice(0, 20));
      expect(transcriptTokens(f)).toBe(3);
      fs.appendFileSync(f, line.slice(20) + '\n');
      expect(transcriptTokens(f)).toBe(7);
      expect(reads[1]!.position).toBe(size0 + Buffer.byteLength(added));
    } finally {
      (fs as any).readSync = real;
    }
  });

  test('a transcript that shrinks is parsed again from the start', () => {
    const f = transcript('d.jsonl', [assistant('d1', { output_tokens: 5 }), assistant('d2', { output_tokens: 6 })]);
    expect(transcriptTokens(f)).toBe(11);
    fs.writeFileSync(f, assistant('d3', { output_tokens: 1 }) + '\n');
    expect(transcriptTokens(f)).toBe(1);
  });

  test('runTokenCost weights each token type and breaks it down', () => {
    const f = transcript('cost.jsonl', [assistant('k1', { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10_000, output_tokens: 10 })]);
    const meta = { agents: [{ id: 'a', transcript: f }, { id: 'b' }] } as unknown as RunMeta;
    const c = runTokenCost(meta);
    expect(c.byType).toEqual({
      input: { tokens: 100, cost: 100 },
      cacheWrite: { tokens: 1000, cost: 1250 },
      cacheRead: { tokens: 10_000, cost: 1000 },
      output: { tokens: 10, cost: 50 },
    });
    expect(c.total).toBe(2400);
    expect(c.perAgent).toEqual({ a: 2400, b: 0 });
  });

  test('one-hour cache writes are priced at 2×', () => {
    const f = transcript('cost1h.jsonl', [
      JSON.stringify({ type: 'assistant', message: { id: 'h1', usage: { cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 800, ephemeral_5m_input_tokens: 200 } } } }),
    ]);
    const c = runTokenCost({ agents: [{ id: 'a', transcript: f }] } as unknown as RunMeta);
    expect(c.byType.cacheWrite).toEqual({ tokens: 1000, cost: 800 * 2 + 200 * 1.25 });
  });

  test('runTokenUsage finds earlier sessions through transcriptDir when the current transcript is unknown', () => {
    transcript('p1.jsonl', [assistant('p1', { output_tokens: 9 })]);
    const meta = { agents: [{ id: 'a', transcriptDir: dir, prevSessionIds: ['p1'] }] } as unknown as RunMeta;
    expect(runTokenUsage(meta).total).toBe(9);
    expect(runTokenCost(meta).total).toBe(45);
  });

  test('lastRequest: time of the last request and its cache TTL', () => {
    const at = '2026-10-13T10:00:00.000Z';
    const line = (cc: Record<string, number>) => JSON.stringify({ type: 'assistant', timestamp: at, message: { id: 'x', usage: { cache_creation: cc } } });
    expect(lastRequest(transcript('l1.jsonl', [line({ ephemeral_1h_input_tokens: 5 })]))).toEqual({ at: Date.parse(at), ttlMs: TTL_1H });
    expect(lastRequest(transcript('l5.jsonl', [line({ ephemeral_5m_input_tokens: 5 })]))).toEqual({ at: Date.parse(at), ttlMs: TTL_5M });
    expect(lastRequest(undefined)).toBeUndefined();
  });

  test('lastUsage: context, time and TTL of the last request in one read', () => {
    const at = '2026-10-13T10:00:00.000Z';
    const f = transcript('lu.jsonl', [JSON.stringify({ type: 'assistant', timestamp: at, message: { id: 'u', usage: { input_tokens: 5, cache_read_input_tokens: 95, cache_creation: { ephemeral_5m_input_tokens: 3 } } } })]);
    const real = fs.openSync;
    let opens = 0;
    (fs as any).openSync = (...args: any[]) => (opens++, (real as any)(...args));
    try {
      expect(lastUsage(f)).toEqual({ context: 100, at: Date.parse(at), ttlMs: TTL_5M });
      expect(opens).toBe(1);
    } finally {
      (fs as any).openSync = real;
    }
    expect(lastUsage(undefined)).toBeUndefined();
  });
});
