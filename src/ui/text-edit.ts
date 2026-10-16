// Pure text editing shared by TextField (one line) and TextArea (wrapped, multi-line):
// a key press turns { value, cursor } into the next state plus what the widget should do.
import type { Key } from 'ink';

export type Edit = { value: string; cursor: number };
/** submit: Enter · blur: Esc/Tab · up/down: arrow at the first/last row (the widget decides). */
export type EditAction = 'submit' | 'blur' | 'up' | 'down';
export type EditResult = { next: Edit; action?: EditAction };
export type EditOpts = { multiline?: boolean; /** Wrap width of a multi-line field (columns). */ width?: number };

const WORD = /[\p{L}\p{N}_]/u;

/** Start of the word before `at` (skips the separators right before it first). */
export function wordLeft(value: string, at: number): number {
  let i = at;
  while (i > 0 && !WORD.test(value[i - 1]!)) i--;
  while (i > 0 && WORD.test(value[i - 1]!)) i--;
  return i;
}

/** End of the word after `at`. */
export function wordRight(value: string, at: number): number {
  let i = at;
  while (i < value.length && !WORD.test(value[i]!)) i++;
  while (i < value.length && WORD.test(value[i]!)) i++;
  return i;
}

/** Visual rows of a wrapped value: [start, end) offsets; a "\n" ends a row and belongs to none. */
export function rowsOf(value: string, width: number): { start: number; end: number }[] {
  const w = Math.max(1, width);
  const rows: { start: number; end: number }[] = [];
  let start = 0;
  for (const para of value.split('\n')) {
    if (!para.length) rows.push({ start, end: start });
    for (let i = 0; i < para.length; i += w) rows.push({ start: start + i, end: start + Math.min(para.length, i + w) });
    start += para.length + 1;
  }
  return rows;
}

/** Row holding the cursor; a cursor at a full row's end goes to the next row when there is one. */
export function rowOf(rows: { start: number; end: number }[], cursor: number): number {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (cursor >= r.start && cursor < r.end) return i;
    if (cursor === r.end && !(rows[i + 1] && rows[i + 1]!.start === r.end)) return i;
  }
  return Math.max(0, rows.length - 1);
}

const clamp = (n: number, value: string) => Math.max(0, Math.min(value.length, n));

// Cursor moves and single deletes go by grapheme (emoji, accents built from several code units).
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Start of the grapheme that ends at `at`. */
export function prevGrapheme(value: string, at: number): number {
  let last = 0;
  for (const { index } of segmenter.segment(value)) {
    if (index >= at) break;
    last = index;
  }
  return Math.min(last, at);
}
/** End of the grapheme that starts at `at`. */
export function nextGrapheme(value: string, at: number): number {
  for (const { index, segment } of segmenter.segment(value)) if (index >= at) return index + segment.length;
  return value.length;
}

/** Inserts pasted text: kept as is in a multi-line box; newlines become spaces in a one-line field. */
export function pasteText(s: Edit, text: string, multiline: boolean): Edit {
  const t = text.replace(/\r\n?/g, '\n');
  return put({ value: s.value, cursor: clamp(s.cursor, s.value) }, s.cursor, s.cursor, multiline ? t : t.replace(/\n+/g, ' '));
}
const put = (s: Edit, from: number, to: number, text: string): Edit => ({ value: s.value.slice(0, from) + text + s.value.slice(to), cursor: from + text.length });

export function applyKey(s0: Edit, input: string, key: Partial<Key>, opts: EditOpts = {}): EditResult {
  const s = { value: s0.value, cursor: clamp(s0.cursor, s0.value) };
  const { value, cursor } = s;
  const same = { next: s };
  const multi = !!opts.multiline;
  const rows = multi ? rowsOf(value, opts.width ?? 80) : [{ start: 0, end: value.length }];
  const row = rowOf(rows, cursor);
  const r = rows[row]!;

  if (key.escape || key.tab) return { next: s, action: 'blur' };
  if (key.return) {
    if (multi && key.meta) return { next: put(s, cursor, cursor, '\n') };
    if (multi && cursor > 0 && value[cursor - 1] === '\\') return { next: put(s, cursor - 1, cursor, '\n') };
    return { next: s, action: 'submit' };
  }
  if (key.backspace) {
    if (key.meta || key.ctrl) return { next: put(s, wordLeft(value, cursor), cursor, '') };
    return cursor > 0 ? { next: put(s, prevGrapheme(value, cursor), cursor, '') } : same;
  }
  if (key.delete) return cursor < value.length ? { next: put(s, cursor, nextGrapheme(value, cursor), '') } : same;
  if (key.leftArrow) return { next: { value, cursor: key.meta || key.ctrl ? wordLeft(value, cursor) : prevGrapheme(value, cursor) } };
  if (key.rightArrow) return { next: { value, cursor: key.meta || key.ctrl ? wordRight(value, cursor) : nextGrapheme(value, cursor) } };
  if (key.home) return { next: { value, cursor: r.start } };
  if (key.end) return { next: { value, cursor: r.end } };
  if (key.upArrow || key.downArrow) {
    if (!multi) return same;
    const to = row + (key.upArrow ? -1 : 1);
    if (to < 0) return { next: s, action: 'up' };
    if (to >= rows.length) return { next: s, action: 'down' };
    const t = rows[to]!;
    return { next: { value, cursor: Math.min(t.start + (cursor - r.start), t.end) } };
  }
  if (key.ctrl) {
    switch (input) {
      case 'w':
        return { next: put(s, wordLeft(value, cursor), cursor, '') };
      // To the start / end of the current line (the whole value in a one-line field).
      case 'u':
        return { next: put(s, cursor === 0 ? 0 : value.lastIndexOf('\n', cursor - 1) + 1, cursor, '') };
      case 'k': {
        const end = value.indexOf('\n', cursor);
        return { next: put(s, cursor, end < 0 ? value.length : end, '') };
      }
      case 'a':
        return { next: { value, cursor: r.start } };
      case 'e':
        return { next: { value, cursor: r.end } };
    }
    return same;
  }
  if (key.meta) {
    if (input === 'b') return { next: { value, cursor: wordLeft(value, cursor) } };
    if (input === 'f') return { next: { value, cursor: wordRight(value, cursor) } };
    return same;
  }
  if (key.pageUp || key.pageDown || !input) return same;

  // Typed text, or a paste the terminal did not bracket. Enter sends "\r": a short chunk
  // ending in one "\r" (≤ 2 typed characters before it) is fast typing + Enter and submits.
  // Anything else with line breaks ("\n" anywhere, or a longer chunk) is a paste: inserted, never sent.
  const cr = input.indexOf('\r');
  if (!input.includes('\n') && cr >= 0 && cr === input.length - 1 && input.length <= 3) return { next: put(s, cursor, cursor, input.slice(0, -1)), action: 'submit' };
  if (/[\r\n]/.test(input)) return { next: pasteText(s, input, multi) };
  return { next: put(s, cursor, cursor, input) };
}

/** First visible row so that `row` stays inside a window of `visible` rows starting at `offset`. */
export function follow(offset: number, row: number, visible: number, total: number): number {
  let o = offset;
  if (row < o) o = row;
  else if (row >= o + visible) o = row - visible + 1;
  return Math.max(0, Math.min(o, Math.max(0, total - visible)));
}
