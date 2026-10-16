import { Box, Text, useApp as useInkApp, useInput } from 'ink';
import stringWidth from 'string-width';
import path from 'node:path';
import React, { useEffect, useState } from 'react';
import type { HQ } from '../hq.ts';
import type { PermMode } from '../types.ts';
import { PROJECT_DIR } from '../paths.ts';
import { listRuns } from '../runs.ts';
import { type Alert, AppProvider, DRAFT_NOTE, type ReplyTarget, type Tab, alertsOf, isPermission, nAgents, toastSink, useApp, useCopy, useDraft, useSize, wrap } from './app-context.tsx';
import { g } from './glyphs.ts';
import { FooterHints, KeymapProvider, MODAL_GUARD_MS, Modal, Overlays, type ModalAction, type Mode, modalBodyLines, modalContentWidth, useHelp, useLeave, useShortcuts, useModal } from './keymap.tsx';
import { MouseLayer, MouseProvider, inSelectionMode, setSelectionMode } from './mouse.tsx';
import { Office } from './Office.tsx';
import { Roles } from './Roles.tsx';
import { Sessions } from './Sessions.tsx';
import { Teams } from './Teams.tsx';
import { EXIT_LABEL, Messages, Terminals } from './Terminals.tsx';
import { BORDER, DANGER, MUTED, PERM_COLOR, PERM_SHORT, PRIMARY, SUCCESS, TEXT, WARN, fgOn } from './theme.ts';
import { Button, ChromeTabs, Divider, OptionPicker, TAB_PAD, optionPickerRows, type TabSpec, TextArea, buttonWidth, layoutTabs, useFocusState } from './widgets.tsx';
import { confirmButton, confirmReady, consequenceOf, picks, replyPlan, replyText } from './pick.ts';
import { type TopbarUsage, type UsageLevel, USAGE_NOTE, agoMin, bar, crossings, metricViews, resetText, topbarUsage } from './usage-view.ts';
import { kTok, tokenMix } from './cost.ts';
import { loadRun } from '../runs.ts';
import { runTokenCost, runTokenUsage } from '../tokens.ts';
import { readUsage } from '../usage.ts';
import { Clickable } from './mouse.tsx';

const ORDER: Tab[] = ['teams', 'roles', 'office', 'terminals', 'messages', 'sessions'];
const MIN_COLS = 80;
const MIN_ROWS = 24;
const ANY_TEXT: Mode[] = ['nav', 'text'];

const USAGE_POLL_MS = 10_000;
const SPEND_POLL_MS = 30_000;
// One 90 % toast per metric and window for the whole process.
const crossed = new Set<string>();

/** Claude usage (per account, also without a session) and this session's tokens, polled. */
function useUsage(hq: HQ | null, toast: (s: string) => void) {
  const [usage, setUsage] = useState(readUsage);
  const [spend, setSpend] = useState<number | undefined>(undefined);
  useEffect(() => {
    const poll = () => {
      const u = readUsage();
      // Only a new snapshot or a new error re-renders the shell.
      setUsage((prev) => (prev.snapshot?.updatedAt === u.snapshot?.updatedAt && prev.error === u.error ? prev : u));
      for (const t of crossings(u.snapshot, Date.now(), crossed)) toast(t);
    };
    poll();
    const t = setInterval(poll, USAGE_POLL_MS);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!hq) return setSpend(undefined);
    const poll = () => {
      try {
        setSpend(runTokenUsage(loadRun(hq.store.dir)).total);
      } catch {
        setSpend(undefined);
      }
    };
    poll();
    const t = setInterval(poll, SPEND_POLL_MS);
    return () => clearInterval(t);
  }, [hq]);
  return { ...usage, spend, refresh: () => setUsage(readUsage()) };
}

function useLiveRuns() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const poll = () => setN(listRuns().filter((r) => r.live > 0).length);
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, []);
  return n;
}

// ---------------------------------------------------------------- topbar

/** Badge numbers never take more than 3 columns. */
export const cap = (n: number) => (n >= 100 ? '99+' : String(n));

/** Shortens text in the middle: "Orquestrador…tareas". */
export function middleTruncate(text: string, max: number) {
  if (stringWidth(text) <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}${g.ellipsis}${tail ? text.slice(-tail) : ''}`;
}

export type TopbarItem = { kind: 'alert' | 'detach' | 'sep' | 'stop' | 'quit' | 'perm' | 'dir' | 'nosession' | 'usage' | 'spend'; label: string; width: number };
export type TopbarInput = {
  dir: string;
  perm?: PermMode; // set while a session is open
  alerts: number;
  session: boolean;
  badges: { working: number; agents: number; unread: number; live: number };
  compact?: boolean; // one-row tabs (rows < 30)
  /** Claude usage label variants (see usage-view.ts); shown with or without a session. */
  usage?: Pick<TopbarUsage, 'full' | 'pcts' | 'top' | 'critical'>;
  /** Tokens spent by this session, e.g. "≈1,2M" (lowest priority: dropped first). */
  spend?: string;
};
export type TopbarLayout = { tabs: TabSpec<Tab>[]; header: TopbarItem[]; footer: TopbarItem[]; rightWidth: number; footerWidth: number };

const DIR_MAX = 20;

/**
 * Fits the top bar in `cols` by priority, with measured widths. Tabs always stay (layoutTabs
 * degrades them to short labels, then icons). Then, from most to least important: alerts,
 * Salir, Detener/Desconectar (short labels, then the footer), permission mode (full → ⚠ →
 * hidden when Auto) and the directory (middle-truncated to 20 columns, then dropped).
 * What leaves the header and must not be lost goes to the footer.
 */
export function topbarLayout(cols: number, o: TopbarInput): TopbarLayout {
  const b = o.badges;
  const tabs: TabSpec<Tab>[] = [
    { id: 'teams', label: `${g.teams} Equipos`, short: 'Equipos' },
    { id: 'roles', label: `${g.roles} Roles`, short: 'Roles' },
    {
      id: 'office',
      label: `${g.office} Oficina`,
      short: 'Oficina',
      badge: o.session
        ? o.compact
          ? `${o.alerts ? `${g.warning}${cap(o.alerts)} ` : ''}${cap(b.working)}/${cap(b.agents)}`
          : `${o.alerts ? `${g.warning} ${cap(o.alerts)} ${g.sep} ` : ''}${cap(b.working)}/${cap(b.agents)}`
        : undefined,
      badgeColor: o.alerts ? WARN : b.working ? WARN : SUCCESS,
    },
    { id: 'terminals', label: `${g.terminals} Terminales`, short: 'Terminal', badge: o.session ? cap(b.agents) : undefined, badgeColor: MUTED },
    { id: 'messages', label: `${g.mail} Mensajes`, short: 'Mensajes', badge: b.unread ? cap(b.unread) : undefined, badgeColor: PRIMARY },
    { id: 'sessions', label: `${g.sessions} Sesiones`, short: 'Sesiones', badge: b.live ? (cols >= 100 ? `${cap(b.live)} activas` : cap(b.live)) : undefined, badgeColor: SUCCESS },
  ];
  const pad = o.compact ? TAB_PAD.row : TAB_PAD.bordered;
  const tabsAlone = layoutTabs(tabs, cols, 0, pad);
  // Right of the tabs only exists while they keep their full labels (see layoutTabs).
  const room = tabsAlone.mode === 'full' ? cols - 1 - tabsAlone.tabs.reduce((a, t) => a + t.width, 0) : 0;

  const btn = (kind: TopbarItem['kind'], label: string, variant?: 'secondary' | 'danger') => ({ kind, label, width: buttonWidth(label, 'sm', false, variant) });
  const text = (kind: TopbarItem['kind'], label: string) => ({ kind, label, width: stringWidth(label) });
  type Level = { dir: number; perm: number; usage: number; spend: boolean; shortActions: boolean; actionsDown: boolean; quitDown: boolean; alertDown: boolean };
  const items = (level: Level) => {
    const head: TopbarItem[] = [];
    const foot: TopbarItem[] = [];
    // Usage: full → percentages → highest only → footer (a ≥90 % one never disappears there).
    const usage = () => {
      if (!o.usage) return;
      const label = [o.usage.full, o.usage.pcts, o.usage.top][level.usage];
      if (label !== undefined) head.push(text('usage', `${label} `));
      else foot.push(text('usage', `${o.usage.top} `));
      if (level.spend && o.spend && label !== undefined) head.push(text('spend', `${o.spend} `));
    };
    if (o.session) {
      if (level.dir === 0) head.push(text('dir', `${g.on} ${middleTruncate(o.dir, DIR_MAX)} `));
      const perm = o.perm ?? 'auto';
      if (level.perm === 0) head.push(text('perm', `${perm === 'auto' ? '' : `${g.warning} `}${PERM_SHORT[perm]} `));
      // Intermediate level: short text, never a bare glyph (it must not depend on colour).
      else if (level.perm === 1 && perm !== 'auto') head.push(text('perm', `${perm === 'yolo' ? 'YOLO' : 'A+Y'} `));
      // A risky mode never disappears: when the header has no room it goes to the footer.
      else if (perm !== 'auto') foot.push(text('perm', `${g.warning}${PERM_SHORT[perm]} `));
      if (o.alerts) (level.alertDown ? foot : head).push(btn('alert', `${g.warning} ${cap(o.alerts)}`));
      const acts = [
        btn('detach', level.shortActions ? `${g.detach} Desc.` : `${g.detach} Desconectar`, 'secondary'),
        text('sep', `${g.vLine} `),
        btn('stop', level.shortActions ? `${g.stop} Det.` : `${g.stop} Detener`, 'danger'),
      ];
      (level.actionsDown ? foot : head).push(...acts);
    } else if (level.dir === 0) head.push(text('nosession', `${middleTruncate(o.dir, DIR_MAX)} ${g.sep} sin sesión `));
    usage();
    (level.quitDown ? foot : head).push(btn('quit', 'Salir', 'secondary'));
    return { head, foot };
  };
  // Least important first: each step drops or shortens one more thing.
  // Usage ranks below the alerts and above the directory and the Auto permission label.
  const base = { usage: 0, spend: false, shortActions: false, actionsDown: false, quitDown: false, alertDown: false };
  const steps: Level[] = [
    { ...base, dir: 0, perm: 0, spend: true },
    { ...base, dir: 0, perm: 0 },
    { ...base, dir: 1, perm: 0 },
    { ...base, dir: 1, perm: 1 },
    { ...base, dir: 1, perm: 1, usage: 1 },
    // Short action labels before the usage drops to its narrowest form.
    { ...base, dir: 1, perm: 1, usage: 1, shortActions: true },
    { ...base, dir: 1, perm: 1, usage: 2, shortActions: true },
    { ...base, dir: 1, perm: 1, usage: 3, shortActions: true },
    { ...base, dir: 1, perm: 1, usage: 3, shortActions: true, actionsDown: true },
    { ...base, dir: 1, perm: 2, usage: 3, shortActions: true, actionsDown: true },
    { ...base, dir: 1, perm: 2, usage: 3, shortActions: true, actionsDown: true, quitDown: true },
    { ...base, dir: 1, perm: 2, usage: 3, shortActions: true, actionsDown: true, quitDown: true, alertDown: true },
  ];
  const sum = (xs: TopbarItem[]) => xs.reduce((a, x) => a + x.width, 0);
  for (const level of steps) {
    const { head, foot } = items(level);
    if (!head.length || sum(head) <= room) return { tabs, header: head, footer: foot, rightWidth: sum(head), footerWidth: sum(foot) };
  }
  const { foot } = items(steps.at(-1)!);
  return { tabs, header: [], footer: foot, rightWidth: 0, footerWidth: sum(foot) };
}

function Shell() {
  const { tab, setTab, hq, roles, stopRun, detachRun, toast, toastError, setToast, unreadMsgs, reply, openReply, toggleMotion, reduced, form, showAgent, setForm } = useApp();
  const modal = useModal();
  const help = useHelp();
  const { focused, setFocused } = useFocusState();
  const { exit } = useInkApp();
  const { cols, rows } = useSize();
  const leave = useLeave();
  const liveRuns = useLiveRuns();
  const alerts = alertsOf(hq);
  const permAlerts = alerts.filter(isPermission).length;

  const quit = (keepAgents: boolean) => {
    if (keepAgents) hq?.detach();
    else hq?.stop();
    exit();
  };
  const askQuit = () =>
    leave(() =>
      hq
        ? modal.open({
            title: `Hay ${nAgents(hq.agents.size)} en esta sesión.`,
            lines: [`El historial se guarda en ${hq.store.dir}`, 'Para volver: orq --resume (o pestaña Sesiones)'],
            actions: [
              { label: '[S]alir dejándolos trabajando', variant: 'primary', run: () => quit(true) },
              { label: '[D]etener y salir', variant: 'danger', run: () => quit(false) },
            ],
          })
        : quit(false),
    );
  const askStop = () =>
    modal.open({
      title: `¿Detener la sesión? Se cerrarán sus ${nAgents(hq?.agents.size ?? 0)}.`,
      lines: ['El historial se guarda; podrás reanudarla desde Sesiones.'],
      actions: [{ label: '[D]etener', variant: 'danger', run: stopRun }],
    });
  // Leaving a form with unsaved changes asks first (keymap leave guard).
  const goTab = (t: Tab) => t !== tab && leave(() => (setFocused(null), setForm('none'), setTab(t)));
  // Alt+A / Alt+R open the oldest pending alert, never act on it: decisions come
  // preselected (accept / reject) and still need ↵. A blocked agent opens its terminal.
  const answerOldest = (accept: boolean) => {
    const a = alerts[0];
    if (!hq || !a) return;
    if (a.kind === 'blocked' && accept) return setFocused(null), showAgent(a.from, 'claude');
    openAlert(a, accept);
  };

  const openAlert = (a: Alert, accept?: boolean) => {
    if (accept !== undefined && (a.kind === 'hire' || a.kind === 'trust' || a.kind === 'bypass')) picks.set(a.id, accept ? 'accept' : 'reject');
    openReply({ alert: a });
  };
  const usage = useUsage(hq, setToast);
  const [usageOpen, setUsageOpen] = useState(false);

  // Selection mode (Alt+S): mouse reporting off so the terminal selects text natively; Esc ends it.
  // The mode lives in mouse.tsx so a remount or the external editor never turns the mouse back on.
  const [selecting, setSelecting] = useState(inSelectionMode);
  const setSelection = (on: boolean) => (setSelectionMode(on), setSelecting(on));
  useShortcuts('selection', [{ keys: ['esc'], run: () => setSelection(false), modes: ANY_TEXT }], { active: selecting });

  // Error toasts stay until the next key (clicks are handled in app-context).
  useInput(() => void (toastError && toast && setToast('')));
  // Single-key shortcuts are off while an edit form is open; their Alt/Ctrl forms still work.
  const single = form === 'none';
  useShortcuts('global', [
    ...ORDER.map((t, i) => ({ keys: [String(i + 1)], run: () => goTab(t), when: single })),
    ...ORDER.map((t, i) => ({ keys: [`alt+${i + 1}`], run: () => goTab(t), modes: ANY_TEXT })),
    { keys: ['q'], run: askQuit, when: single },
    { keys: ['ctrl+q', 'ctrl+c'], run: askQuit, modes: ANY_TEXT },
    { keys: ['m'], run: toggleMotion, when: single },
    { keys: ['!'], run: () => alerts[0] && openReply({ alert: alerts[0] }), when: alerts.length > 0 },
    { keys: ['alt+a'], run: () => answerOldest(true), modes: ANY_TEXT },
    { keys: ['alt+r'], run: () => answerOldest(false), modes: ANY_TEXT },
    { keys: ['alt+s'], run: () => setSelection(!selecting), modes: ANY_TEXT },
    { keys: ['u'], run: () => setUsageOpen(true), when: single },
  ]);

  if (cols < MIN_COLS || rows < MIN_ROWS)
    return (
      <Box width={cols} height={rows} alignItems="center" justifyContent="center">
        <Text color={WARN} bold wrap="truncate">
          Amplía la ventana a ≥{MIN_COLS}×{MIN_ROWS} ({cols}×{rows})
        </Text>
      </Box>
    );

  const agents = hq ? [...hq.agents.values()] : [];
  const compactTabs = rows < 30;
  const short = cols < 120;
  const top = topbarLayout(cols, {
    usage: topbarUsage(usage.snapshot, Date.now()),
    spend: usage.spend ? `≈${kTok(usage.spend)}` : undefined,
    dir: path.basename(hq?.cwd ?? PROJECT_DIR),
    perm: hq?.permMode,
    alerts: alerts.length,
    session: !!hq,
    badges: { working: agents.filter((a) => a.status === 'working').length, agents: agents.length, unread: unreadMsgs, live: liveRuns },
    compact: compactTabs,
  });
  const render = (it: TopbarItem) => {
    switch (it.kind) {
      case 'alert':
        // The alert counter opens the oldest pending alert.
        return <Button key="alert" label={it.label} color={WARN} solid onClick={() => openReply({ alert: alerts[0]! })} />;
      case 'detach':
        return <Button key="detach" variant="secondary" label={it.label} onClick={detachRun} />;
      case 'sep':
        // Neutral (detach) and dangerous (stop) actions are kept visibly apart.
        return (
          <Text key="sep" color={BORDER}>
            {it.label}
          </Text>
        );
      case 'stop':
        return <Button key="stop" variant="danger" label={it.label} onClick={askStop} />;
      case 'quit':
        return <Button key="quit" variant="secondary" label={it.label} onClick={askQuit} />;
      case 'perm':
        return (
          <Text key="perm" color={PERM_COLOR[hq?.permMode ?? 'auto']}>
            {it.label}
          </Text>
        );
      case 'dir':
        return (
          <Text key="dir" color={SUCCESS}>
            {it.label}
          </Text>
        );
      case 'nosession':
        return (
          <Text key="dir" color={MUTED}>
            {it.label}
          </Text>
        );
      case 'usage': {
        const u = topbarUsage(usage.snapshot, Date.now());
        return (
          <Clickable key="usage" onClick={() => setUsageOpen(true)} flexShrink={0} aria-role="button" aria-label={`${u.aria}. Abrir el detalle (u)`}>
            <Text color={USAGE_COLOR[u.level]}>{it.label}</Text>
          </Clickable>
        );
      }
      case 'spend':
        return (
          <Text key="spend" color={MUTED}>
            {it.label}
          </Text>
        );
    }
  };
  const right = top.header.length ? <Box flexDirection="row">{top.header.map(render)}</Box> : undefined;
  // While typing on a narrow screen the footer keeps its room for the text-mode keys
  // (alerts and a risky permission mode stay).
  const critical = topbarUsage(usage.snapshot, Date.now()).critical;
  const footItems = focused && short ? top.footer.filter((it) => it.kind === 'alert' || it.kind === 'perm' || (it.kind === 'usage' && critical)) : top.footer;
  const footItemsW = footItems.reduce((a, it) => a + it.width, 0);

  const bodyH = rows - (compactTabs ? 1 : 3) - 1 - (selecting ? 1 : 0);
  // The motion state shows in the footer when there is room, or always when it is off.
  const motionW = !short || reduced ? 21 : 0;
  const footerW = cols - motionW - footItemsW;
  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <ChromeTabs tabs={top.tabs} active={tab} onSelect={goTab} width={cols} compact={compactTabs} right={right} rightWidth={top.rightWidth} />
      {selecting && (
        <Box height={1} flexShrink={0}>
          <Text color={fgOn(WARN)} backgroundColor={WARN} bold wrap="truncate">
            {` Modo selección ${g.sep} arrastra para seleccionar y copia con ⌘C ${g.sep} Esc para volver `.padEnd(cols)}
          </Text>
        </Box>
      )}
      <Box height={bodyH} flexDirection="column" flexShrink={0}>
        {tab === 'teams' && <Teams height={bodyH} />}
        {tab === 'roles' && <Roles height={bodyH} />}
        {tab === 'office' && <Office height={bodyH} />}
        {tab === 'terminals' && <Terminals height={bodyH} />}
        {tab === 'messages' && <Messages height={bodyH} />}
        {tab === 'sessions' && <Sessions height={bodyH} />}
      </Box>
      <Box flexDirection="row" flexShrink={0} height={1} overflow="hidden">
        {toast && toastError ? (
          <Box width={footerW} flexShrink={0}>
            <Text color={fgOn(DANGER)} backgroundColor={DANGER} wrap="truncate">
              {` ${g.warning} ${toast} ${g.sep} pulsa una tecla o haz clic para cerrar `}
            </Text>
          </Box>
        ) : (
          <FooterHints width={footerW} permissions={focused ? permAlerts : 0} toast={toast || undefined} context={selecting ? 'selection' : undefined} />
        )}
        {motionW > 0 && (
          <Box width={motionW} flexShrink={0}>
            <Text color={MUTED} wrap="truncate">
              {` ${g.sep} m animación: ${reduced ? 'no' : 'sí'} `}
            </Text>
          </Box>
        )}
        {footItems.length > 0 && (
          <Box flexDirection="row" flexShrink={0}>
            {footItems.map(render)}
          </Box>
        )}
      </Box>
      {reply && (
        <MouseLayer>
          <ReplyPopup target={reply} width={cols} height={rows} />
        </MouseLayer>
      )}
      {usageOpen && (
        <MouseLayer>
          <UsageModal usage={usage} width={cols} height={rows} onClose={() => setUsageOpen(false)} />
        </MouseLayer>
      )}
      <MouseLayer active={modal.isOpen || help.open}>
        <Overlays width={cols} height={rows} tab={tab} />
      </MouseLayer>
    </Box>
  );
}

// ------------------------------------------------------------ reply popup

const KIND_TITLE: Record<string, string> = {
  question: 'Pregunta',
  report: 'Informe',
  info: 'Informe',
  message: 'Mensaje',
  task: 'Tarea',
  answer: 'Respuesta',
  system: 'Sistema',
  hire: 'Contratar',
  trust: 'Permiso',
  bypass: 'Permiso',
  blocked: 'Bloqueado',
};
const OPTION_LINES = 3;
const PREVIEW_LINES = 3;
/**
 * Popup to read a message or alert in full and answer it, «elegir y confirmar»: clicks,
 * 1-9, ↑↓ and Space only select (no preselection); the exact text that will be sent is
 * previewed and goes only with «▶ Enviar respuesta (↵)». Decisions (hire, trust, bypass)
 * are a two-option pick with their consequence and an explicit confirmation. Esc closes
 * keeping the selection (per message) and the comment draft.
 */
export function ReplyPopup({ target, width, height }: { target: ReplyTarget; width: number; height: number }) {
  const { hq, roles, closeReply, setToast, showAgent } = useApp();
  const { focused, setFocused } = useFocusState();
  const alert: Alert | undefined = target.alert;
  const msgId = alert?.msgId ?? (alert?.kind === 'question' || alert?.kind === 'info' ? alert.id : undefined);
  const msg = target.msg ?? (msgId ? hq?.messages.find((m) => m.id === msgId) : undefined);
  const key = msg?.id ?? alert?.id ?? 'none';
  // The comment being written survives closing the popup (draft per message or alert).
  const draft = useDraft(`reply:${key}`);
  const text = draft.value;
  const setText = draft.set;
  const kind = alert?.kind ?? msg?.type ?? 'message';
  const from = alert?.from ?? msg?.from ?? '';
  const name = hq?.agents.get(from)?.role.name ?? from;
  const ts = msg?.ts ?? Date.now();
  const body = (alert?.kind === 'hire' ? `Quiere contratar a ${alert.role}. ${alert.text}` : (msg?.body ?? alert?.text ?? '')).trim();
  const answered = msg ? hq?.answerOf(msg.id) : undefined;
  const canReply = !!msg && !!hq?.agents.has(from) && kind !== 'blocked' && kind !== 'hire' && kind !== 'trust' && kind !== 'bypass';
  const plan = replyPlan(kind, { options: msg?.options, role: alert?.kind === 'hire' ? alert.role : undefined, canReply });
  const [picked, setPicked] = useState<string | undefined>(() => picks.get(key));
  const [cur, setCur] = useState(0);
  const lastPick = React.useRef(0);
  const option = plan.options.find((o) => o.value === picked);
  const pick = (v: string, byKey = false) => {
    setPicked(v);
    picks.set(key, v);
    if (byKey) lastPick.current = Date.now();
  };
  const preview = plan.kind === 'decision' ? '' : replyText(option?.label, text);
  const confirm = confirmButton(plan.kind, option, text);

  const close = () => (setFocused(null), closeReply());
  const resolveNotice = () => {
    if (alert && hq?.notices.some((n) => n.id === alert.id)) hq.answerNotice(alert.id, false, roles);
  };
  const markRead = () => (resolveNotice(), close());
  const send = () => {
    if (confirm.disabled || !confirmReady(lastPick.current, Date.now(), MODAL_GUARD_MS)) return;
    if (plan.kind === 'decision') {
      hq?.answerNotice(alert!.id, picked === 'accept', roles);
      picks.delete(key);
      setToast(picked === 'accept' ? 'Aceptado' : 'Rechazado');
      return close();
    }
    if (!hq || !msg || !preview) return;
    hq.reply(msg.id, preview);
    setText('');
    picks.delete(key);
    resolveNotice();
    setToast(`Respuesta enviada a ${name}: «${preview.length > 40 ? `${preview.slice(0, 39)}…` : preview}»`);
    close();
  };

  const copy = useCopy();
  useShortcuts('reply/draft', [{ keys: ['alt+d'], run: () => setText(''), modes: ['text'] }], { active: focused === 'reply' });
  // Keys of the picker; the modal keeps Esc, ←→/Tab and ↵ (which presses the focused button).
  const onKeys = (names: string[]) => {
    const has = (n: string) => names.includes(n);
    const n = Number(names.find((x) => /^[1-9]$/.test(x)));
    if (n >= 1 && n <= plan.options.length) return (setCur(n - 1), pick(plan.options[n - 1]!.value, true), true);
    if (plan.options.length && has('space')) return (pick(plan.options[cur]!.value, true), true);
    if (plan.kind === 'decision' && (has('a') || has('r'))) return (pick(has('a') ? 'accept' : 'reject', true), true);
    if (has('y')) return (copy(body), true);
    if (has('i') && canReply) return (setFocused('reply'), true);
    return false;
  };
  const onUpDown = plan.options.length ? (d: -1 | 1) => setCur((cur + d + plan.options.length) % plan.options.length) : undefined;

  const actions: ModalAction[] =
    kind === 'blocked'
      ? [
          { label: '[A]brir terminal', run: () => (close(), showAgent(from, 'claude')), variant: 'primary' },
          { label: 'Cerrar (Esc)', run: close, variant: 'secondary' },
        ]
      : plan.kind === 'none'
        ? [
            { label: `${g.copy} Copiar (y)`, run: () => copy(body), variant: 'secondary' },
            { label: 'Cerrar (Esc)', run: close, variant: 'secondary' },
          ]
        : [
            { label: confirm.label, run: send, variant: confirm.variant, disabled: confirm.disabled },
            ...(plan.kind === 'report' ? [{ label: `${g.tick} Marcar como leído`, run: markRead, variant: 'secondary' as const }] : []),
            { label: `${g.copy} Copiar (y)`, run: () => copy(body), variant: 'secondary' as const },
            { label: 'Cancelar (Esc)', run: close, variant: 'secondary' as const },
          ];

  const maxW = Math.min(width - 4, 76);
  const contentW = modalContentWidth(width, maxW);
  // Long answers, options and the preview wrap (capped) instead of being cut to one row.
  const answeredLines = answered ? wrap(`${g.tick} respondida: ${answered.body.replace(/\s+/g, ' ')}`, contentW, 2) : [];
  const pickRows = plan.options.length ? 1 + optionPickerRows(plan.options, contentW, OPTION_LINES) : 0;
  const previewLines = preview ? wrap(`«${preview.replace(/\s+/g, ' ')}»`, contentW, PREVIEW_LINES) : ['Elige una opción o escribe una respuesta'];
  const contentRows = answeredLines.length + pickRows + (plan.consequence ? 1 : 0) + (canReply ? 4 + 1 + previewLines.length : 0);
  const lines = body.split('\n');
  const time = new Date(ts).toLocaleTimeString('es-ES', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return (
    <Modal
      title={`${KIND_TITLE[kind] ?? 'Mensaje'} ${g.sep} ${name} ${g.sep} ${time}`}
      width={width}
      height={height}
      maxWidth={maxW}
      lines={lines}
      bodyRows={Math.max(2, Math.min(modalBodyLines(lines, width, maxW), height - 10 - contentRows))}
      fields={canReply ? ['reply'] : []}
      initialFocus={plan.kind === 'none' || kind === 'blocked' ? undefined : 0}
      contentRows={contentRows}
      onClose={close}
      onKeys={onKeys}
      onUpDown={onUpDown}
      footer={plan.options.length ? 'reply.pick' : 'confirm'}
      actions={actions}
      color={plan.kind === 'decision' ? WARN : PRIMARY}
    >
      {({ cursor }) => (
        <Box flexDirection="column">
          {answeredLines.map((l, i) => (
            <Text key={i} color={SUCCESS} wrap="truncate">
              {l}
            </Text>
          ))}
          {plan.options.length > 0 && <Divider title={`Elige una respuesta (↑↓ o 1-${plan.options.length})`} width={contentW} />}
          {plan.options.length > 0 && <OptionPicker options={plan.options} value={picked} onChange={(v) => pick(v)} cursor={cur} width={contentW} maxLines={OPTION_LINES} />}
          {plan.consequence && (
            <Text color={WARN} wrap="truncate">
              {consequenceOf(plan, picked)}
            </Text>
          )}
          {canReply && (
            <TextArea
              id="reply"
              value={text}
              onChange={setText}
              onSubmit={send}
              width={contentW}
              rows={2}
              cursor={cursor === 'reply'}
              note={draft.recovered ? DRAFT_NOTE : undefined}
              placeholder={`Comentario (opcional) ${g.sep} i para escribir`}
            />
          )}
          {canReply && <Divider title={`Se enviará a ${name}`} width={contentW} />}
          {canReply &&
            previewLines.map((l, i) => (
              <Text key={i} color={preview ? TEXT : MUTED} wrap="truncate">
                {l}
              </Text>
            ))}
        </Box>
      )}
    </Modal>
  );
}

export function App({ initialTab, resumeDir, initialHq }: { initialTab?: Tab; resumeDir?: string; initialHq?: HQ | null }) {
  return (
    <KeymapProvider onToast={(s) => toastSink(s)} exitLabel={EXIT_LABEL}>
      <MouseProvider>
        <AppProvider initialTab={initialTab} resumeDir={resumeDir} initialHq={initialHq}>
          <Shell />
        </AppProvider>
      </MouseProvider>
    </KeymapProvider>
  );
}

const USAGE_COLOR: Record<UsageLevel, string> = { none: MUTED, ok: TEXT, warn: WARN, danger: DANGER };
const MAX_SPEND_ROWS = 8;

/** «Uso de Claude»: each window with a 10-segment bar and its reset, freshness, and this session's tokens per agent. */
export function UsageModal({ usage, width, height, onClose }: { usage: ReturnType<typeof useUsage>; width: number; height: number; onClose: () => void }) {
  const { hq } = useApp();
  // Time left until each reset is recomputed every minute while the modal is open.
  const [, setMinute] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setMinute((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const now = Date.now();
  const views = metricViews(usage.snapshot, now);
  const [per, cost] = React.useMemo(() => {
    if (!hq) return [null, null] as const;
    try {
      const meta = loadRun(hq.store.dir);
      return [runTokenUsage(meta), runTokenCost(meta)] as const;
    } catch {
      return [null, null] as const;
    }
  }, [hq]);
  const mix = cost ? tokenMix(cost.byType) : '';
  const names = (id: string) => hq?.agents.get(id)?.role.name ?? id;
  const rows = per ? Object.entries(per.perAgent).sort((a, b) => b[1] - a[1]) : [];
  const top = rows[0]?.[1] ?? 0;
  const lines: React.ReactNode[] = views.map((v) => (
    <Text key={v.key} wrap="truncate" aria-label={v.aria}>
      {v.long.padEnd(16)}
      {v.pct === undefined ? (
        <Text color={MUTED}>—   sin datos todavía</Text>
      ) : (
        <>
          <Text color={USAGE_COLOR[v.level]}>
            {bar(v.pct, 10)} {String(v.pct).padStart(3)}%{v.level === 'danger' ? '!' : ''}
          </Text>
          <Text color={MUTED}>{v.resetsAt ? `  se reinicia ${resetText(v.resetsAt, now)}` : ''}</Text>
        </>
      )}
    </Text>
  ));
  const foot = usage.error
    ? 'No pude leer el uso de Claude.'
    : !usage.snapshot
      ? 'Aparecerán tras la primera respuesta de Claude.'
      : views.every((v) => v.pct === undefined)
        ? 'Sin datos recientes: se actualizarán cuando un agente responda.'
        : `Actualizado hace ${agoMin(usage.snapshot.updatedAt, now)} min`;
  const spendRows = rows.slice(0, MAX_SPEND_ROWS);
  const contentRows = views.length + 1 + 1 + 1 + (hq ? Math.max(1, spendRows.length) + (rows.length > MAX_SPEND_ROWS ? 1 : 0) + (mix ? 1 : 0) : 1);
  const contentW = modalContentWidth(width, 64);
  return (
    <Modal
      title="Uso de Claude"
      width={width}
      height={height}
      maxWidth={64}
      contentRows={contentRows}
      onClose={onClose}
      color={PRIMARY}
      actions={[...(usage.error ? [{ label: `${g.sessions} Reintentar`, run: usage.refresh, variant: 'secondary' as const }] : []), { label: 'Cerrar (Esc)', run: onClose, variant: 'secondary' as const }]}
    >
      <Box flexDirection="column">
        {lines}
        <Text color={MUTED} wrap="truncate">
          {foot}
        </Text>
        <Text color={MUTED} wrap="truncate">
          {USAGE_NOTE}
        </Text>
        <Divider title={per ? `Esta sesión ≈ ${kTok(per.total)} tokens` : 'Esta sesión'} width={contentW} />
        {!hq && <Text color={MUTED}>Abre una sesión para ver su gasto.</Text>}
        {hq && !spendRows.length && <Text color={MUTED}>Sin consumo registrado todavía.</Text>}
        {spendRows.map(([id, n]) => (
          <Text key={id} wrap="truncate">
            {names(id).slice(0, 14).padEnd(15)}
            {kTok(n).padStart(6)} <Text color={MUTED}>{bar(top ? (n / top) * 100 : 0, 10)}</Text>
          </Text>
        ))}
        {rows.length > MAX_SPEND_ROWS && <Text color={MUTED}>+{rows.length - MAX_SPEND_ROWS} más</Text>}
        {mix && (
          <Text color={MUTED} wrap="truncate">
            {mix}
          </Text>
        )}
      </Box>
    </Modal>
  );
}
