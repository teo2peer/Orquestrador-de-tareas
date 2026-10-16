#!/usr/bin/env bun
// Reproducible token measurement of orq cost profiles (e.g. max vs saver).
//
// For every profile and repetition it copies a small Bun/TS fixture repo into a temp dir, starts
// HQ directly (no TUI) with the same 4-agent team (cto lead + backend + qa + reviewer, permission
// 'auto'), sends the same scripted task to the lead, waits for the lead's report to the user (or a
// timeout), stops the run (only its own tmux sessions) and measures the transcripts with
// runTokenUsage / runTokenCost. Prints a markdown report and cleans up everything it created.
//
//   bun scripts/measure-profiles.ts --dry-run
//   bun scripts/measure-profiles.ts --n 3 --profiles max,saver --timeout 20m
//
// Every real run spends Claude quota: see scripts/README-measure.md.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = path.resolve(import.meta.dir, '..');

// ------------------------------------------------------------------ arguments

type Args = { n: number; profiles: string[]; timeoutMs: number; dryRun: boolean; keep: boolean; task: string; budget: number };

const DEFAULT_TASK =
  "Añade a src/str.ts una función exportada slugify(s: string): string (minúsculas; espacios y símbolos pasan a '-'; " +
  'sin guiones repetidos ni al principio o al final) con tests en test/str.test.ts. Que backend la implemente, que reviewer ' +
  'revise el cambio y que qa valide con bun test. Repórtame al terminar.';

function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new Error(`Invalid duration "${s}" (e.g. 90s, 20m, 1h)`);
  const n = Number(m[1]);
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 'm') as 'ms' | 's' | 'm' | 'h'];
}

/** "4M", "3500k", "4000000" → tokens. */
function parseTokens(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(s.trim());
  if (!m) throw new Error(`Invalid token amount "${s}" (e.g. 4M, 3500k)`);
  return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 } as Record<string, number>)[(m[2] ?? '').toLowerCase()]! || Number(m[1]));
}

function parseArgs(argv: string[]): Args {
  const a: Args = { n: 1, profiles: ['max', 'saver'], timeoutMs: 20 * 60_000, dryRun: false, keep: false, task: DEFAULT_TASK, budget: 4_000_000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value`);
      return x;
    };
    if (k === '--n') a.n = Math.max(1, parseInt(v(), 10));
    else if (k === '--profiles') a.profiles = v().split(',').map((p) => p.trim()).filter(Boolean);
    else if (k === '--timeout') a.timeoutMs = parseDuration(v());
    else if (k === '--task') a.task = v();
    else if (k === '--budget') a.budget = parseTokens(v());
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--keep') a.keep = true;
    else if (k === '--help' || k === '-h') {
      console.log('Usage: bun scripts/measure-profiles.ts [--dry-run] [--n 1] [--profiles max,saver] [--timeout 20m] [--task "..."] [--budget 4M] [--keep]');
      process.exit(0);
    } else throw new Error(`Unknown argument ${k}`);
  }
  for (const p of a.profiles) if (!['max', 'balanced', 'saver'].includes(p)) throw new Error(`Unknown profile "${p}" (max, balanced, saver)`);
  return a;
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e: any) {
  console.error(`measure-profiles: ${e.message}`);
  process.exit(2);
}

// ------------------------------------------------------------------ sandbox (before importing src/)

// paths.ts reads ORQ_HOME on import: the temp home and the safety net must be set first.
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orq-measure-')));
const orqHome = path.join(work, 'orq-home');
process.env.ORQ_HOME = orqHome;
process.env.ORQ_SAFE = '1';
process.env.ORQ_USAGE_FILE = path.join(work, 'usage.json');
// PROJECT_DIR/PROJECT_ORQ come from the cwd on import: keep project roles of wherever this is run out.
process.chdir(work);

const { assertSafeHome, ensureHome } = await import(path.join(APP, 'src/paths.ts'));
const { loadRoles } = await import(path.join(APP, 'src/library.ts'));
const { HQ, USER } = await import(path.join(APP, 'src/hq.ts'));
const { loadRun } = await import(path.join(APP, 'src/runs.ts'));
const tokens = await import(path.join(APP, 'src/tokens.ts'));

assertSafeHome();
ensureHome(); // seeds the temp ORQ_HOME from defaults/ (read only)

const TEAM = ['cto', 'backend', 'qa', 'reviewer'];
const LEAD = 'cto';

// ------------------------------------------------------------------ fixture

const FIXTURE: Record<string, string> = {
  'package.json': '{ "name": "fx-measure", "type": "module", "scripts": { "test": "bun test" } }\n',
  '.gitignore': 'node_modules\n.orq/runs\n',
  'src/math.ts': 'export const add = (a: number, b: number): number => a + b;\nexport const sub = (a: number, b: number): number => a - b;\n',
  'src/str.ts': 'export function capitalize(s: string): string {\n  return s ? s[0]!.toUpperCase() + s.slice(1) : s;\n}\n',
  'src/index.ts': "export * from './math.ts';\nexport * from './str.ts';\n",
  'test/math.test.ts':
    "import { expect, test } from 'bun:test';\nimport { add, sub } from '../src/math.ts';\ntest('add', () => expect(add(2, 3)).toBe(5));\ntest('sub', () => expect(sub(5, 3)).toBe(2));\n",
};

function makeFixture(dir: string) {
  for (const [f, text] of Object.entries(FIXTURE)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=measure@orq', '-c', 'user.name=measure', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
}

/** ~/.claude/projects/<cwd with / and . as -> where claude keeps this fixture's transcripts. */
const claudeProjectDir = (cwd: string) => path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'));

function bunTest(dir: string): { pass: number; fail: number; ok: boolean } {
  const r = spawnSync('bun', ['test'], { cwd: dir, encoding: 'utf8' });
  const out = `${r.stdout}\n${r.stderr}`;
  const pass = Number(/(\d+) pass/.exec(out)?.[1] ?? 0);
  const fail = Number(/(\d+) fail/.exec(out)?.[1] ?? 0);
  return { pass, fail, ok: r.status === 0 && fail === 0 };
}

// ------------------------------------------------------------------ one run

type RunResult = {
  profile: string;
  rep: number;
  runId: string;
  cwd: string;
  finished: boolean;
  minutes: number;
  tokens: { total: number; perAgent: Record<string, number> };
  cost: { total: number; perAgent: Record<string, number>; byType?: Record<string, { tokens: number; cost: number }> };
  requests: Record<string, number>;
  messages: number;
  undelivered: string[];
  reviewed: boolean;
  validated: boolean;
  tests: { pass: number; fail: number; ok: boolean };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The run in progress, stopped on Ctrl+C. */
let current: any;
/** Raw tokens of the finished runs; with the current run's, checked against --budget. */
let spent = 0;
let overBudget = false;

function teamRoles() {
  const lib = loadRoles();
  const roles = TEAM.map((id) => lib.find((r: any) => r.id === id));
  const missing = TEAM.filter((_, i) => !roles[i]);
  if (missing.length) throw new Error(`Roles missing from the library: ${missing.join(', ')}`);
  return roles as any[];
}

/** Weighted cost when src/tokens.ts has no runTokenCost (same weights as COST_WEIGHTS). */
function fallbackCost(meta: any) {
  const W = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
  const perAgent: Record<string, number> = {};
  let total = 0;
  for (const a of meta.agents) {
    const byId = new Map<string, any>();
    for (const f of transcriptsOf(a)) for (const u of usages(f)) byId.set(u.id, u.usage);
    let c = 0;
    for (const u of byId.values())
      c += (u.input_tokens ?? 0) * W.input + (u.cache_creation_input_tokens ?? 0) * W.cacheWrite + (u.cache_read_input_tokens ?? 0) * W.cacheRead + (u.output_tokens ?? 0) * W.output;
    perAgent[a.id] = c;
    total += c;
  }
  return { total, perAgent };
}

function transcriptsOf(a: any): string[] {
  if (!a.transcript) return [];
  return [a.transcript, ...(a.prevSessionIds ?? []).map((id: string) => path.join(path.dirname(a.transcript), `${id}.jsonl`))].filter((f) => fs.existsSync(f));
}

function usages(file: string): { id: string; usage: any }[] {
  const out: { id: string; usage: any }[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    try {
      const o = JSON.parse(line);
      if (o.type === 'assistant' && o.message?.usage) out.push({ id: String(o.message.id), usage: o.message.usage });
    } catch {}
  }
  return out;
}

function readEvents(dir: string): any[] {
  try {
    return fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function measure(profile: string, rep: number, hq: any, cwd: string, finished: boolean, startedAt: number): RunResult {
  const meta = loadRun(hq.store.dir);
  const usage = tokens.runTokenUsage(meta);
  const cost = typeof tokens.runTokenCost === 'function' ? tokens.runTokenCost(meta) : fallbackCost(meta);
  const requests: Record<string, number> = {};
  for (const a of meta.agents as any[]) requests[a.id] = new Set(transcriptsOf(a).flatMap((f) => usages(f).map((u) => u.id))).size;
  const ev = readEvents(hq.store.dir);
  const msgs = ev.filter((e) => e.kind === 'message');
  const delivered = new Set(ev.filter((e) => e.kind === 'delivered').flatMap((e) => e.ids ?? []));
  const undelivered = msgs.filter((m) => m.to !== USER && m.from !== 'system' && !delivered.has(m.id)).map((m) => `${m.from}→${m.to}: ${String(m.body).slice(0, 60)}`);
  const reportFrom = (id: string) => msgs.some((m) => m.from === id && m.type === 'report');
  return {
    profile,
    rep,
    runId: hq.runId,
    cwd,
    finished,
    minutes: Math.round((Date.now() - startedAt) / 600) / 100,
    tokens: usage,
    cost,
    requests,
    messages: msgs.length,
    undelivered,
    reviewed: reportFrom('reviewer'),
    validated: reportFrom('qa'),
    tests: bunTest(cwd),
  };
}

async function runOne(profile: string, rep: number, roles: any[], ownRuns: string[]): Promise<RunResult> {
  const cwd = path.join(work, `fixture-${profile}-${rep}`);
  makeFixture(cwd);
  const hq = new HQ({ roles, lead: LEAD, permMode: 'auto', profile, cwd });
  ownRuns.push(hq.runId);
  current = hq;
  const startedAt = Date.now();
  console.error(`[${profile} #${rep}] run ${hq.runId} in ${cwd}`);
  hq.start();
  let finished = false;
  try {
    // The fixture folder is new to claude: accept its trust dialog (only that kind of notice).
    let sent = false;
    while (Date.now() - startedAt < args.timeoutMs) {
      for (const n of [...hq.notices]) if (n.kind === 'trust') hq.answerNotice(n.id, true, roles);
      const lead = hq.agents.get(LEAD);
      if (!sent && lead && lead.status === 'idle') {
        hq.post(USER, LEAD, args.task, 'task');
        sent = true;
        console.error(`[${profile} #${rep}] task sent`);
      }
      const now = spent + tokens.runTokenUsage(loadRun(hq.store.dir)).total;
      if (now > args.budget) {
        overBudget = true;
        console.error(`[${profile} #${rep}] budget exceeded: ${now} > ${args.budget} raw tokens; stopping`);
        break;
      }
      if (sent && hq.messages.some((m: any) => m.from === LEAD && m.to === USER && m.type === 'report')) {
        finished = true;
        break;
      }
      await sleep(5000);
    }
    if (!finished && !overBudget) console.error(`[${profile} #${rep}] timeout after ${Math.round(args.timeoutMs / 60_000)} min`);
    await sleep(5000); // let the last turns write their usage
  } finally {
    hq.stop(); // kills only this run's sessions (own runId, guarded by ORQ_SAFE)
    current = undefined;
  }
  return measure(profile, rep, hq, cwd, finished, startedAt);
}

// ------------------------------------------------------------------ report

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000).toLocaleString('es-ES')} k` : String(Math.round(n)));
const pct = (b: number, a: number) => (a ? `${b >= a ? '+' : ''}${Math.round((b / a - 1) * 100)}%` : '—');
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

function report(results: RunResult[]): string {
  const profiles = [...new Set(results.map((r) => r.profile))];
  const base = profiles[0]!;
  const of = (p: string) => results.filter((r) => r.profile === p);
  const lines: string[] = [];
  lines.push(`# Medición de perfiles (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`, '');
  if (overBudget) lines.push(`> **Presupuesto superado** (${args.budget.toLocaleString('es-ES')} tokens brutos): la medición se paró y faltan runs del plan.`, '');
  lines.push(`Equipo: ${TEAM.join(', ')} (lead ${LEAD}) · permiso auto · runs por perfil: ${args.n} · timeout ${Math.round(args.timeoutMs / 60_000)} min`, '');
  lines.push(`Media por perfil; Δ respecto a \`${base}\`. Tokens = runTokenUsage; coste = ${typeof tokens.runTokenCost === 'function' ? 'runTokenCost' : 'ponderado propio'} (input 1×, cache write 1,25×, cache read 0,1×, output 5×).`, '');
  const head = ['Agente', ...profiles.flatMap((p) => [`${p} tokens`, `${p} coste`, `${p} req`]), ...profiles.slice(1).flatMap((p) => [`Δ tokens ${p}`, `Δ coste ${p}`])];
  lines.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
  const row = (label: string, t: (r: RunResult) => number, c: (r: RunResult) => number, q: (r: RunResult) => number) => {
    const T = Object.fromEntries(profiles.map((p) => [p, avg(of(p).map(t))]));
    const C = Object.fromEntries(profiles.map((p) => [p, avg(of(p).map(c))]));
    const Q = Object.fromEntries(profiles.map((p) => [p, avg(of(p).map(q))]));
    const cells = [label, ...profiles.flatMap((p) => [k(T[p]!), k(C[p]!), Q[p]!.toFixed(1)]), ...profiles.slice(1).flatMap((p) => [pct(T[p]!, T[base]!), pct(C[p]!, C[base]!)])];
    lines.push(`| ${cells.join(' | ')} |`);
  };
  for (const id of TEAM)
    row(
      id,
      (r) => r.tokens.perAgent[id] ?? 0,
      (r) => r.cost.perAgent[id] ?? 0,
      (r) => r.requests[id] ?? 0,
    );
  row(
    '**TOTAL**',
    (r) => r.tokens.total,
    (r) => r.cost.total,
    (r) => Object.values(r.requests).reduce((s, x) => s + x, 0),
  );
  lines.push('', '## Runs', '', '| Perfil | # | runId | Terminó | Min | Mensajes | Sin entregar | Review | QA | bun test |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results)
    lines.push(
      `| ${r.profile} | ${r.rep} | ${r.runId} | ${r.finished ? 'sí' : overBudget && r === results.at(-1) ? 'presupuesto' : 'timeout'} | ${r.minutes} | ${r.messages} | ${r.undelivered.length} | ${r.reviewed ? 'sí' : 'no'} | ${r.validated ? 'sí' : 'no'} | ${r.tests.ok ? 'verde' : 'ROJO'} (${r.tests.pass} pass, ${r.tests.fail} fail) |`,
    );
  const stuck = results.flatMap((r) => r.undelivered.map((u) => `- ${r.profile} #${r.rep}: ${u}`));
  if (stuck.length) lines.push('', '## Atascos (mensajes sin delivered)', '', ...stuck);
  return lines.join('\n');
}

// ------------------------------------------------------------------ main

function cleanup(cwds: string[]) {
  if (args.keep) return console.error(`--keep: left ${work}`);
  for (const cwd of cwds) fs.rmSync(claudeProjectDir(cwd), { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
}

const roles = teamRoles();
const plan = args.profiles.flatMap((p) => Array.from({ length: args.n }, (_, i) => ({ profile: p, rep: i + 1 })));
const cwds = plan.map(({ profile, rep }) => path.join(work, `fixture-${profile}-${rep}`));

if (args.dryRun) {
  console.log(`# measure-profiles --dry-run`);
  console.log(`work dir:  ${work}`);
  console.log(`ORQ_HOME:  ${orqHome} (seeded from ${path.join(APP, 'defaults')}; ORQ_SAFE=1)`);
  console.log(`team:      ${roles.map((r) => `${r.id}${r.id === LEAD ? ' (lead)' : ''}${r.writes ? ' writer' : ' reader'}`).join(', ')}`);
  console.log(`plan:      ${plan.map((p) => `${p.profile}#${p.rep}`).join(', ')} · timeout ${Math.round(args.timeoutMs / 60_000)} min each · budget ${args.budget.toLocaleString('es-ES')} raw tokens (all runs)`);
  console.log(`task:      ${args.task}\n`);
  for (const { profile, rep } of plan) {
    const cwd = path.join(work, `fixture-${profile}-${rep}`);
    makeFixture(cwd);
    const t = bunTest(cwd);
    // An HQ that is never started: no socket, no tmux, no claude. Only its launch files are written.
    const hq = new HQ({ roles, lead: LEAD, permMode: 'auto', profile, cwd });
    console.log(`## ${profile} #${rep} · run ${hq.runId} · fixture ${cwd} (bun test: ${t.pass} pass, ${t.fail} fail)`);
    for (const role of roles) {
      const dormant = profile !== 'max' && role.id !== LEAD;
      const agent = { id: role.id, role, status: 'starting', task: '', children: [], sessionId: crypto.randomUUID(), tmux: `orq-${hq.runId}-${role.id}`, inbox: [], timeline: [], stopBlocks: 0 };
      const script: string = (hq as any).writeLaunchFiles(agent);
      const cmd = fs.readFileSync(script, 'utf8').split('\n').filter((l) => /^(exec |\s+--)/.test(l)).join('\n');
      console.log(`### ${role.id}${dormant ? ' (dormant until its first message)' : ''} → tmux -L orq new-session -d -s ${agent.tmux} "bash ${script}"`);
      console.log(cmd + '\n');
    }
    console.log(`would: hq.start() → accept trust notices → post(user → ${LEAD}, task) → wait report ${LEAD}→user or timeout → hq.stop() → runTokenUsage/runTokenCost → bun test\n`);
    // Distinct runIds (they are per second) for the next HQ.
    await sleep(1100);
  }
  console.log(`measure: tokens.runTokenUsage ${typeof tokens.runTokenUsage === 'function' ? 'OK' : 'MISSING'} · tokens.runTokenCost ${typeof tokens.runTokenCost === 'function' ? 'OK' : 'missing → fallback'}`);
  cleanup(cwds);
  console.log(`cleanup: ${args.keep ? 'skipped (--keep)' : `removed ${work} and the ~/.claude/projects entries of its ${cwds.length} fixtures (if any)`}`);
  process.exit(0);
}

const ownRuns: string[] = [];
const results: RunResult[] = [];
const stopAll = () => cleanup(cwds);
process.on('SIGINT', () => {
  console.error('Interrupted: stopping the current run and cleaning up');
  current?.stop();
  stopAll();
  process.exit(130);
});
try {
  for (const { profile, rep } of plan) {
    const r = await runOne(profile, rep, roles, ownRuns);
    results.push(r);
    spent += r.tokens.total;
    if (overBudget) break;
    await sleep(1100); // runIds are per second
  }
  console.log(report(results));
} finally {
  stopAll();
}
process.exit(0);
