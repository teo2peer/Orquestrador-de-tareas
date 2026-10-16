import fs from 'node:fs';
import path from 'node:path';
import type { RunMeta } from './types.ts';

/*
 * Token accounting from Claude Code transcripts (JSONL). Each assistant entry carries the API
 * `usage` of its request; one request may be split over several entries with the same message id.
 */

/** Bytes read from the end of a transcript to find the last assistant usage. */
const TAIL_BYTES = 512 * 1024;

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Split of cache_creation_input_tokens by TTL, when the API reports it. */
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};

const n = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
/** Tokens in the context window of a request: input + cache read + cache creation. */
const contextOf = (u: Usage) => n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);

function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    // Drop the first (possibly cut) line when not reading from the start.
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

const parse = (line: string) => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** Context size (tokens) of the last assistant request of a transcript; undefined if unknown. */
export function contextTokens(transcript?: string): number | undefined {
  if (!transcript) return undefined;
  try {
    const lines = readTail(transcript, TAIL_BYTES).trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = parse(lines[i]!);
      if (o?.type === 'assistant' && o.message?.usage) return contextOf(o.message.usage);
    }
  } catch {
    /* missing or unreadable transcript */
  }
  return undefined;
}

export const TTL_1H = 3_600_000;
export const TTL_5M = 300_000;

/**
 * Context size and time/TTL of the last assistant request of a transcript, read in one pass over its
 * tail (contextTokens + lastRequest without reading twice); undefined when it has no request yet.
 */
export function lastUsage(transcript?: string): { context: number; at?: number; ttlMs: number } | undefined {
  if (!transcript) return undefined;
  try {
    const lines = readTail(transcript, TAIL_BYTES).trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = parse(lines[i]!);
      const u = o?.type === 'assistant' ? o.message?.usage : undefined;
      if (!u) continue;
      const at = Date.parse(o.timestamp);
      const cc = u.cache_creation;
      const only5m = cc && n(cc.ephemeral_5m_input_tokens) > 0 && !n(cc.ephemeral_1h_input_tokens);
      return { context: contextOf(u), ...(Number.isFinite(at) ? { at } : {}), ttlMs: only5m ? TTL_5M : TTL_1H };
    }
  } catch {
    /* missing or unreadable transcript */
  }
  return undefined;
}

/**
 * Time of the last assistant request of a transcript and the TTL its prompt cache was written with
 * (5 minutes when its usage reports only ephemeral_5m writes, else 1 hour); undefined if unknown.
 */
export function lastRequest(transcript?: string): { at: number; ttlMs: number } | undefined {
  if (!transcript) return undefined;
  try {
    const lines = readTail(transcript, TAIL_BYTES).trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = parse(lines[i]!);
      if (o?.type !== 'assistant' || !o.message?.usage) continue;
      const at = Date.parse(o.timestamp);
      if (!Number.isFinite(at)) return undefined;
      const cc = o.message.usage.cache_creation;
      const only5m = cc && n(cc.ephemeral_5m_input_tokens) > 0 && !n(cc.ephemeral_1h_input_tokens);
      return { at, ttlMs: only5m ? TTL_5M : TTL_1H };
    }
  } catch {
    /* missing or unreadable transcript */
  }
  return undefined;
}

/**
 * Parsed usages per transcript, read incrementally: transcripts only grow while a session runs, so
 * a later call parses just the bytes appended since `offset` (complete lines only). A file that
 * shrank or was rewritten (same size, other mtime) is parsed again from the start.
 */
const cache = new Map<string, { offset: number; size: number; mtimeMs: number; anon: number; usages: Map<string, Usage> }>();

function readRange(file: string, from: number, to: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(to - from);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

/** Usage of every request of a transcript by message id (incremental, see `cache`). */
function usagesOf(transcript: string): Map<string, Usage> {
  let st: fs.Stats;
  try {
    st = fs.statSync(transcript);
  } catch {
    cache.delete(transcript);
    return new Map();
  }
  let entry = cache.get(transcript);
  if (entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs) return entry.usages;
  if (!entry || st.size < entry.size || (st.size === entry.size && st.mtimeMs !== entry.mtimeMs))
    entry = { offset: 0, size: 0, mtimeMs: 0, anon: 0, usages: new Map() };
  try {
    const chunk = readRange(transcript, entry.offset, st.size);
    const end = chunk.lastIndexOf(0x0a); // only complete lines; a partial last line waits
    if (end >= 0) {
      for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) {
        if (!line) continue;
        const o = parse(line);
        const u = o?.type === 'assistant' ? o.message?.usage : undefined;
        if (u) entry.usages.set(String(o.message.id ?? `${transcript}#${entry.anon++}`), u);
      }
      entry.offset += end + 1;
    }
  } catch {
    return entry.usages;
  }
  entry.size = st.size;
  entry.mtimeMs = st.mtimeMs;
  cache.set(transcript, entry);
  return entry.usages;
}

const sum = (usages: Iterable<Usage>) => {
  let total = 0;
  for (const u of usages) total += contextOf(u) + n(u.output_tokens);
  return total;
};

/** Tokens billed by the requests of a transcript (input + output + cache read/creation), deduped by message id. */
export function transcriptTokens(transcript: string): number {
  return sum(usagesOf(transcript).values());
}

/**
 * Tokens used by every agent of a run, current and previous sessions (light resumes and /clear
 * start new transcripts next to the old ones, named <sessionId>.jsonl). Requests are deduped by
 * message id across all the files of an agent (`--resume` copies earlier entries).
 */
export function runTokenUsage(meta: RunMeta): { perAgent: Record<string, number>; total: number } {
  const perAgent: Record<string, number> = {};
  let total = 0;
  for (const a of meta.agents) {
    const t = sum(agentUsages(a).values());
    perAgent[a.id] = t;
    total += t;
  }
  return { perAgent, total };
}

/** Every request of an agent, current and previous sessions, deduped by message id. */
function agentUsages(a: RunMeta['agents'][number]): Map<string, Usage> {
  const files = new Set<string>();
  if (a.transcript) files.add(a.transcript);
  // After a light resume the new session may have no transcript yet: the saved dir still finds the old ones.
  const dir = a.transcript ? path.dirname(a.transcript) : a.transcriptDir;
  if (dir) for (const id of a.prevSessionIds ?? []) files.add(path.join(dir, `${id}.jsonl`));
  const byId = new Map<string, Usage>();
  for (const f of files) for (const [id, u] of usagesOf(f)) byId.set(id, u);
  return byId;
}

export type TokenType = 'input' | 'cacheWrite' | 'cacheRead' | 'output';
/**
 * Relative price of each token type, in input-token units: cache write 1.25× (5-minute TTL),
 * read 0.1×, output 5×. One-hour cache writes cost 2× (CACHE_WRITE_1H): subscriptions get that
 * TTL on their main turns, and the usage reports the split (cache_creation.ephemeral_1h/5m).
 */
export const COST_WEIGHTS: Record<TokenType, number> = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
export const CACHE_WRITE_1H = 2;
export type TokenCost = {
  /** Weighted cost in input-token equivalents. */
  total: number;
  perAgent: Record<string, number>;
  byType: Record<TokenType, { tokens: number; cost: number }>;
};

/** Weighted cost of a run (see COST_WEIGHTS), per agent and broken down by token type. */
export function runTokenCost(meta: RunMeta): TokenCost {
  const byType = Object.fromEntries((Object.keys(COST_WEIGHTS) as TokenType[]).map((k) => [k, { tokens: 0, cost: 0 }])) as TokenCost['byType'];
  const perAgent: Record<string, number> = {};
  let total = 0;
  for (const a of meta.agents) {
    let agentCost = 0;
    for (const u of agentUsages(a).values()) {
      const tokens: Record<TokenType, number> = {
        input: n(u.input_tokens),
        cacheWrite: n(u.cache_creation_input_tokens),
        cacheRead: n(u.cache_read_input_tokens),
        output: n(u.output_tokens),
      };
      // Cache writes priced by TTL when the split is known (the rest at the 5-minute price).
      const write1h = Math.min(n(u.cache_creation?.ephemeral_1h_input_tokens), tokens.cacheWrite);
      for (const k of Object.keys(tokens) as TokenType[]) {
        const c = k === 'cacheWrite' ? write1h * CACHE_WRITE_1H + (tokens[k] - write1h) * COST_WEIGHTS[k] : tokens[k] * COST_WEIGHTS[k];
        byType[k].tokens += tokens[k];
        byType[k].cost += c;
        agentCost += c;
      }
    }
    perAgent[a.id] = agentCost;
    total += agentCost;
  }
  return { total, perAgent, byType };
}
