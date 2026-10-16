// Copy to the system clipboard: OSC 52 (works over ssh and in most terminals; tmux forwards
// it with `set -g set-clipboard on`) plus pbcopy on macOS, since some terminals
// (Terminal.app) ignore OSC 52.

/** OSC 52 "set clipboard" sequence for `text`. */
export const osc52 = (text: string) => `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;

/** The same sequence wrapped for tmux passthrough (only useful with `allow-passthrough on`). */
export const tmuxPassthrough = (seq: string) => `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;

type IO = {
  write?: (s: string) => void;
  /** Whether stdout is a terminal (OSC 52 can only work then). */
  tty?: boolean;
  platform?: string;
  env?: Record<string, string | undefined>;
  run?: (cmd: string[], input?: string) => { ok: boolean; out: string };
};

const defaultRun = (cmd: string[], input?: string) => {
  try {
    const r = Bun.spawnSync(cmd, { stdin: input === undefined ? 'ignore' : Buffer.from(input, 'utf8'), stdout: 'pipe', stderr: 'ignore' });
    return { ok: r.exitCode === 0, out: r.stdout.toString() };
  } catch {
    return { ok: false, out: '' };
  }
};

/**
 * Copies `text`. Always emits plain OSC 52; inside tmux also the passthrough form when
 * `allow-passthrough` is on; on macOS also pbcopy. False when no way could have worked
 * (no terminal and no pbcopy), so the UI never says «Copiado» for nothing.
 */
export function copyText(text: string, io: IO = {}): boolean {
  const write = io.write ?? ((s: string) => void process.stdout.write(s));
  const tty = io.tty ?? !!process.stdout.isTTY;
  const env = io.env ?? process.env;
  const run = io.run ?? defaultRun;
  let ok = false;
  if (tty) {
    const seq = osc52(text);
    write(seq);
    if (env.TMUX && /^on$/i.test(run(['tmux', 'show', '-gv', 'allow-passthrough']).out.trim())) write(tmuxPassthrough(seq));
    ok = true;
  }
  if ((io.platform ?? process.platform) === 'darwin' && run(['pbcopy'], text).ok) ok = true;
  return ok;
}
