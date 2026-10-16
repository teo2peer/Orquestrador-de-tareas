import fs from 'node:fs';
import path from 'node:path';
import { INDEX_DIR } from './store.ts';
import * as tmux from './tmux.ts';
import type { RunMeta } from './types.ts';

export type RunSummary = Omit<RunMeta, 'agents'> & {
  team: { id: string; name: string; color: string }[];
  live: number; // tmux sessions still alive
  messages: number;
  lastReport?: string;
  exists: boolean;
};

/** Names of live orq tmux sessions, grouped by run id. */
function liveByRun(): Map<string, number> {
  const map = new Map<string, number>();
  for (const name of tmux.listSessions()) {
    const m = /^orq-(\d{8}-\d{6})-/.exec(name);
    if (m) map.set(m[1]!, (map.get(m[1]!) ?? 0) + 1);
  }
  return map;
}

export function listRuns(cwd?: string): RunSummary[] {
  if (!fs.existsSync(INDEX_DIR)) return [];
  const live = liveByRun();
  const runs: RunSummary[] = [];
  for (const f of fs.readdirSync(INDEX_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, f), 'utf8'));
      if (cwd && idx.cwd !== cwd) continue;
      const events = path.join(idx.dir, 'events.jsonl');
      const report = path.join(idx.dir, 'REPORT.md');
      let messages = 0;
      if (fs.existsSync(events)) messages = (fs.readFileSync(events, 'utf8').match(/"kind":"message"/g) ?? []).length;
      let lastReport: string | undefined;
      if (fs.existsSync(report)) {
        const parts = fs.readFileSync(report, 'utf8').split(/\n## /);
        lastReport = parts.length > 1 ? parts[parts.length - 1]!.split('\n').slice(2).join(' ').trim() : undefined;
      }
      runs.push({ ...idx, team: idx.team ?? [], live: live.get(idx.runId) ?? 0, messages, lastReport, exists: fs.existsSync(idx.dir) });
    } catch {
      /* skip broken index entry */
    }
  }
  return runs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadRun(dir: string): RunMeta {
  return JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
}

export function findRun(runId: string): RunSummary | undefined {
  return listRuns().find((r) => r.runId === runId);
}

/** Kill the live tmux sessions of a run (its history stays on disk). */
export function stopRunSessions(runId: string) {
  tmux.assertOwnRun(runId);
  for (const name of tmux.listSessions()) if (name.startsWith(`orq-${runId}-`)) tmux.killSession(name);
}

/** Remove a run from the index (history on disk is kept). */
export function forgetRun(runId: string) {
  tmux.assertOwnRun(runId);
  const f = path.join(INDEX_DIR, `${runId}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

/** The user's title for a run that is not running (run.json + index, source 'user'). False if the run is unknown or unreadable. */
export function renameRun(runId: string, title: string): boolean {
  const t = title.replace(/\s+/g, ' ').trim();
  const indexFile = path.join(INDEX_DIR, `${runId}.json`);
  if (!t || !fs.existsSync(indexFile)) return false;
  const write = (file: string, data: Record<string, unknown>) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...data, title: t, titleProvisional: false, titleSource: 'user' }, null, 2));
    fs.renameSync(tmp, file);
  };
  try {
    const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    const runFile = path.join(idx.dir, 'run.json');
    if (fs.existsSync(runFile)) write(runFile, JSON.parse(fs.readFileSync(runFile, 'utf8')));
    write(indexFile, idx);
    return true;
  } catch {
    return false;
  }
}
