import type { AgentStatus, CostProfile, MsgType, PermMode, TimelineKind } from '../types.ts';
import { g } from './glyphs.ts';
import type { SpriteState } from './sprites.ts';

type Env = Record<string, string | undefined>;

// ------------------------------------------------------------ environment

export type ThemeName = 'dark' | 'light';

/** ORQ_THEME=dark|light wins; otherwise COLORFGBG ("fg;bg") with a white bg (7/15) means light. */
export function detectTheme(env: Env = process.env): ThemeName {
  if (env.ORQ_THEME === 'dark' || env.ORQ_THEME === 'light') return env.ORQ_THEME;
  const bg = env.COLORFGBG?.split(';').pop();
  return bg === '7' || bg === '15' ? 'light' : 'dark';
}

export const isTruecolor = (env: Env = process.env) => /truecolor|24bit/i.test(env.COLORTERM ?? '');

/**
 * Turns off blinking and other non-essential animation: ORQ_REDUCED_MOTION=1,
 * the `--reduce-motion` flag, or a screen reader (INK_SCREEN_READER=true).
 */
export const reducedMotion = (env: Env = process.env, argv: readonly string[] = process.argv) =>
  /^(1|true|yes|on)$/i.test(env.ORQ_REDUCED_MOTION ?? '') || env.INK_SCREEN_READER === 'true' || argv.includes('--reduce-motion');

// The live setting (toggled with "m") for components that cannot read the app context.
let liveMotion: boolean | null = null;
/** Called by the app whenever reduced motion changes. */
export const setLiveReducedMotion = (v: boolean) => void (liveMotion = v);
/** Reduced motion as toggled now (falls back to the environment before the app sets it). */
export const liveReducedMotion = () => liveMotion ?? reducedMotion();

export const THEME = detectTheme();
export const TRUECOLOR = isTruecolor();

// ----------------------------------------------------------------- tokens

export type Token = { ansi: string; hex: string };
export type TokenName = 'primary' | 'focus' | 'selectedBg' | 'selectedFg' | 'danger' | 'warn' | 'success' | 'info' | 'text' | 'muted' | 'border' | 'surface';

// Dark theme uses the Bright ANSI-16 variants for coloured text (same hue, better contrast).
const DARK: Record<TokenName, Token> = {
  primary: { ansi: 'cyanBright', hex: '#4fc3f7' },
  focus: { ansi: 'cyanBright', hex: '#4fc3f7' },
  selectedBg: { ansi: 'blue', hex: '#264f78' },
  selectedFg: { ansi: 'whiteBright', hex: '#ffffff' },
  danger: { ansi: 'redBright', hex: '#f87171' },
  warn: { ansi: 'yellowBright', hex: '#facc15' },
  success: { ansi: 'greenBright', hex: '#4ade80' },
  info: { ansi: 'blueBright', hex: '#7aa2f7' },
  text: { ansi: 'white', hex: '#d4d4d4' },
  muted: { ansi: 'gray', hex: '#8a8a8a' },
  border: { ansi: 'gray', hex: '#707070' },
  /** Opaque background for overlays and modals. */
  surface: { ansi: 'black', hex: '#1c1c1c' },
};

// Light theme: base ANSI colours and darker hex values for white backgrounds.
const LIGHT: Record<TokenName, Token> = {
  primary: { ansi: 'cyan', hex: '#0e7490' },
  focus: { ansi: 'cyan', hex: '#0e7490' },
  selectedBg: { ansi: 'blue', hex: '#cfe3ff' },
  selectedFg: { ansi: 'whiteBright', hex: '#0b2a4a' },
  danger: { ansi: 'red', hex: '#cf222e' },
  warn: { ansi: 'yellow', hex: '#9a6700' },
  success: { ansi: 'green', hex: '#1a7f37' },
  info: { ansi: 'blue', hex: '#0550ae' },
  text: { ansi: 'black', hex: '#1f2328' },
  muted: { ansi: 'gray', hex: '#57606a' },
  border: { ansi: 'gray', hex: '#8c959f' },
  surface: { ansi: 'white', hex: '#ffffff' },
};

export const TOKENS: Record<ThemeName, Record<TokenName, Token>> = { dark: DARK, light: LIGHT };

/** Tokens of the active theme: `T.primary.ansi`, `T.danger.hex`… Prefer `c()`. */
export const T = TOKENS[THEME];

/** Colour for a token: hex on truecolor terminals (COLORTERM), the ANSI name otherwise. */
export function c(token: TokenName, opts: { theme?: ThemeName; truecolor?: boolean } = {}): string {
  const t = TOKENS[opts.theme ?? THEME][token];
  return (opts.truecolor ?? TRUECOLOR) ? t.hex : t.ansi;
}

const DARK_FILLS = new Set(['red', 'blue', 'magenta', 'black', 'blackBright', 'gray', 'grey']);

/**
 * Readable text colour on a filled background: black on green/yellow/cyan/white and
 * every *Bright fill, whiteBright on red/blue/magenta. Hex fills use their luminance.
 */
export function fgOn(bg: string): string {
  if (bg.startsWith('#') && bg.length === 7) {
    const [r, gr, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16) / 255);
    const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const lum = 0.2126 * lin(r!) + 0.7152 * lin(gr!) + 0.0722 * lin(b!);
    return lum > 0.179 ? 'black' : 'whiteBright';
  }
  return DARK_FILLS.has(bg) ? 'whiteBright' : 'black';
}

// Back-compat names for the semantic tokens.
export const PRIMARY = c('primary');
export const FOCUS = c('focus');
export const SUCCESS = c('success');
export const WARN = c('warn');
export const DANGER = c('danger');
export const INFO = c('info');
export const TEXT = c('text');
export const MUTED = c('muted');
export const BORDER = c('border');
export const SELECTED_BG = c('selectedBg');
export const SELECTED_FG = c('selectedFg');
export const SURFACE = c('surface');
/** Default text colour on SURFACE. */
export const SURFACE_FG = fgOn(SURFACE);

/** "Typing into the terminal" frame (LivePane interact mode). */
export const INTERACT = { borderStyle: 'bold' as const, borderColor: WARN };

// --------------------------------------------------------------- messages

// Message colours, used ONLY for messages and the timeline (user decision: hue fixed).
const dark = THEME === 'dark';
export const SENT = dark ? 'redBright' : 'red';
export const RECEIVED = dark ? 'greenBright' : 'green';
export const DONE = dark ? 'magentaBright' : 'magenta';

// ------------------------------------------------------------- permissions

/** Colour per permission mode: safe → success, optional YOLO → warn, YOLO → danger. */
export const PERM_COLOR: Record<PermMode, string> = { auto: SUCCESS, 'auto-insecure': WARN, yolo: DANGER };

export const PERM_NAME: Record<PermMode, string> = { auto: 'Auto', 'auto-insecure': 'Auto + YOLO opcional', yolo: 'YOLO' };
export const PERM_SHORT: Record<PermMode, string> = { auto: 'Auto', 'auto-insecure': 'Auto/YOLO', yolo: 'YOLO' };

/** One-line explanation of each permission mode, shown under the launch button. */
export const PERM_HELP: Record<PermMode, string> = {
  auto: 'Las acciones seguras se aprueban solas; las arriesgadas, no.',
  'auto-insecure': 'Como Auto, pero cada agente puede pasar a YOLO con Shift+Tab en su terminal.',
  yolo: 'Sin confirmaciones: los agentes ejecutan cualquier acción. Úsalo en entornos aislados.',
};

// ------------------------------------------------------------- cost profile

export const PROFILES: CostProfile[] = ['saver', 'balanced', 'max'];
// No profile promises a saving that has not been measured (Ahorro cost +29 % in tests).
export const PROFILE_NAME: Record<CostProfile, string> = { saver: 'Ahorro (experimental)', balanced: 'Equilibrado', max: 'Máximo' };
/** Short names for pills and headers. */
export const PROFILE_SHORT: Record<CostProfile, string> = { saver: 'Ahorro (exp.)', balanced: 'Equilibrado', max: 'Máximo' };
/** Profiles whose help is a warning (shown in WARN with ⚠). */
export const PROFILE_WARN: Record<CostProfile, boolean> = { saver: true, balanced: false, max: false };

// ------------------------------------------------------------------ status

export const STATUS: Record<AgentStatus, { label: string; color: string; glyph: string }> = {
  starting: { label: 'arrancando', color: MUTED, glyph: g.starting },
  idle: { label: 'libre', color: MUTED, glyph: g.idle },
  working: { label: 'trabajando', color: INFO, glyph: g.working },
  // «te espera»: the one who has to act is the user (not to be confused with dormant «en espera»).
  waiting: { label: 'te espera', color: WARN, glyph: g.waiting },
  error: { label: 'error', color: DANGER, glyph: g.error },
  stopped: { label: 'detenido', color: MUTED, glyph: g.stopped },
  // Lazy start: no claude/tmux yet; it starts with its first message.
  dormant: { label: 'en espera', color: MUTED, glyph: g.dormant },
};

/** Screen-reader text of a status (more explicit than the label where it matters). */
export const statusAria = (status: AgentStatus) => (status === 'waiting' ? 'te espera: necesita tu respuesta' : STATUS[status].label);

/** Spanish names for sprite states. */
export const SPRITE_STATE_ES: Record<SpriteState, string> = {
  idle: 'libre',
  working: 'trabajando',
  waiting: 'te espera',
  talking: 'hablando',
  error: 'error',
  sleeping: 'durmiendo',
  starting: 'arrancando',
  walking: 'caminando',
};

/** Spanish names for message types. */
export const MSG_TYPE_ES: Record<MsgType, string> = {
  message: 'mensaje',
  task: 'tarea',
  report: 'informe',
  question: 'pregunta',
  answer: 'respuesta',
  system: 'sistema',
};

export const KIND: Record<TimelineKind, { icon: string; color: string }> = {
  prompt: { icon: g.prompt, color: TEXT },
  assistant: { icon: g.assistant, color: TEXT },
  tool: { icon: g.tool, color: MUTED },
  msg_in: { icon: g.in, color: RECEIVED },
  msg_out: { icon: g.out, color: SENT },
  status: { icon: g.bullet, color: WARN },
  report: { icon: g.tick, color: DONE },
  subagent: { icon: g.subagent, color: INFO },
  system: { icon: g.bullet, color: MUTED },
};

export const isDoneReport = (text: string) => /^\[?(report\])?.*\[done\]/i.test(text) || /^done:/i.test(text);
