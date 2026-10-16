import { describe, expect, test } from 'bun:test';
import { cap, middleTruncate, topbarLayout, type TopbarInput } from './App.tsx';
import { TAB_PAD, layoutTabs } from './widgets.tsx';

const LONG = 'mi-proyecto-con-un-nombre-larguisimo-para-probar-la-cabecera-de-orq-2026-x'.padEnd(80, 'x');
const cases: [string, TopbarInput][] = [
  ['80-char dir, no session', { dir: LONG, alerts: 0, session: false, badges: { working: 0, agents: 0, unread: 0, live: 0 } }],
  ['120 unread', { dir: 'orq', perm: 'auto', alerts: 0, session: true, badges: { working: 1, agents: 2, unread: 120, live: 1 } }],
  ['YOLO + 12 alerts + long dir', { dir: LONG, perm: 'yolo', alerts: 12, session: true, badges: { working: 3, agents: 8, unread: 5, live: 2 } }],
  ['Auto/YOLO, 150 agents', { dir: 'Orquestrador de tareas', perm: 'auto-insecure', alerts: 140, session: true, badges: { working: 120, agents: 150, unread: 999, live: 100 } }],
];

describe('topbarLayout', () => {
  for (const [name, input] of cases)
    for (const compact of [false, true])
      for (const cols of [60, 80, 100, 140, 200])
        test(`${name} · ${cols} cols${compact ? ' · compact' : ''}`, () => {
          const t = topbarLayout(cols, { ...input, compact });
          const tabs = layoutTabs(t.tabs, cols, t.header.length ? t.rightWidth : 0, compact ? TAB_PAD.row : TAB_PAD.bordered);
          const tabsW = 1 + tabs.tabs.reduce((a, x) => a + x.width, 0);
          // Fits in one row of tabs (3 terminal rows, or 1 compact): tabs + right never exceed cols.
          expect(tabsW + (tabs.showRight ? t.rightWidth : 0)).toBeLessThanOrEqual(cols);
          // What we laid out in the header is exactly what ChromeTabs will show.
          if (t.header.length) expect(tabs.showRight).toBe(true);
          // Alerts never disappear; neither does a risky permission mode.
          const all = [...t.header, ...t.footer];
          if (input.alerts) expect(all.some((x) => x.kind === 'alert')).toBe(true);
          if (input.perm && input.perm !== 'auto') expect(all.some((x) => x.kind === 'perm')).toBe(true);
          // Salir is always reachable.
          expect(all.some((x) => x.kind === 'quit')).toBe(true);
          // The directory never takes more than 20 columns (+ its marker and space).
          for (const x of t.header) if (x.kind === 'dir') expect(x.width).toBeLessThanOrEqual(23);
          // Badges are capped at "99+".
          for (const tab of t.tabs) for (const n of (tab.badge ?? '').match(/\d+/g) ?? []) expect(n.length).toBeLessThanOrEqual(2);
        });

  test('wide screens keep everything in the header', () => {
    const t = topbarLayout(200, cases[2]![1]);
    expect(t.footer).toHaveLength(0);
    expect(t.header.map((x) => x.kind)).toEqual(['dir', 'perm', 'alert', 'detach', 'sep', 'stop', 'quit']);
  });

  test('the directory goes first, the permission glyph later', () => {
    const t = topbarLayout(140, cases[2]![1]);
    expect(t.header.some((x) => x.kind === 'dir')).toBe(false);
    expect(t.header.find((x) => x.kind === 'perm')?.label.trim()).toBe('YOLO');
  });

  test('compact office badge', () => {
    const t = topbarLayout(100, { ...cases[2]![1], compact: true });
    expect(t.tabs.find((x) => x.id === 'office')?.badge).toBe('⚠12 3/8');
  });
});

describe('helpers', () => {
  test('cap', () => {
    expect(cap(7)).toBe('7');
    expect(cap(99)).toBe('99');
    expect(cap(100)).toBe('99+');
  });
  test('middleTruncate', () => {
    expect(middleTruncate('Orquestrador de tareas', 20)).toBe('Orquestrad…de tareas');
    expect(middleTruncate('Orquestrador de tareas', 20)).toHaveLength(20);
    expect(middleTruncate('Orquestrador de tareas', 20)).toContain('…');
    expect(middleTruncate('orq', 20)).toBe('orq');
  });
});

describe('topbarLayout · usage', () => {
  const usage = { full: '5h ▰▰▰▱▱ 62% · Sem 31% ', pcts: '5h 62% · Sem 31%', top: '5h 62%', critical: false };
  const critical = { full: '⚠ 5h ▰▰▰▰▰ 93% · Sem 31%', pcts: '⚠ 5h 93% · Sem 31%', top: '⚠ 5h 93%', critical: true };
  const session = cases[2]![1];
  test('wide: full usage and the session spend, right before Salir', () => {
    const t = topbarLayout(240, { ...session, usage, spend: '≈1,2M' });
    const kinds = t.header.map((x) => x.kind);
    expect(kinds).toContain('usage');
    expect(kinds.indexOf('spend')).toBe(kinds.indexOf('usage') + 1);
    expect(kinds.at(-1)).toBe('quit');
    expect(t.header.find((x) => x.kind === 'usage')!.label.trim()).toBe(usage.full.trim());
  });
  test('the spend goes first, then the directory, before the usage shrinks', () => {
    for (const cols of [100, 120, 140, 160, 200]) {
      const t = topbarLayout(cols, { ...session, usage, spend: '≈1,2M' });
      const u = t.header.find((x) => x.kind === 'usage');
      if (t.header.some((x) => x.kind === 'dir')) expect(u?.label.trim()).toBe(usage.full.trim());
      if (t.header.some((x) => x.kind === 'spend')) expect(t.header.some((x) => x.kind === 'dir')).toBe(true);
    }
  });
  for (const cols of [60, 80, 100, 140])
    test(`≥90 % never disappears (${cols} cols), and everything fits`, () => {
      const t = topbarLayout(cols, { ...session, usage: critical });
      expect([...t.header, ...t.footer].some((x) => x.kind === 'usage')).toBe(true);
      const tabs = layoutTabs(t.tabs, cols, t.header.length ? t.rightWidth : 0, TAB_PAD.bordered);
      expect(1 + tabs.tabs.reduce((a, x) => a + x.width, 0) + (tabs.showRight ? t.rightWidth : 0)).toBeLessThanOrEqual(cols);
    });
  test('without a session the usage is still shown', () => {
    const t = topbarLayout(200, { ...cases[0]![1], usage });
    expect(t.header.map((x) => x.kind)).toEqual(['nosession', 'usage', 'quit']);
  });
});

describe('topbarLayout · usage before short action labels', () => {
  test('actions shorten before the usage drops to its narrowest form', () => {
    const usage = { full: '5h ▰▰▰▱▱ 62% · Sem 31%', pcts: '5h 62% · Sem 31%', top: '5h 62%', critical: false };
    const t = topbarLayout(150, { dir: 'Orquestrador de tareas', perm: 'auto', alerts: 0, session: true, badges: { working: 1, agents: 5, unread: 0, live: 1 }, usage });
    expect(t.header.find((x) => x.kind === 'usage')?.label.trim()).toBe(usage.pcts);
    expect(t.header.find((x) => x.kind === 'stop')?.label).toContain('Det.');
  });
});
