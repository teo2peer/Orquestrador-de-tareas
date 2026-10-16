import { describe, expect, test } from 'bun:test';
import { applyKey, follow, rowOf, rowsOf, wordLeft, wordRight } from './text-edit.ts';

const at = (value: string, cursor = value.length) => ({ value, cursor });
const k = (s: { value: string; cursor: number }, input: string, key: Record<string, boolean> = {}, multiline = false, width = 10) =>
  applyKey(s, input, key, { multiline, width });

describe('words', () => {
  test('left and right skip separators then the word', () => {
    expect(wordLeft('hola  mundo', 11)).toBe(6);
    expect(wordLeft('hola  mundo', 6)).toBe(0);
    expect(wordRight('hola  mundo', 0)).toBe(4);
    expect(wordRight('hola  mundo', 4)).toBe(11);
    expect(wordLeft('año-ñu', 6)).toBe(4);
  });
});

describe('deleting', () => {
  test('backspace deletes back, Supr (delete) deletes forward', () => {
    expect(k(at('abc', 1), '', { backspace: true }).next).toEqual(at('bc', 0));
    expect(k(at('abc', 1), '', { delete: true }).next).toEqual(at('ac', 1));
    expect(k(at('abc', 3), '', { delete: true }).next).toEqual(at('abc', 3));
    expect(k(at('abc', 0), '', { backspace: true }).next).toEqual(at('abc', 0));
  });
  test('Ctrl+W and ⌥⌫ delete the previous word', () => {
    expect(k(at('git commit -m'), 'w', { ctrl: true }).next).toEqual(at('git commit -', 12));
    expect(k(at('hola mundo'), '', { backspace: true, meta: true }).next).toEqual(at('hola ', 5));
  });
  test('Ctrl+U deletes to the start of the line, Ctrl+K to its end', () => {
    expect(k(at('hola mundo', 5), 'u', { ctrl: true }).next).toEqual(at('mundo', 0));
    expect(k(at('hola mundo', 4), 'k', { ctrl: true }).next).toEqual(at('hola', 4));
    expect(k(at('uno\ndos tres', 8), 'u', { ctrl: true }, true).next).toEqual(at('uno\ntres', 4));
    expect(k(at('uno dos\ntres', 3), 'k', { ctrl: true }, true).next).toEqual(at('uno\ntres', 3));
  });
});

describe('moving', () => {
  test('arrows, ⌥←→ / Meta+b/f by word, Ctrl+A/E and Inicio/Fin', () => {
    expect(k(at('abc', 1), '', { leftArrow: true }).next.cursor).toBe(0);
    expect(k(at('abc', 0), '', { leftArrow: true }).next.cursor).toBe(0);
    expect(k(at('abc', 3), '', { rightArrow: true }).next.cursor).toBe(3);
    expect(k(at('uno dos', 7), 'b', { meta: true }).next.cursor).toBe(4);
    expect(k(at('uno dos', 0), 'f', { meta: true }).next.cursor).toBe(3);
    expect(k(at('uno dos', 7), '', { leftArrow: true, meta: true }).next.cursor).toBe(4);
    expect(k(at('uno dos', 3), 'a', { ctrl: true }).next.cursor).toBe(0);
    expect(k(at('uno dos', 3), 'e', { ctrl: true }).next.cursor).toBe(7);
    expect(k(at('uno dos', 3), '', { home: true }).next.cursor).toBe(0);
    expect(k(at('uno dos', 3), '', { end: true }).next.cursor).toBe(7);
  });
  test('multi-line Inicio/Fin work on the current row', () => {
    const s = at('uno\ndos', 5);
    expect(k(s, '', { home: true }, true).next.cursor).toBe(4);
    expect(k(s, '', { end: true }, true).next.cursor).toBe(7);
  });
  test('↑↓ change row keeping the column and leave the field at the edges', () => {
    const s = at('abcdef\nxy', 5);
    expect(k(s, '', { downArrow: true }, true).next.cursor).toBe(9); // clamped to the short row
    expect(k(at('abcdef\nxy', 8), '', { upArrow: true }, true).next.cursor).toBe(1);
    expect(k(s, '', { upArrow: true }, true).action).toBe('up');
    expect(k(at('abcdef\nxy', 8), '', { downArrow: true }, true).action).toBe('down');
    expect(k(at('ab'), '', { upArrow: true }).action).toBeUndefined(); // one line: ignored
  });
  test('wrapped rows count as rows', () => {
    const s = at('0123456789abcdef', 12); // width 10: rows [0,10) [10,16)
    expect(k(s, '', { upArrow: true }, true, 10).next.cursor).toBe(2);
  });
});

describe('typing and Enter', () => {
  test('inserts at the cursor', () => expect(k(at('ac', 1), 'b').next).toEqual(at('abc', 2)));
  test('Enter submits; Esc/Tab blur', () => {
    expect(k(at('x'), '', { return: true }).action).toBe('submit');
    expect(k(at('x'), '', { escape: true }).action).toBe('blur');
    expect(k(at('x'), '', { tab: true }).action).toBe('blur');
  });
  test('multi-line: Alt+Enter and "\\"+Enter insert a newline', () => {
    expect(k(at('a'), '', { return: true, meta: true }, true).next).toEqual(at('a\n', 2));
    expect(k(at('a\\'), '', { return: true }, true).next).toEqual(at('a\n', 2));
  });
  test('fast typing + Enter (short chunk ending in \\r) submits', () => {
    expect(k(at(''), 'ok\r')).toEqual({ next: at('ok'), action: 'submit' });
    expect(k(at(''), 'x\r', {}, true)).toEqual({ next: at('x'), action: 'submit' });
  });
  test('a paste with line breaks is inserted, never sent; one-line fields get spaces', () => {
    expect(k(at(''), 'a\nb')).toEqual({ next: at('a b') });
    expect(k(at(''), 'x\n', {}, true)).toEqual({ next: at('x\n') });
    expect(k(at(''), 'a\nb', {}, true)).toEqual({ next: at('a\nb') });
    expect(k(at(''), 'línea uno\rlínea dos\r', {}, true)).toEqual({ next: at('línea uno\nlínea dos\n') });
    expect(k(at(''), 'hola mundo\r')).toEqual({ next: at('hola mundo ') });
  });
  test('other control keys do nothing', () => expect(k(at('ab', 1), 'x', { ctrl: true }).next).toEqual(at('ab', 1)));
});

describe('graphemes', () => {
  test('⌫, Supr and ←→ treat an emoji (or a flag, or a combined accent) as one character', () => {
    const v = 'a👍🏽b🇪🇸';
    expect(k(at(v, 5), '', { backspace: true }).next).toEqual(at('ab🇪🇸', 1));
    expect(k(at(v, 1), '', { delete: true }).next).toEqual(at('ab🇪🇸', 1));
    expect(k(at(v, 1), '', { rightArrow: true }).next.cursor).toBe(5);
    expect(k(at(v), '', { leftArrow: true }).next.cursor).toBe(6);
    expect(k(at('e\u0301'), '', { backspace: true }).next).toEqual(at(''));
  });
  test('Ctrl+U at the very start does nothing', () => {
    expect(k(at('\nabc', 0), 'u', { ctrl: true }, true).next).toEqual(at('\nabc', 0));
    expect(k(at('abc', 0), 'u', { ctrl: true }).next).toEqual(at('abc', 0));
  });
});

describe('layout', () => {
  test('rows of a wrapped value', () => {
    expect(rowsOf('', 5)).toEqual([{ start: 0, end: 0 }]);
    expect(rowsOf('abcdefg\n\nx', 5)).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 7 },
      { start: 8, end: 8 },
      { start: 9, end: 10 },
    ]);
  });
  test('cursor row: at a full row end it moves to the next row', () => {
    const rows = rowsOf('abcdefg', 5);
    expect(rowOf(rows, 5)).toBe(1);
    expect(rowOf(rows, 7)).toBe(1);
    expect(rowOf(rowsOf('ab\ncd', 5), 2)).toBe(0);
  });
  test('scroll follows the cursor', () => {
    expect(follow(0, 5, 3, 10)).toBe(3);
    expect(follow(4, 2, 3, 10)).toBe(2);
    expect(follow(9, 9, 3, 10)).toBe(7);
  });
});
