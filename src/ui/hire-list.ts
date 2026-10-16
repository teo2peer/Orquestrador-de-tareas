// Pure logic of «Contratar»: which roles can still be hired, how many fit in the bar
// (the rest go behind «Más… (+N)»), the filter and the grouped list of the popup.
import stringWidth from 'string-width';
import type { Role } from '../types.ts';

/** Library roles not in the session yet, one per id, in library order. */
export function freeRoles(roles: Role[], hired: Iterable<string>): Role[] {
  const taken = new Set(hired);
  const seen = new Set<string>();
  return roles.filter((r) => !taken.has(r.id) && !r.area && !seen.has(r.id) && !!seen.add(r.id));
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Roles whose name, title, id, pack or description contain every word of `query` (accents ignored). */
export function filterRoles(roles: Role[], query: string): Role[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return roles;
  return roles.filter((r) => {
    const hay = fold(`${r.name} ${r.title} ${r.id} ${r.pack ?? ''} ${r.description}`);
    return words.every((w) => hay.includes(w));
  });
}

/** Columns of a chip in the bar: "[name]" plus its right margin. */
export const chipWidth = (r: Role) => stringWidth(r.name) + 2 + 1;
export const moreLabel = (n: number) => `Más… (+${n})`;
/** Columns of the «Más… (+N)» button (secondary: "[ label ]" + margin). */
export const moreWidth = (n: number) => stringWidth(moreLabel(n)) + 4 + 1;

/**
 * Chips of `roles[start…]` that fit in `rows` wrapped rows of `width` columns, leaving room
 * for «Más… (+N)» when some do not fit. `more` counts every free role not shown (before
 * and after the window), 0 when they all fit.
 */
export function barFit(roles: Role[], width: number, rows: number, start = 0): { start: number; count: number; more: number } {
  const place = (from: number, reserve: number) => {
    let row = 0;
    let x = 0;
    let n = 0;
    for (let i = from; i < roles.length; i++) {
      const w = Math.min(chipWidth(roles[i]!), width);
      if (x + w > width) {
        row++;
        x = 0;
      }
      // The last row keeps room for the «Más» button.
      if (row >= rows || (row === rows - 1 && x + w > width - reserve)) break;
      x += w;
      n++;
    }
    return n;
  };
  const s = Math.max(0, Math.min(start, roles.length - 1));
  const all = place(0, 0);
  if (s === 0 && all === roles.length) return { start: 0, count: all, more: 0 };
  const count = place(s, moreWidth(roles.length));
  return { start: s, count, more: roles.length - count };
}

/** Window start so that `at` is visible in a bar showing about `count` chips. */
export const barStart = (at: number, start: number, count: number) => (at < start ? at : at >= start + Math.max(1, count) ? at - Math.max(1, count) + 1 : start);

export type HireRow = { kind: 'group'; label: string } | { kind: 'role'; role: Role; index: number };

/** Popup rows: roles grouped by pack («Propios» first), `index` = position among the roles. */
export function groupedRows(roles: Role[]): { rows: HireRow[]; order: Role[] } {
  const groups = new Map<string, Role[]>();
  for (const r of roles) {
    const k = r.pack ?? 'Propios';
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === 'Propios' ? -1 : b === 'Propios' ? 1 : a.localeCompare(b)));
  const rows: HireRow[] = [];
  const order: Role[] = [];
  for (const k of keys) {
    rows.push({ kind: 'group', label: k });
    for (const r of groups.get(k)!) rows.push({ kind: 'role', role: r, index: order.push(r) - 1 });
  }
  return { rows, order };
}

/** Printable text of a typed or pasted chunk for the filter: line breaks become spaces, controls go. */
export const filterChunk = (input: string) => input.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
