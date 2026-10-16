import { Box, Text, useInput } from 'ink';
import sliceAnsi from 'slice-ansi';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import React, { useEffect, useState } from 'react';
import * as tmux from '../tmux.ts';
import type { Agent } from '../types.ts';
import { useApp, useSize, wrap } from './app-context.tsx';
import { moveIndex, useInteract, useKeyboardCursor, useNav, useShortcuts } from './keymap.tsx';
import { Clickable } from './mouse.tsx';
import { toHex } from './sprites.ts';
import { g } from './glyphs.ts';
import { BORDER, DONE, FOCUS, INTERACT, MSG_TYPE_ES, MUTED, RECEIVED, SENT, STATUS, SUCCESS, TEXT, WARN } from './theme.ts';
import { BackButton, Button, Toggle, backButtonWidth, toggleWidth, useFocusState, Scrollbar } from './widgets.tsx';

/** Key that leaves interactive mode: ORQ_TERMINAL_EXIT ("Ctrl+]" by default, any "Ctrl+<char>"). */
const EXIT_CHAR = /^ctrl\+(.)$/i.exec(process.env.ORQ_TERMINAL_EXIT?.trim() ?? '')?.[1]?.toLowerCase() ?? ']';
export const EXIT_LABEL = `Ctrl+${EXIT_CHAR === ']' ? ']' : EXIT_CHAR.toUpperCase()}`;
// Ctrl+] and Ctrl+5 both send 0x1D; also accept their CSI-u / modifyOtherKeys encodings.
const EXIT_SEQ = /\x1b?\[(?:(?:93|53);5u|27;5;(?:93|53)~)$/;
const ESC_WINDOW = 600;

const isExit = (input: string, key: { ctrl: boolean }) =>
  (key.ctrl && (input.toLowerCase() === EXIT_CHAR || input === ']' || input === '5')) || input === '\x1d' || EXIT_SEQ.test(input);

const KEYMAP: [string, string][] = [
  ['return', 'Enter'],
  ['escape', 'Escape'],
  ['backspace', 'BSpace'],
  ['delete', 'BSpace'],
  ['tab', 'Tab'],
  ['upArrow', 'Up'],
  ['downArrow', 'Down'],
  ['leftArrow', 'Left'],
  ['rightArrow', 'Right'],
  ['pageUp', 'PageUp'],
  ['pageDown', 'PageDown'],
];

/** Polls a tmux pane every `ms` and returns its ANSI screen. */
export function useCapture(target: string | undefined, ms = 500) {
  const [screen, setScreen] = useState('');
  useEffect(() => {
    if (!target) return;
    const poll = () => setScreen(tmux.capture(target));
    poll();
    const t = setInterval(poll, ms);
    return () => clearInterval(t);
  }, [target, ms]);
  return screen;
}

const WHEEL_STEP = 3;
const blank = (l: string) => !stripAnsi(l).trim();

/** Draws the terminal cursor over an ANSI line: inverse cell, or "█" over a blank. */
export function withCursor(line: string, x: number, dim = false) {
  const before = sliceAnsi(line, 0, x);
  const pad = ' '.repeat(Math.max(0, x - stringWidth(before)));
  const ch = stripAnsi(sliceAnsi(line, x, x + 1));
  const cell = !ch || ch === ' ' ? '█' : `\x1b[7m${ch}\x1b[27m`;
  return `${before}${pad}\x1b[0m${dim ? `\x1b[2m${cell}\x1b[22m` : cell}${sliceAnsi(line, x + 1)}`;
}

/**
 * Live view of a tmux window. When `fit` is set the window is resized to the
 * view so full-screen programs reflow; with `interact` keystrokes are forwarded.
 * The wheel scrolls back through tmux history (live updates pause meanwhile);
 * the program's cursor is drawn over the screen.
 */
/** Placeholder of an agent that has not started yet (lazy start): there is no terminal to show. */
export function DormantPane({ width, height, title, color = BORDER }: { width: number; height: number; title?: React.ReactNode; color?: string }) {
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={color} paddingX={1} overflow="hidden">
      {title}
      <Text color={MUTED} wrap="wrap">
        {g.dormant} En espera: arrancará al recibir su primera tarea. Todavía no tiene terminal.
      </Text>
    </Box>
  );
}

export function LivePane({
  target,
  width,
  height,
  title,
  color = BORDER,
  fit,
  onExitInteract,
  interact,
  keyboard,
}: {
  target: string;
  width: number;
  height: number;
  title?: React.ReactNode;
  color?: string;
  fit?: boolean;
  interact?: boolean;
  onExitInteract?: () => void;
  /** Focused pane: RePág/AvPág/Inicio/Fin scroll its history (outside interact). */
  keyboard?: boolean;
}) {
  const { setToast } = useApp();
  const { setFocused } = useFocusState();
  const escs = React.useRef<number[]>([]);
  const innerH = height - 2 - (title ? 1 : 0);
  const [snap, setSnap] = useState<tmux.Snapshot | null>(null);
  // Lines scrolled up from the live view; `anchor` is the history size when scrolling began,
  // so output that arrives meanwhile does not move the text being read.
  const [offset, setOffset] = useState(0);
  const anchor = React.useRef(0);
  const liveStart = React.useRef(0);
  const histMode = offset > 0;
  const viewH = Math.max(1, histMode ? innerH - 1 : innerH);

  useEffect(() => {
    const poll = () => {
      if (!histMode) return setSnap(tmux.snapshot(target));
      const grown = Math.max(0, (snap?.history ?? anchor.current) - anchor.current);
      const top = liveStart.current - offset - grown;
      setSnap(tmux.snapshot(target, [top, top + viewH - 1]));
    };
    poll();
    const t = setInterval(poll, interact ? 150 : 500);
    return () => clearInterval(t);
  }, [target, interact, histMode, offset, viewH, snap?.history]);

  useEffect(() => {
    if (!fit) return;
    tmux.resize(target, width - 2, innerH);
    return () => void tmux.resize(target, 160, 48);
  }, [target, width, innerH, fit]);

  useEffect(() => {
    if (!interact) return;
    setFocused('tmux');
    return () => setFocused(null);
  }, [interact]);
  useInteract(!!interact);

  useInput(
    (input, key) => {
      // The exit key leaves (Ctrl+X must reach nano & co. inside the agent's terminal).
      if (isExit(input, key)) return onExitInteract?.();
      // Fallback: a third Esc within ESC_WINDOW leaves; the first two still reach tmux.
      if (key.escape) {
        const now = Date.now();
        escs.current = [...escs.current.filter((t) => now - t < ESC_WINDOW), now];
        if (escs.current.length >= 3) return (escs.current = [], onExitInteract?.());
      }
      // Alt+1..6 switches tabs in the shell; do not type the digit into the pane.
      if (key.meta && /^[1-6]$/.test(input)) return;
      if (key.ctrl && input) return void tmux.sendKeys(target, [`C-${input}`]);
      for (const [k, name] of KEYMAP) if ((key as any)[k]) return void tmux.sendKeys(target, [name]);
      if (input) tmux.sendLiteral(target, input);
    },
    { isActive: !!interact },
  );

  // Live geometry: a fitted pane shows its whole screen; a bigger one shows the
  // last rows with content (keeping the cursor row when typing).
  const lines = snap?.lines ?? [];
  let live = 0;
  if (!histMode && snap) {
    let last = lines.length - 1;
    if (!fit && lines.length > innerH) {
      while (last > 0 && blank(lines[last]!)) last--;
      if (interact || snap.cursorOn) last = Math.max(last, snap.cy);
    }
    live = Math.max(0, last + 1 - innerH);
    liveStart.current = live;
  }
  const grown = histMode && snap ? Math.max(0, snap.history - anchor.current) : 0;
  const maxOffset = liveStart.current + anchor.current;
  const shown = histMode ? lines.slice(0, viewH) : lines.slice(live, live + innerH);
  const cursorRow = snap && !histMode && !snap.inMode && (interact || snap.cursorOn) ? snap.cy - live : -1;

  const scrollTo = (next: number) => {
    const n = Math.max(0, Math.min(histMode ? maxOffset : liveStart.current + (snap?.history ?? 0), Math.round(next)));
    if (!histMode && n > 0) anchor.current = snap?.history ?? 0;
    setOffset(n);
  };
  const onWheel = (d: number) => {
    if (!snap) return;
    // Programs that read the mouse (claude's full-screen UI) scroll themselves: forward the wheel.
    if (snap.mouse) return void tmux.sendWheel(target, d < 0, Math.floor((width - 2) / 2), Math.floor(innerH / 2), WHEEL_STEP);
    if (snap.alt) {
      // Full-screen programs keep no tmux history: scroll them, or explain how.
      if (interact) return void tmux.sendKeys(target, Array(WHEEL_STEP).fill(d < 0 ? 'Up' : 'Down'));
      return setToast('Este programa no tiene historial; entra en Escribir para desplazarte');
    }
    scrollTo(offset + (d < 0 ? WHEEL_STEP : -WHEEL_STEP));
  };
  const above = histMode ? Math.max(0, anchor.current + liveStart.current - offset) : 0;
  const page = Math.max(1, viewH - 1);
  useShortcuts(
    'livepane',
    [
      { keys: ['pageup'], run: () => (snap?.alt ? onWheel(-1) : scrollTo(offset + page)) },
      { keys: ['pagedown'], run: () => scrollTo(offset - page) },
      { keys: ['home'], run: () => scrollTo(liveStart.current + (snap?.history ?? 0)) },
      { keys: ['end'], run: () => scrollTo(0) },
    ],
    { active: !!keyboard && !interact },
  );

  return (
    <Clickable
      onWheel={onWheel}
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={interact ? INTERACT.borderStyle : 'round'}
      borderColor={interact ? INTERACT.borderColor : color}
      overflow="hidden"
      flexShrink={0}
    >
      {title && <Box flexShrink={0}>{title}</Box>}
      {histMode && (
        <Text color={WARN} wrap="truncate">
          {/* New output goes first so it survives truncation in narrow panes. */}
          {grown > 0 ? (
            <Text color={SUCCESS}>
              {g.on} hay salida nueva {g.sep}{' '}
            </Text>
          ) : null}
          ↑ historial {g.sep} {above} líneas por encima {g.sep} rueda abajo = volver al vivo
        </Text>
      )}
      <Box flexDirection="row" height={histMode ? viewH : innerH}>
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {shown.map((l, i) => (
            <Text key={i} wrap="truncate">
              {i === cursorRow ? withCursor(l, snap!.cx, !interact) : l || ' '}
            </Text>
          ))}
        </Box>
        {histMode && (
          <Scrollbar total={maxOffset + viewH} visible={viewH} offset={maxOffset - offset} onScroll={(n) => scrollTo(maxOffset - n)} height={viewH} />
        )}
      </Box>
    </Clickable>
  );
}

function PaneTitle({ a, extra }: { a: Agent; extra?: string }) {
  const st = STATUS[a.status];
  return (
    <Text bold wrap="truncate" color={toHex(a.role.color)}>
      {a.role.area ? `${g.area} ` : ''}
      {a.role.name}{' '}
      <Text color={st.color}>
        {st.glyph} {st.label}
      </Text>
      {a.lastTool && a.status === 'working' ? (
        <Text color={MUTED}>
          {' '}
          {g.sep} {a.lastTool}
        </Text>
      ) : null}
      {extra ? (
        <Text color={MUTED}>
          {' '}
          {g.sep} {extra}
        </Text>
      ) : null}
    </Text>
  );
}

export function Terminals({ height }: { height: number }) {
  const { hq, setTab } = useApp();
  const { cols } = useSize();
  const cursor = useKeyboardCursor();
  const [nav, setNav] = useNav('terminals');
  const [zoom, setZoom] = useState<string | null>(null);
  const [view, setView] = useState<'claude' | 'shell'>('claude');
  const [interact, setInteract] = useState(false);
  const [page, setPage] = useState(0);
  const agents = hq ? [...hq.agents.values()] : [];
  const zoomed = zoom ? hq?.agents.get(zoom) : undefined;

  // Grid geometry (needed by the keys below): every agent visible; paginate only if they truly do not fit.
  const perRow = agents.length === 1 ? 1 : cols >= 200 ? 3 : cols >= 110 ? 2 : 1;
  const rowsNeeded = Math.ceil(agents.length / perRow);
  const minPaneH = 8;
  const rowsFit = Math.max(1, Math.min(rowsNeeded, Math.floor((height - 1) / minPaneH)));
  const pages = Math.max(1, Math.ceil(rowsNeeded / rowsFit));
  const p = Math.min(page, pages - 1);
  const perPage = rowsFit * perRow;
  const index = Math.min(nav.index, Math.max(0, agents.length - 1));
  const moveTo = (n: number) => (setNav({ zone: 'grid', index: n }), setPage(Math.floor(n / perPage)));
  useShortcuts(
    'terminals/grid',
    [
      ...['up', 'down', 'left', 'right', 'home', 'end'].map((k) => ({ keys: [k], run: () => moveTo(moveIndex(index, agents.length, perRow, k)) })),
      { keys: ['pageup'], run: () => moveTo(Math.max(0, (p - 1) * perPage)) },
      { keys: ['pagedown'], run: () => moveTo(Math.min(agents.length - 1, (p + 1) * perPage)) },
      { keys: ['enter'], run: () => agents[index] && setZoom(agents[index]!.id) },
    ],
    { active: !zoomed && agents.length > 0, footer: 'terminals.grid' },
  );
  useShortcuts(
    'terminals/zoom',
    [
      { keys: ['[', ']'], run: () => setView(view === 'claude' ? 'shell' : 'claude') },
      // A dormant agent has no terminal to type into yet.
      { keys: ['w'], run: () => zoomed?.status !== 'dormant' && setInteract(true) },
      { keys: ['esc'], run: () => setZoom(null) },
    ],
    { active: !!zoomed && !interact, footer: 'terminals.zoom' },
  );

  if (!hq || !agents.length)
    return (
      <Box padding={2} flexDirection="column">
        <Text bold>No hay agentes en marcha.</Text>
        <Box marginTop={1}>
          <Button variant="primary" label="Ver equipos" onClick={() => setTab('teams')} />
        </Box>
      </Box>
    );

  if (zoomed) {
    const sideW = Math.min(44, Math.max(30, Math.floor(cols * 0.24)));
    const mainW = cols - sideW - 1;
    const others = agents;
    const thumbH = Math.max(4, Math.min(9, Math.floor((height - 1) / others.length)));
    return (
      <Box flexDirection="row" height={height}>
        <Box flexDirection="column" width={mainW}>
          <Box flexDirection="row" flexShrink={0} alignItems="center" height={1} overflow="hidden">
            {/* Short label when the long one would push the view toggle out of the column. */}
            <BackButton
              label={backButtonWidth('Volver a todas') + toggleWidth(['Claude', 'Comandos']) <= mainW ? 'Volver a todas' : 'Volver'}
              onClick={() => (setInteract(false), setZoom(null))}
            />
            <Toggle
              label="Terminal"
              value={view}
              onChange={(v) => (setInteract(false), setView(v))}
              options={[
                { value: 'claude', label: 'Claude' },
                { value: 'shell', label: 'Comandos' },
              ]}
            />
            <Text> </Text>
            <Button
              variant={interact ? 'secondary' : 'primary'}
              label={interact ? `${g.write} Escribiendo ${g.sep} ${EXIT_LABEL} sale` : `${g.write} Escribir (sales con ${EXIT_LABEL})`}
              disabled={zoomed.status === 'dormant'}
              onClick={() => setInteract(!interact)}
            />
            <Text color={MUTED} wrap="truncate">
              {' '}
              {tmux.attachCommand(tmux.win(zoomed.tmux, view))}
            </Text>
          </Box>
          {zoomed.status === 'dormant' ? (
            <DormantPane width={mainW} height={height - 1} color={toHex(zoomed.role.color)} title={<PaneTitle a={zoomed} />} />
          ) : (
          <LivePane
            key={`${zoomed.id}-${view}`}
            target={tmux.win(zoomed.tmux, view)}
            width={mainW}
            height={height - 1}
            fit
            interact={interact}
            onExitInteract={() => setInteract(false)}
            keyboard
            color={toHex(zoomed.role.color)}
            title={<PaneTitle a={zoomed} extra={view === 'claude' ? 'terminal de Claude' : 'terminal de comandos'} />}
          />
          )}
        </Box>
        <Box flexDirection="column" width={sideW} marginLeft={1}>
          {others.map((a) => (
            <Clickable key={a.id} onClick={() => (setInteract(false), setZoom(a.id))} height={thumbH} flexShrink={0}>
              {a.status === 'dormant' ? (
                <DormantPane width={sideW} height={thumbH} color={a.id === zoomed.id ? TEXT : toHex(a.role.color)} title={<PaneTitle a={a} />} />
              ) : (
                <LivePane
                  target={tmux.win(a.tmux, 'claude')}
                  width={sideW}
                  height={thumbH}
                  color={a.id === zoomed.id ? TEXT : toHex(a.role.color)}
                  title={<PaneTitle a={a} />}
                />
              )}
            </Clickable>
          ))}
        </Box>
      </Box>
    );
  }

  const paneH = Math.floor((height - 1) / rowsFit);
  const paneW = Math.floor((cols - 1) / perRow);
  const visible = agents.slice(p * rowsFit * perRow, (p + 1) * rowsFit * perRow);
  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="row" height={height - 1}>
      <Clickable onWheel={(d) => setPage(Math.max(0, Math.min(pages - 1, p + Math.sign(d))))} flexDirection="row" flexWrap="wrap" width={cols - 1} height={height - 1} overflow="hidden">
        {visible.map((a, i) => {
          const here = cursor.visible && p * perPage + i === index;
          return (
            <Clickable key={a.id} onClick={() => (setNav({ zone: 'grid', index: p * perPage + i }), cursor.hide(), setZoom(a.id))} width={paneW} height={paneH}>
              {a.status === 'dormant' ? (
                <DormantPane width={paneW} height={paneH} color={here ? FOCUS : toHex(a.role.color)} title={<PaneTitle a={a} />} />
              ) : (
                <LivePane
                  target={tmux.win(a.tmux, 'claude')}
                  width={paneW}
                  height={paneH}
                  color={here ? FOCUS : toHex(a.role.color)}
                  title={<PaneTitle a={a} extra={here ? `${g.cursor} ↵ ampliar` : 'clic para ampliar'} />}
                />
              )}
            </Clickable>
          );
        })}
      </Clickable>
      <Scrollbar total={pages} visible={1} offset={p} onScroll={(n) => setPage(Math.round(n))} height={height - 1} />
      </Box>
      <Text color={MUTED} wrap="truncate">
        {agents.length} terminales{pages > 1 ? ` ${g.sep} página ${p + 1}/${pages} (rueda)` : ''} {g.sep} clic en una para ampliarla
      </Text>
    </Box>
  );
}

export function msgColor(m: { from: string; to: string; type: string; body: string }) {
  if (m.type === 'report' && /^\[done\]/.test(m.body)) return DONE;
  if (m.from === 'user') return SENT;
  if (m.to === 'user') return RECEIVED;
  return TEXT;
}

export function Messages({ height }: { height: number }) {
  const { hq, expandMsg, openReply } = useApp();
  const { cols } = useSize();
  const cursor = useKeyboardCursor();
  const [nav, setNav] = useNav('messages');
  const [open, setOpen] = useState<Set<string>>(new Set(expandMsg ? [expandMsg] : []));
  const toggle = (id: string) => {
    const next = new Set(open);
    next.has(id) ? next.delete(id) : next.add(id);
    setOpen(next);
  };
  const msgs = hq?.messages ?? [];
  const bodyW = cols - 7;
  const rows = msgs.flatMap((m) => {
    const all = wrap(m.body, bodyW);
    const body = open.has(m.id) ? all : all.slice(0, 2);
    if (!open.has(m.id) && all.length > 2) body.push(`${g.ellipsis} +${all.length - 2} líneas (clic para desplegar)`);
    // Questions to you say whether they were answered.
    if (m.to === 'user' && m.type === 'question') {
      const a = hq?.answerOf(m.id);
      body.push(a ? `${g.tick} respondida: ${a.body.replace(/\s+/g, ' ')}` : `${g.on} pendiente ${g.sep} clic para responder`);
    }
    return [{ key: `${m.id}-h`, head: true, m, b: '' }, ...body.map((b, i) => ({ key: `${m.id}-${i}`, head: false, m, b }))];
  });
  const viewH = height - 1;
  const [offset, setOffset] = useState<number | null>(null);
  const max = Math.max(0, rows.length - viewH);
  const off = offset ?? max;
  const name = (id: string) => (id === 'user' ? 'tú' : hq?.agents.get(id)?.role.name ?? id);
  // ↑↓ move between messages (starting at the newest); Enter/Space expands, or opens the reply popup for yours.
  const ci = Math.min(nav.zone ? nav.index : msgs.length - 1, msgs.length - 1);
  const current = msgs[ci];
  const go = (n: number) => {
    const i = Math.max(0, Math.min(msgs.length - 1, n));
    setNav({ zone: 'list', index: i });
    const row = rows.findIndex((r) => r.head && r.m === msgs[i]);
    if (row < off) setOffset(row);
    else if (row >= off + viewH - 2) setOffset(Math.min(max, row - viewH + 3) >= max ? null : row - viewH + 3);
  };
  const activate = () => current && (current.to === 'user' ? openReply({ msg: current }) : toggle(current.id));
  useShortcuts(
    'messages',
    [
      { keys: ['up'], run: () => go(ci - 1) },
      { keys: ['down'], run: () => go(ci + 1) },
      { keys: ['pageup'], run: () => go(ci - 5) },
      { keys: ['pagedown'], run: () => go(ci + 5) },
      { keys: ['home'], run: () => go(0) },
      // Fin sticks to the bottom again.
      { keys: ['end'], run: () => (setNav({ zone: 'list', index: msgs.length - 1 }), setOffset(null)) },
      { keys: ['enter', 'space'], run: activate },
    ],
    { footer: 'messages' },
  );
  // Colour marks only messages that involve you; agent-to-agent traffic stays plain.
  const who = (id: string, mine: string) => (id === 'user' ? mine : TEXT);
  return (
    <Box flexDirection="column" height={height}>
      <Text wrap="truncate">
        <Text color={SENT}>{g.out} enviado</Text>
        <Text color={RECEIVED}>
          {' '}
          {g.in} recibido
        </Text>
        <Text color={DONE}>
          {' '}
          {g.tick} hecho
        </Text>
        <Text color={MUTED}>
          {' '}
          {g.sep} {msgs.length} mensajes {g.sep} clic para desplegar {g.sep} rueda para desplazar
        </Text>
      </Text>
      <Box flexDirection="row" height={viewH}>
      <Clickable
        onWheel={(d) => {
          const n = Math.max(0, Math.min(max, off + d));
          setOffset(n >= max ? null : n);
        }}
        flexDirection="column"
        flexGrow={1}
        height={viewH}
        overflow="hidden"
      >
        {!rows.length && <Text color={MUTED}>Todavía no hay mensajes.</Text>}
        {rows.slice(off, off + viewH).map((r) => (
          <Clickable key={r.key} onClick={() => (setNav({ zone: 'list', index: msgs.indexOf(r.m) }), cursor.hide(), r.m.to === 'user' ? openReply({ msg: r.m }) : toggle(r.m.id))}>
            {r.head ? (
              <Text wrap="truncate" inverse={cursor.visible && r.m === current}>
                {cursor.visible && r.m === current ? `${g.cursor} ` : ''}
                <Text color={MUTED}>{new Date(r.m.ts).toLocaleTimeString('es-ES', { hour12: false })} </Text>
                {msgColor(r.m) === DONE ? <Text color={DONE}>{g.tick} </Text> : null}
                <Text color={who(r.m.from, SENT)} bold>
                  {name(r.m.from)}
                </Text>
                <Text color={MUTED}> {g.out} </Text>
                <Text color={who(r.m.to, RECEIVED)} bold>
                  {name(r.m.to)}
                </Text>
                <Text color={MUTED}> [{MSG_TYPE_ES[r.m.type as keyof typeof MSG_TYPE_ES] ?? r.m.type}]</Text>
              </Text>
            ) : (
              <Text wrap="truncate" color={msgColor(r.m)}>
                {'    '}
                {r.b || ' '}
              </Text>
            )}
          </Clickable>
        ))}
      </Clickable>
      <Scrollbar
        total={rows.length}
        visible={viewH}
        offset={off}
        onScroll={(n) => {
          const v = Math.round(n);
          setOffset(v >= max ? null : v);
        }}
        height={viewH}
      />
      </Box>
    </Box>
  );
}
