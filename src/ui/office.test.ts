import { describe, expect, test } from 'bun:test';
import { officeBudget } from './Office.tsx';

// Body heights of the office for terminals from 80x24 (bodyH = rows - tabs - footer) upwards.
const heights = [20, 22, 23, 24, 26, 28, 30, 35, 41, 50];

describe('officeBudget', () => {
  for (const h of heights)
    for (const alerts of [0, 1, 3, 4, 12])
      for (const expanded of [false, true])
        for (const hiring of [false, true])
          test(`h=${h} alerts=${alerts} expanded=${expanded} hiring=${hiring}`, () => {
            const b = officeBudget(h, alerts, expanded, hiring);
            // Adds up exactly: nothing overflows, nothing is squeezed.
            expect(b.headH + b.floorH + b.hireH + b.noticesH + b.composerH).toBe(h);
            // The composer always keeps at least one usable row.
            expect(b.composerRows).toBeGreaterThanOrEqual(1);
            expect(b.composerH).toBe(2 + 1 + b.composerRows + 2);
            // Alerts never disappear: at least the one-line summary.
            if (alerts) expect(b.noticesH).toBeGreaterThanOrEqual(1);
            else expect(b.noticesH).toBe(0);
          });

  test('the floor keeps a list header and one agent row at 80x24 with everything open', () => {
    const b = officeBudget(22, 12, true, true);
    expect(b.floorH).toBeGreaterThanOrEqual(5);
  });

  test('alerts collapse to one line before the floor drops below its minimum', () => {
    const b = officeBudget(20, 12, true, true);
    expect(b.noticesLine || b.noticesH <= 6).toBe(true);
    expect(b.floorH).toBeGreaterThanOrEqual(0);
  });
});

import { officeHeader } from './Office.tsx';

describe('office header', () => {
  const stats = '12 agentes · 3 trabajando · Auto · Consumo: Equilibrado';
  for (const width of [80, 100, 120, 160, 220])
    for (const title of [undefined, 'Refactor del modo por partes y del uso de Claude'])
      test(`${width} cols${title ? ' with a long title' : ''}: everything fits, nothing overlaps`, () => {
        const h = officeHeader(width, { title, provisional: !!title, stats });
        expect(h.used).toBeLessThanOrEqual(width);
        expect(h.titleMax).toBeGreaterThanOrEqual(1);
        expect(h.statsW).toBeGreaterThan(0);
      });
  test('a long provisional title never pushes [ + Contratar ] out at 80', () => {
    for (const w of [80, 90, 100]) {
      const h = officeHeader(w, { title: 'Implementar el nuevo flujo de reanudar sesiones con resumen', provisional: true, stats });
      expect(h.used).toBeLessThanOrEqual(w);
      expect(h.leftW + h.hireW).toBe(w);
    }
  });
  test('the legend is the first to go; the rename label shrinks to ✎ when narrow', () => {
    expect(officeHeader(80, { title: 'x', stats }).legend).toBe(false);
    expect(officeHeader(80, { title: 'Refactor del modo por partes', stats }).renameShort).toBe(true);
    expect(officeHeader(80, { title: 'x', stats }).renameShort).toBe(false);
    expect(officeHeader(120, { title: 'Refactor del modo por partes', stats }).legend).toBe(false);
    expect(officeHeader(220, { title: 'Corto', stats })).toMatchObject({ legend: true, renameShort: false });
  });
});

import { dormantNote } from './Office.tsx';

describe('dormant agents', () => {
  test('pending FYIs are counted; none ⇒ the usual note', () => {
    expect(dormantNote({ inbox: [] })).toBe('arranca con su primera tarea');
    expect(dormantNote({ inbox: [{}] as never })).toBe('1 aviso pendiente');
    expect(dormantNote({ inbox: [{}, {}, {}] as never })).toBe('3 avisos pendientes');
  });
});
