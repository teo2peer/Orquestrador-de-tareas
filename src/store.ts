import fs from 'node:fs';
import path from 'node:path';
import { ORQ_HOME } from './paths.ts';

export const INDEX_DIR = path.join(ORQ_HOME, 'index');

const time = (ts = Date.now()) => new Date(ts).toLocaleString('es-ES', { hour12: false });

/**
 * Run persistence under <cwd>/.orq/runs/<runId>/:
 *   run.json        run metadata + agents (session ids, transcripts)
 *   events.jsonl    every event in order (source of truth)
 *   agents/<id>.md  human-readable log per agent (prompts in/out, messages, summaries)
 *   REPORT.md       task reports (summaries) of the whole run
 *   LOG.md          long details agents log with the `log` tool (for the user; agents never read it)
 */
export class RunStore {
  readonly dir: string;

  constructor(readonly runId: string, cwd: string) {
    this.dir = path.join(cwd, '.orq', 'runs', runId);
    fs.mkdirSync(path.join(this.dir, 'agents'), { recursive: true });
    // Run logs hold prompts and messages: keep them out of the project's git.
    const ignore = path.join(cwd, '.orq', 'runs', '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  }

  agentDir(id: string) {
    const d = path.join(this.dir, 'agents', id);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  event(e: Record<string, unknown>) {
    fs.appendFileSync(path.join(this.dir, 'events.jsonl'), JSON.stringify({ ts: Date.now(), ...e }) + '\n');
  }

  agentLog(id: string, heading: string, text: string) {
    fs.appendFileSync(path.join(this.dir, 'agents', `${id}.md`), `\n### ${time()} · ${heading}\n\n${text.trim()}\n`);
  }

  log(from: string, heading: string, text: string) {
    const file = path.join(this.dir, 'LOG.md');
    if (!fs.existsSync(file)) fs.writeFileSync(file, `# Log of run ${this.runId}\n`);
    fs.appendFileSync(file, `\n## ${time()} · ${from} · ${heading}\n\n${text.trim()}\n`);
  }

  report(from: string, to: string, status: string, summary: string) {
    const file = path.join(this.dir, 'REPORT.md');
    if (!fs.existsSync(file)) fs.writeFileSync(file, `# Run ${this.runId}\n`);
    fs.appendFileSync(file, `\n## ${time()} · ${from} → ${to} [${status}]\n\n${summary.trim()}\n`);
  }

  saveMeta(meta: { runId: string }) {
    fs.writeFileSync(path.join(this.dir, 'run.json'), JSON.stringify(meta, null, 2));
    // Global index so `orq --resume` can list runs of every directory.
    fs.mkdirSync(INDEX_DIR, { recursive: true });
    fs.writeFileSync(path.join(INDEX_DIR, `${meta.runId}.json`), JSON.stringify({ ...meta, agents: undefined, dir: this.dir }, null, 2));
  }

  /** Events of a previous run, for replaying history on resume. */
  readEvents(): Record<string, any>[] {
    const file = path.join(this.dir, 'events.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
  }
}

export function newRunId() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
