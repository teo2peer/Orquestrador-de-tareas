// Thin wrapper over a dedicated tmux server (`tmux -L orq`) so user sessions are never touched.
// ORQ_TMUX_SOCKET is internal (isolates test runs from the real `orq` server); not a documented option.
const SOCKET = process.env.ORQ_TMUX_SOCKET ?? 'orq';

/*
 * Guard (ORQ_TEST=1 in tests, ORQ_SAFE=1 in smoke runs): sessions are only created, killed or
 * typed into when they belong to a run created by this process (registerRun, called by HQ).
 * Any other `orq-*` session throws, so a test can never touch the user's real runs.
 */
const ownRuns = new Set<string>();
const guarded = () => process.env.ORQ_TEST === '1' || process.env.ORQ_SAFE === '1';

/** Mark a run id as created by this process (its sessions may be managed). */
export const registerRun = (runId: string) => void ownRuns.add(runId);

/** Throws when guarded and the run is not one of this process. */
export function assertOwnRun(runId: string) {
  if (guarded() && !ownRuns.has(runId)) throw new Error(`refusing to touch foreign run "${runId}"`);
}

function assertOwnSession(target: string) {
  if (!guarded()) return;
  const name = target.split(':')[0]!;
  if (!name.startsWith('orq-')) return;
  const m = /^orq-(\d{8}-\d{6})-/.exec(name);
  if (!m || !ownRuns.has(m[1]!)) throw new Error(`refusing to touch foreign session "${name}"`);
}

const READ_ONLY = new Set(['has-session', 'display-message', 'capture-pane', 'list-sessions', 'list-windows', 'list-panes', 'show-options']);
/** Writes that touch no session (paste buffers); everything else must target an own session. */
const BUFFER_ONLY = new Set(['load-buffer', 'delete-buffer']);

/** Guard every tmux command of `args` (several may be chained with ';'). */
function assertAllowed(args: string[]) {
  if (!guarded()) return;
  const commands: string[][] = [[]];
  for (const a of args) a === ';' ? commands.push([]) : commands.at(-1)!.push(a);
  for (const [sub, ...rest] of commands) {
    if (!sub || READ_ONLY.has(sub) || BUFFER_ONLY.has(sub)) continue;
    const i = rest.findIndex((x) => x === '-t' || x === '-s');
    if (i < 0 || !rest[i + 1]) throw new Error(`refusing to run "tmux ${sub}" without an own session target`);
    assertOwnSession(rest[i + 1]!);
  }
}

/**
 * Raw tmux command on orq's server. Guarded (ORQ_TEST/ORQ_SAFE): read-only commands pass, writes
 * must target a session of a run created by this process. Prefer the helpers below.
 */
export function tmux(args: string[], stdin?: string) {
  assertAllowed(args);
  const p = Bun.spawnSync(['tmux', '-L', SOCKET, ...args], { stdin: stdin !== undefined ? Buffer.from(stdin) : undefined });
  return { ok: p.exitCode === 0, out: p.stdout.toString(), err: p.stderr.toString() };
}

export const attachCommand = (target: string) => `tmux -L ${SOCKET} attach -t ${target}`;

export function newSession(name: string, cwd: string, command: string, width = 160, height = 48) {
  assertOwnSession(name);
  const r = tmux(['new-session', '-d', '-s', name, '-n', 'claude', '-x', String(width), '-y', String(height), '-c', cwd, command]);
  if (!r.ok) throw new Error(`tmux new-session failed: ${r.err.trim()}`);
  // Keep the pane after claude exits so the user can read why it ended.
  tmux(['set-option', '-t', name, 'remain-on-exit', 'on']);
  // Second window: a plain shell in the same directory for the user's own commands.
  tmux(['new-window', '-d', '-t', `${name}:`, '-n', 'shell', '-c', cwd, process.env.SHELL || 'bash']);
}

/** tmux target of an agent window: its claude TUI or its command shell. */
export const win = (session: string, w: 'claude' | 'shell') => `${session}:${w}`;

/** Names of every session on orq's tmux server (read-only). */
export const listSessions = () =>
  tmux(['list-sessions', '-F', '#{session_name}'])
    .out.split('\n')
    .filter(Boolean);

/** Plain text of a pane with wrapped lines joined, including `history` lines of scrollback (read-only). */
export const captureText = (target: string, history = 300) => tmux(['capture-pane', '-p', '-J', '-S', `-${history}`, '-t', target]).out;

export const hasSession = (name: string) => tmux(['has-session', '-t', name]).ok;

export const isPaneDead = (name: string) => tmux(['display-message', '-p', '-t', `${name}:claude`, '#{pane_dead}']).out.trim() === '1';

export const killSession = (name: string) => (assertOwnSession(name), tmux(['kill-session', '-t', name]));

export const capture = (name: string) => tmux(['capture-pane', '-p', '-e', '-t', name]).out;

/** A pane's ANSI rows plus its cursor and scroll state, read in one tmux call. */
export type Snapshot = {
  lines: string[];
  cx: number;
  cy: number;
  cursorOn: boolean; // cursor_flag: the program shows its cursor
  inMode: boolean; // tmux copy mode
  alt: boolean; // alternate screen (nano, vim, less…): no tmux history
  history: number; // lines in the scrollback above the visible screen
  paneH: number;
  mouse: boolean; // the program asked for SGR mouse reports (e.g. claude's full-screen UI)
};

const SNAP_FMT = '#{cursor_x} #{cursor_y} #{cursor_flag} #{pane_in_mode} #{alternate_on} #{history_size} #{pane_height} #{mouse_any_flag}#{mouse_sgr_flag}';

/**
 * Captures the visible screen, or `range` = [start, end] in tmux line numbers
 * (0 = top visible row, negative = scrollback), and the pane state in a single call.
 */
export function snapshot(target: string, range?: [number, number]): Snapshot | null {
  const cap = ['capture-pane', '-p', '-e', '-t', target, ...(range ? ['-S', String(range[0]), '-E', String(range[1])] : [])];
  const r = tmux([...cap, ';', 'display-message', '-p', '-t', target, SNAP_FMT]);
  if (!r.ok) return null;
  const lines = r.out.replace(/\n$/, '').split('\n');
  const meta = lines.pop()!.split(' ');
  const [cx = 0, cy = 0, flag = 0, inMode = 0, alt = 0, history = 0, paneH = 0] = meta.slice(0, 7).map(Number);
  return { lines, cx, cy, cursorOn: flag === 1, inMode: inMode === 1, alt: alt === 1, history, paneH, mouse: meta[7] === '11' };
}

export const resize = (target: string, width: number, height: number) =>
  (assertOwnSession(target), tmux(['resize-window', '-t', target, '-x', String(width), '-y', String(height)]));

/** Paste text into an agent's claude input as a bracketed paste (multi-line safe), without submitting it. */
export function paste(name: string, text: string) {
  assertOwnSession(name);
  const buf = `orq-${name}`;
  tmux(['load-buffer', '-b', buf, '-'], text);
  tmux(['paste-buffer', '-p', '-d', '-b', buf, '-t', `${name}:claude`]);
}

export const sendKeys = (name: string, keys: string[]) => (assertOwnSession(name), tmux(['send-keys', '-t', name, ...keys]));
/** Wheel event (SGR mouse report) at cell x,y (0-based) of a pane whose program reads the mouse. */
export function sendWheel(target: string, up: boolean, x: number, y: number, times = 1) {
  const seq = `\x1b[<${up ? 64 : 65};${x + 1};${y + 1}M`.repeat(times);
  return sendKeys(target, ['-H', ...[...Buffer.from(seq)].map((b) => b.toString(16).padStart(2, '0'))]);
}
export const sendLiteral = (name: string, text: string) => (assertOwnSession(name), tmux(['send-keys', '-t', name, '-l', text]));
