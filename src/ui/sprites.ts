import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { ORQ_HOME } from '../paths.ts';
import type { AgentStatus, TimelineEvent } from '../types.ts';
import { reducedMotion } from './theme.ts';

/*
 * Pixel-art sprites rendered with half blocks: each terminal cell shows two
 * vertical pixels (▀ with fg = top pixel, bg = bottom pixel), in truecolor.
 *
 * A frame is an array of equal-length strings; each char is a palette key and
 * '.' is transparent. Accessories are overlays drawn on top of built-in frames.
 *
 * Custom sprites in ~/.orq/sprites/ (per role id):
 *   <id>.json  pixel arrays: { palette: {k: '#hex'}, states: { idle: { fps, frames: [[rows]] } } }
 *   <id>.png   spritesheet, optional <id>.json meta:
 *              { frameWidth, frameHeight, fps, states: { idle: { row, frames, fps }, working: {...} } }
 *              Without meta the PNG is one strip of square frames used for every state.
 *              Missing states fall back to idle. Alpha < 50% is transparent.
 *
 * States: idle, working, waiting, talking, error, sleeping, starting, walking.
 * `walking` (e.g. { walking: { row: 7, frames: 4, fps: 7 } }) is a 4-frame cycle:
 * left contact · passing · right contact · passing. If a custom sprite has no
 * `walking`, the built-in cycle is used (with the role's colours); `starting`
 * falls back to the custom `walking`, then to `idle`.
 * With ORQ_REDUCED_MOTION every state shows a still frame (walking: standing).
 */

export type Frame = string[];
/** `dy`: per-frame vertical offset of the body (px), so accessories follow the walk bob. */
export type Anim = { fps: number; frames: Frame[]; dy?: number[] };
export type SpriteSheet = { palette?: Record<string, string>; states: Partial<Record<SpriteState, Anim>> };
export type SpriteState = 'idle' | 'working' | 'waiting' | 'talking' | 'error' | 'sleeping' | 'starting' | 'walking';
export type Look = { shirt: string; hair: string; skin: string; accessory: string };

export const STATE_ORDER: SpriteState[] = ['idle', 'working', 'waiting', 'talking', 'error', 'sleeping', 'starting', 'walking'];
export const ACCESSORIES = ['none', 'tophat', 'tie', 'bowtie', 'glasses', 'cap', 'crown', 'headset', 'helmet', 'hood', 'beret', 'visor'];
export const SPRITE_DIR = path.join(ORQ_HOME, 'sprites');
const MAX_W = 16; // terminal columns
const MAX_H = 20; // pixels (10 terminal rows)

export const NAMED: Record<string, string> = {
  red: '#e5484d',
  green: '#46a758',
  yellow: '#f5d90a',
  blue: '#3e63dd',
  magenta: '#ab4aba',
  cyan: '#05a2c2',
  white: '#ededed',
  gray: '#8b8d98',
  orange: '#f76b15',
  pink: '#d6409f',
  teal: '#12a594',
  purple: '#8e4ec6',
};

export const toHex = (c: string) => (c.startsWith('#') ? c : NAMED[c] ?? '#ededed');

const SKINS = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#d4a373'];
const HAIRS = ['#6b4226', '#8b5a2b', '#a0522d', '#d6b370', '#c9c9d1', '#b33a3a', '#e0a040', '#5b4a9c'];

export function defaultLook(id: string, shirt: string, accessory = 'none', hair?: string, skin?: string): Look {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return {
    shirt: toHex(shirt),
    hair: hair ? toHex(hair) : HAIRS[h % HAIRS.length]!,
    skin: skin ? toHex(skin) : SKINS[(h >>> 3) % SKINS.length]!,
    accessory,
  };
}

// ------------------------------------------------------------ base body
const HEAD = ['....HHHH....', '...HHHHHH...', '...HSSSSH...', '...SESSES...', '...SSSSSS...', '....SMMS....'];
const HEAD_BLINK = ['....HHHH....', '...HHHHHH...', '...HSSSSH...', '...SSSSSS...', '...SSSSSS...', '....SMMS....'];
const HEAD_TALK = ['....HHHH....', '...HHHHHH...', '...HSSSSH...', '...SESSES...', '...SSSSSS...', '....SOOS....'];
const HEAD_SLEEP = ['....HHHH....', '...HHHHHH...', '...HSSSSH...', '...SddSdd...', '...SSSSSS...', '....SMMS....'];
const HEAD_ERR = ['....HHHH....', '...HHHHHH...', '...HSSSSH...', '...SXSSXS...', '...SSSSSS...', '....SOOS....'];
const LEGS = ['...PPPPPP...', '...PP..PP...', '..KKK..KKK..'];
const BODY = ['...BBBBBB...', '..BBBBBBBB..', '..BBBBBBBB..', '..SBBBBBBS..', '...PPPPPP...'];
const TYPE_A = ['...BBBBBB...', '..BBBBBBBB..', '.SBBBBBBBB..', '.DDDDDDDDDD.', '...PPPPPP...'];
const TYPE_B = ['...BBBBBB...', '..BBBBBBBB..', '..BBBBBBBBS.', '.DDDDDDDDDD.', '...PPPPPP...'];
const HAND_A = ['...BBBBBB.S.', '..BBBBBBBBB.', '..BBBBBBBB..', '..SBBBBBBB..', '...PPPPPP...'];
const HAND_B = ['...BBBBBB..S', '..BBBBBBBBS.', '..BBBBBBBB..', '..SBBBBBBB..', '...PPPPPP...'];

// Working: now and then the right heel lifts (a foot tap) so typing is not static.
const LEGS_TAP = ['...PPPPPP...', '...PP..PP...', '..KKK...KK..'];

// Canvas: 12 x 14 px → 12 cols x 7 rows. Standing figures use 13 px:
// head (6) + torso with belt (5) + legs/shoes (2), plus an empty bottom row.
const BLANK = '............';
const make = (head: Frame, torso: Frame, legs = LEGS): Frame => [...head, ...torso, ...legs.slice(1), BLANK];
const shift = (f: Frame, dx: number): Frame => f.map((r) => (dx > 0 ? '.'.repeat(dx) + r.slice(0, -dx) : r.slice(-dx) + '.'.repeat(-dx)));

// Walk cycle (14 px, the bottom row is the ground): contact frames have 3-px legs,
// one shoe low (forward) and one raised (back), arms swinging the other way;
// passing frames drop the body 1 px onto 2-px legs.
const TORSO_L = ['...BBBBBB...', '..BBBBBBBB..', '..BBBBBBBBS.', '.SBBBBBBBB..', '...PPPPPP...'];
const TORSO_R = ['...BBBBBB...', '..BBBBBBBB..', '.SBBBBBBBB..', '..BBBBBBBBS.', '...PPPPPP...'];
const WALK: Frame[] = [
  [...HEAD, ...TORSO_L, '...PP..PP...', '...PP..KKK..', '..KKK.......'], // left contact
  [BLANK, ...HEAD, ...BODY, '...PP..PP...', '..KKK.KKK...'], // passing (right leg swings)
  [...HEAD, ...TORSO_R, '...PP..PP...', '..KKK..PP...', '.......KKK..'], // right contact
  [BLANK, ...HEAD, ...BODY, '...PP..PP...', '...KKK.KKK..'], // passing (left leg swings)
];
const WALK_DY = [0, 1, 0, 1];
/** Still frame for walking/starting under reduced motion. */
const STAND = make(HEAD, BODY);

const IDLE = make(HEAD, BODY);
const WORK_A = make(HEAD, TYPE_A);
const WORK_B = make(HEAD, TYPE_B);
const BASE: Record<SpriteState, Anim> = {
  idle: { fps: 2, frames: [IDLE, IDLE, IDLE, IDLE, IDLE, make(HEAD_BLINK, BODY)] },
  working: { fps: 5, frames: [WORK_A, WORK_B, WORK_A, WORK_B, WORK_A, WORK_B, make(HEAD, TYPE_A, LEGS_TAP), make(HEAD, TYPE_B, LEGS_TAP)] },
  waiting: { fps: 3, frames: [make(HEAD, HAND_A), make(HEAD, HAND_B)] },
  talking: { fps: 4, frames: [make(HEAD_TALK, BODY), IDLE] },
  error: { fps: 8, frames: [make(HEAD_ERR, BODY), shift(make(HEAD_ERR, BODY), 1), make(HEAD_ERR, BODY), shift(make(HEAD_ERR, BODY), -1)] },
  sleeping: { fps: 1, frames: [make(HEAD_SLEEP, BODY)] },
  // An agent that is starting walks in (drawn dimmed).
  starting: { fps: 7, frames: WALK, dy: WALK_DY },
  walking: { fps: 7, frames: WALK, dy: WALK_DY },
};

/** Built-in animation of a state (for previews and tests). */
export const builtinAnim = (state: SpriteState): Anim => BASE[state];

// Overlays on the same canvas; '.' (or missing) keeps the underlying pixel.
const OVERLAYS: Record<string, Frame> = {
  tophat: ['...kkkkkk...', '..kkkkkkkk..'],
  tie: ['', '', '', '', '', '', '.....rr.....', '.....rr.....', '......r.....'],
  bowtie: ['', '', '', '', '', '', '....r..r....', '....rrrr....'],
  glasses: ['', '', '', '..gggggggg..', '...g.gg.g...'],
  cap: ['...cccccc...', '..cccccccc..', '.......cccc.'],
  crown: ['...y.yy.y...', '...yyyyyy...'],
  headset: ['', '...aaaaaa...', '..a......a..', '..a......a..', '..a.....aa..', '.........a..'],
  helmet: ['...yyyyyy...', '..yyyyyyyy..', '.yyyyyyyyyy.'],
  hood: ['...nnnnnn...', '..nnnnnnnn..', '..n......n..', '..n......n..', '..n......n..', '...nn..nn...'],
  beret: ['..vvvvvv....', '.vvvvvvvv...'],
  visor: ['', '', '', '..wwwwwwww..'],
};

const FIXED: Record<string, string> = {
  E: '#1b1b1f', M: '#9b4d3a', O: '#5a1f1f', P: '#3d4466', K: '#5c5f73', D: '#9da3b4', X: '#e5484d',
  d: '#1b1b1f', k: '#4a4a5c', r: '#c62828', g: '#202020', c: '#3e63dd', y: '#f5c400', a: '#2b2b30',
  n: '#3a3a44', v: '#ab4aba', w: '#05a2c2',
};

// ------------------------------------------------------- custom sprites

type PngMeta = { frameWidth?: number; frameHeight?: number; fps?: number; states?: Partial<Record<SpriteState, { row: number; frames?: number; fps?: number }>> };

/** Convert a PNG spritesheet into pixel-array frames with an auto palette. */
export function loadPngSheet(file: string, meta: PngMeta = {}): SpriteSheet {
  const png = PNG.sync.read(fs.readFileSync(file));
  // Without meta: one horizontal strip of square frames (side = image height) used for every state.
  const fh = meta.frameHeight ?? (meta.frameWidth ?? png.height);
  const fw = meta.frameWidth ?? fh;
  const palette: Record<string, string> = {};
  const keyOf = new Map<string, string>();
  let next = 0x100; // palette keys outside ASCII so they never clash with built-ins or '.'
  const scale = Math.max(1, Math.ceil(fw / MAX_W), Math.ceil(fh / MAX_H));

  const readFrame = (fx: number, fy: number): Frame => {
    const rows: string[] = [];
    for (let y = 0; y < fh; y += scale) {
      let row = '';
      for (let x = 0; x < fw; x += scale) {
        const px = fx * fw + x;
        const py = fy * fh + y;
        if (px >= png.width || py >= png.height) {
          row += '.';
          continue;
        }
        const i = (png.width * py + px) << 2;
        if (png.data[i + 3]! < 128) {
          row += '.';
          continue;
        }
        const hex = '#' + [0, 1, 2].map((o) => png.data[i + o]!.toString(16).padStart(2, '0')).join('');
        let k = keyOf.get(hex);
        if (!k) {
          k = String.fromCharCode(next++);
          keyOf.set(hex, k);
          palette[k] = hex;
        }
        row += k;
      }
      rows.push(row);
    }
    return rows;
  };

  const cols = Math.max(1, Math.floor(png.width / fw));
  const sheetRows = Math.max(1, Math.floor(png.height / fh));
  const states: SpriteSheet['states'] = {};
  const defs = meta.states ?? { idle: { row: 0 } };
  for (const [state, def] of Object.entries(defs) as [SpriteState, { row: number; frames?: number; fps?: number }][]) {
    if (def.row >= sheetRows) continue;
    const frames: Frame[] = [];
    for (let c = 0; c < (def.frames ?? cols); c++) {
      const f = readFrame(c, def.row);
      if (f.some((r) => /[^.]/.test(r))) frames.push(f); // skip empty cells
    }
    if (frames.length) states[state] = { fps: def.fps ?? meta.fps ?? 4, frames };
  }
  return { palette, states };
}

const cache = new Map<string, SpriteSheet | null>();
export const clearSpriteCache = () => cache.clear();

function customSheet(id: string): SpriteSheet | null {
  if (cache.has(id)) return cache.get(id)!;
  let sheet: SpriteSheet | null = null;
  try {
    const json = path.join(SPRITE_DIR, `${id}.json`);
    const png = path.join(SPRITE_DIR, `${id}.png`);
    const data = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : undefined;
    if (fs.existsSync(png)) sheet = loadPngSheet(png, data);
    else if (data?.states) sheet = data as SpriteSheet;
  } catch {
    sheet = null; // broken custom sprite: fall back to the built-in one
  }
  cache.set(id, sheet);
  return sheet;
}

// ------------------------------------------------------------- render

/** How long an agent walks after sending a message ("taking it over"). */
export const WALK_MS = 3000;

/** When the agent last sent a message (latest msg_out in its timeline), or undefined. */
export function lastOutAt(agent: { timeline: Pick<TimelineEvent, 'ts' | 'kind'>[] }): number | undefined {
  const t = agent.timeline;
  for (let i = t.length - 1; i >= 0 && i >= t.length - 200; i--) if (t[i]!.kind === 'msg_out') return t[i]!.ts;
  return undefined;
}

/**
 * Sprite state for an agent. `starting` walks in; an agent that sent a message
 * less than WALK_MS ago walks (pass `lastOutAt(agent)`).
 */
export function stateFor(status: AgentStatus, talking: boolean, sentAt?: number, now = Date.now()): SpriteState {
  if (status === 'error') return 'error';
  if (status === 'stopped' || status === 'dormant') return 'sleeping';
  if (status === 'starting') return 'starting';
  if (sentAt !== undefined && now - sentAt >= 0 && now - sentAt < WALK_MS) return 'walking';
  if (status === 'waiting') return 'waiting';
  if (talking) return 'talking';
  if (status === 'working') return 'working';
  return 'idle';
}

function overlay(f: Frame, o: Frame | undefined, dy = 0): Frame {
  if (!o) return f;
  if (dy > 0) o = [...Array<string>(dy).fill(''), ...o];
  return f.map((row, y) => {
    const ov = o[y];
    if (!ov) return row;
    return [...row].map((ch, x) => (ov[x] && ov[x] !== '.' ? ov[x] : ch)).join('');
  });
}

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};
const tint = (hex: string, tone: 'normal' | 'dim' | 'gray') => {
  if (tone === 'normal') return hex;
  const [r, g, b] = rgb(hex);
  if (tone === 'dim') return `#${[r, g, b].map((v) => Math.round(v * 0.55).toString(16).padStart(2, '0')).join('')}`;
  const l = Math.round(0.3 * r + 0.59 * g + 0.11 * b).toString(16).padStart(2, '0');
  return `#${l}${l}${l}`;
};
const fg = (hex: string) => `\x1b[38;2;${rgb(hex).join(';')}m`;
const bg = (hex: string) => `\x1b[48;2;${rgb(hex).join(';')}m`;
const RESET = '\x1b[0m';

type Tone = 'normal' | 'dim' | 'gray';

function colorFn(palette: Record<string, string>, tone: Tone) {
  return (k: string | undefined) => {
    if (!k || k === '.' || k === ' ') return undefined;
    const c = palette[k] ?? FIXED[k];
    return c ? tint(c, tone) : undefined;
  };
}

/**
 * Render a frame into ANSI strings, one per terminal row (2 pixels high).
 * Solid cells use a background-coloured space instead of a half-block glyph so
 * terminals with extra line spacing do not show stripes.
 */
export function renderFrame(f: Frame, palette: Record<string, string>, tone: Tone = 'normal'): string[] {
  const color = colorFn(palette, tone);
  const rows = f.map((r) => [...r]);
  const width = Math.max(0, ...rows.map((r) => r.length));
  const out: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const top = color(rows[y]?.[x]);
      const bot = color(rows[y + 1]?.[x]);
      if (!top && !bot) line += ' ';
      else if (top && bot && top === bot) line += bg(top) + ' ' + RESET;
      else if (top && bot) line += fg(top) + bg(bot) + '▀' + RESET;
      else if (top) line += fg(top) + '▀' + RESET;
      else line += fg(bot!) + '▄' + RESET;
    }
    out.push(line);
  }
  return out;
}

/** XL render: every pixel is two background-coloured columns on its own row. */
export function renderFrameWide(f: Frame, palette: Record<string, string>, tone: Tone = 'normal'): string[] {
  const color = colorFn(palette, tone);
  const width = Math.max(0, ...f.map((r) => [...r].length));
  return f.map((r) => {
    const px = [...r];
    let line = '';
    for (let x = 0; x < width; x++) {
      const c = color(px[x]);
      line += c ? bg(c) + '  ' + RESET : '  ';
    }
    return line;
  });
}

/** Current animation frame (ANSI rows) of a role. `tick` advances at 10 Hz. */
export function spriteRows(roleId: string, look: Look, state: SpriteState, tick: number, size: 'normal' | 'xl' = 'normal'): string[] {
  const sheet = customSheet(roleId);
  // Custom sprite first; `walking` without a custom cycle uses the built-in one.
  const custom =
    sheet?.states[state] ?? (state === 'starting' ? sheet?.states.walking : undefined) ?? (state !== 'walking' ? sheet?.states.idle : undefined);
  const anim = custom ?? BASE[state];
  const still = reducedMotion();
  const i = still ? 0 : Math.floor((tick * anim.fps) / 10) % anim.frames.length;
  let f = still && !custom && anim.frames === WALK ? STAND : anim.frames[i]!;
  if (!custom) f = overlay(f, OVERLAYS[look.accessory], still ? 0 : anim.dy?.[i]);
  const palette = { H: look.hair, S: look.skin, B: look.shirt, ...(custom ? sheet?.palette : {}) };
  const tone: Tone = state === 'sleeping' ? 'gray' : state === 'starting' ? 'dim' : 'normal';
  return size === 'xl' ? renderFrameWide(f, palette, tone) : renderFrame(f, palette, tone);
}

// ------------------------------------------------------ mini (subagents)
// 6 x 8 px → 6 cols x 4 rows. Step cycle on the bottom two rows: one foot lifts,
// both down, the other lifts, both down.
const MINI_TOP = ['.HHHH.', '.ESSE.', '.SSSS.', 'BBBBBB', 'SBBBBS', '.PPPP.'];
const MINI_STAND: Frame = [...MINI_TOP, '.P..P.', '.K..K.'];
export const MINI: Frame[] = [[...MINI_TOP, '.K..P.', '....K.'], MINI_STAND, [...MINI_TOP, '.P..K.', '.K....'], MINI_STAND];

/**
 * Mini sprite rows. Without `state` it steps with `tick` (pass a constant tick to
 * keep it still); with `state` it only steps while walking/working.
 */
export function miniRows(look: Look, tick: number, tone: Tone = 'normal', state?: SpriteState): string[] {
  const moving = !reducedMotion() && (state === undefined || state === 'walking' || state === 'working' || state === 'starting');
  const f = moving ? MINI[Math.floor(tick / 3) % MINI.length]! : MINI_STAND;
  return renderFrame(f, { H: look.hair, S: look.skin, B: look.shirt }, tone);
}
