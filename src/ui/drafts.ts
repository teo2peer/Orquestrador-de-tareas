// Unsent text of the text boxes, by field id (and by recipient in the composer). Kept in
// memory by the app; with a run open they also go to <run dir>/drafts.json (debounced).
import fs from 'node:fs';
import path from 'node:path';

export type Drafts = Record<string, string>;
export const DRAFTS_FILE = 'drafts.json';

export function loadDrafts(dir: string | undefined): Drafts {
  if (!dir) return {};
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, DRAFTS_FILE), 'utf8'));
    if (!data || typeof data !== 'object') return {};
    return Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'string' && v)) as Drafts;
  } catch {
    return {};
  }
}

/** Writes now (atomically: tmp file + rename); empty drafts are dropped (an empty set removes the file). */
export function saveDrafts(dir: string, drafts: Drafts) {
  const file = path.join(dir, DRAFTS_FILE);
  const kept = Object.fromEntries(Object.entries(drafts).filter(([, v]) => v));
  try {
    if (!Object.keys(kept).length) return void fs.rmSync(file, { force: true });
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(kept, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* drafts are best effort */
  }
}

// Pending writes are flushed when the process exits (quit right after typing).
const live = new Set<() => void>();
let exitHooked = false;

/** Debounced writer: `schedule` coalesces bursts of keystrokes; `flush` writes what is pending. */
export function draftWriter(dir: string, delay = 400) {
  let pending: Drafts | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending) saveDrafts(dir, pending);
    pending = null;
  };
  live.add(flush);
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => {
      for (const f of live) f();
    });
  }
  return {
    schedule(drafts: Drafts) {
      pending = { ...drafts };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    flush,
    /** Flushes and stops listening for process exit. */
    close() {
      flush();
      live.delete(flush);
    },
  };
}

/**
 * The app's draft store. Without a run, drafts live in memory ("loose"); `attach(dir)`
 * loads that run's drafts.json, keeps only the loose ones on top (never another run's)
 * and persists from then on; `detach()` flushes and forgets them. `version` changes on
 * attach/detach so mounted boxes re-read their draft.
 */
export function createDraftStore() {
  let drafts: Drafts = {};
  let writer: ReturnType<typeof draftWriter> | null = null;
  let dir: string | undefined;
  let version = 0;
  return {
    get: (key: string) => drafts[key] ?? '',
    set(key: string, value: string) {
      if ((drafts[key] ?? '') === value) return;
      if (value) drafts[key] = value;
      else delete drafts[key];
      writer?.schedule(drafts);
    },
    attach(next: string) {
      if (next === dir) return;
      const loose = writer ? {} : drafts;
      writer?.close();
      dir = next;
      drafts = { ...loadDrafts(next), ...loose };
      writer = draftWriter(next);
      // Persist what was merged (loose drafts typed before the run existed).
      if (Object.keys(loose).length) writer.schedule(drafts);
      version++;
    },
    detach() {
      if (!writer && !dir) return;
      writer?.close();
      writer = null;
      dir = undefined;
      drafts = {};
      version++;
    },
    get version() {
      return version;
    },
    get dir() {
      return dir;
    },
  };
}
export type DraftStoreImpl = ReturnType<typeof createDraftStore>;
