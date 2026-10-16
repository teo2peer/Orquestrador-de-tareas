import { Box, Text } from 'ink';
import React, { useMemo, useState } from 'react';
import { resolvePaths, validateAreas } from '../areas.ts';
import {
  type PlanArea,
  addArea,
  addPath,
  clampSel,
  cycleBase,
  cycleLead,
  launchGate,
  refreshArea,
  resolveLead,
  mergeAreas,
  pathKind,
  planIssues,
  removeArea,
  removePath,
  renameArea,
  toggleIncluded,
  toggleWrites,
} from './area-plan.ts';
import { type AreaDraft, type Draft, restoreDraft } from './AutoTeam.tsx';
import { VSep, gridLayout, useApp, useSize, wrap } from './app-context.tsx';
import { g } from './glyphs.ts';
import { cycleZone, moveIndex, useKeyboardCursor, useModal, useShortcuts } from './keymap.tsx';
import { Clickable } from './mouse.tsx';
import { toHex } from './sprites.ts';
import { DANGER, INFO, MUTED, SUCCESS, TEXT, WARN } from './theme.ts';
import { BackButton, Button, Divider, ScrollArea, TextField, Toggle, backButtonWidth, buttonWidth, useFocusState, useScroll } from './widgets.tsx';

const FIELDS = ['area-name', 'area-path-add'];

/** Header labels of the review that fit in `room` columns: long ones on wide screens, short ones at 80. */
export function reviewHeader(room: number, undo: boolean) {
  const long = { back: 'Volver a la vista previa', restore: `${g.sessions} Restaurar propuesta`, add: `${g.add} Añadir área`, undo: 'Deshacer (u)' };
  const short = { back: 'Volver', restore: `${g.sessions} Restaurar`, add: `${g.add} Área`, undo: 'Deshacer' };
  const width = (h: typeof long) =>
    backButtonWidth(h.back) + buttonWidth('Listo', 'sm', false, 'primary') + buttonWidth(h.restore, 'sm', false, 'tertiary') + buttonWidth(h.add, 'sm', false, 'secondary') + (undo ? buttonWidth(h.undo, 'sm', false, 'tertiary') : 0);
  const pick = width(long) <= room ? long : short;
  return { ...pick, width: width(pick) };
}
const AREA_H = 2; // rows per area in the list
const MERGE_MAX = 3;
// Same order as the core gives area agents (areaRole colours by index).
const AREA_COLORS = ['green', 'blue', 'magenta', 'cyan', 'orange', 'teal', 'purple', 'pink', 'yellow', 'red'];

/**
 * «Revisar…» of «Auto por partes del código»: the area list (include, writer/reader,
 * lead) beside the detail of the selected area (name, base role, owned paths, reason).
 * Without a side panel the list takes the screen and ↵ opens the detail.
 */
export function AreaReview({
  draft,
  setDraft,
  cwd,
  width,
  height,
  initial,
  onDone,
}: {
  draft: AreaDraft;
  setDraft: (d: Draft) => void;
  cwd: string;
  width: number;
  height: number;
  initial: number;
  onDone: () => void;
}) {
  const { roles, setToast } = useApp();
  const modal = useModal();
  const cursor = useKeyboardCursor();
  const { focused, setFocused } = useFocusState();
  const { cols, rows: termRows } = useSize();
  const { side } = gridLayout(cols, termRows);
  const { areas } = draft;
  const [sel, setSel] = useState(Math.min(initial, areas.length - 1)); // -1 = lead row
  const si = Math.min(sel, areas.length - 1);
  const current = si >= 0 ? areas[si] : undefined;
  const [zone, setZone] = useState<'list' | 'detail'>('list');
  const [pc, setPc] = useState(0); // path under the cursor in the detail
  const [newPath, setNewPath] = useState('');
  const [pathErr, setPathErr] = useState('');

  const set = (next: PlanArea[], undoable = false) => setDraft({ ...draft, areas: next, history: undoable ? [...draft.history, areas] : draft.history });
  const undo = () => {
    const prev = draft.history.at(-1);
    if (!prev) return setToast('Nada que deshacer');
    setDraft({ ...draft, areas: prev, history: draft.history.slice(0, -1) });
    setToast('Deshecho');
  };
  const leadRole = resolveLead(roles, draft.lead);
  const issues = useMemo(() => {
    try {
      return planIssues(areas, validateAreas(areas.filter((a) => !a.off), cwd, draft.files));
    } catch (e) {
      return [{ level: 'error' as const, text: `No pude validar las rutas: ${(e as Error).message}`, agents: [] }];
    }
  }, [areas, cwd, draft.files]);
  const gate = launchGate(issues);
  const conflicted = new Set(gate.errors.flatMap((i) => i.agents));

  const listW = side ? Math.max(40, Math.floor(width * 0.45)) : width;
  const detailW = side ? width - listW - 1 : width;
  const showList = side || zone === 'list';
  const showDetail = side || zone === 'detail';
  const bodyH = height - 1;
  const issuesH = Math.max(1, Math.min(issues.length, Math.floor(bodyH / 5)));
  const listH = Math.max(AREA_H + 1, bodyH - 1 - issuesH);
  const scroll = useScroll(areas.length * AREA_H, listH - 1);

  // `length`: the list size after an edit made in the same handler (the closure still sees the old one).
  const select = (i: number, length = areas.length) => {
    const n = clampSel(i, length);
    setSel(n);
    setPc(0);
    setPathErr('');
    if (n >= 0) {
      scroll.ensureVisible(n * AREA_H);
      scroll.ensureVisible(n * AREA_H + AREA_H - 1);
    }
  };
  const moveSel = (k: string) => select(moveIndex(si + 1, areas.length + 1, 1, k, Math.max(1, Math.floor(listH / AREA_H))) - 1);
  const add = () => {
    const next = addArea(areas);
    set(next);
    select(next.length - 1, next.length);
    setZone('detail');
    setFocused('area-name');
  };
  const remove = (i: number) => {
    const a = areas[i];
    if (!a) return;
    const next = removeArea(areas, i);
    set(next, true);
    select(Math.min(i, next.length - 1), next.length);
    setToast(`Área «${a.name}» quitada ${g.sep} u deshacer`);
  };
  const askMerge = (i: number) => {
    const a = areas[i];
    if (!a) return;
    // The nearest areas in the list (the modal has room for MERGE_MAX buttons).
    const targets = areas
      .map((b, j) => ({ b, j }))
      .filter(({ j }) => j !== i)
      .sort((x, y) => Math.abs(x.j - i) - Math.abs(y.j - i) || x.j - y.j)
      .slice(0, MERGE_MAX)
      .sort((x, y) => x.j - y.j);
    if (!targets.length) return setToast('No hay otra área con la que fusionar');
    modal.open({
      title: `¿Fusionar «${a.name}» con…?`,
      lines: [
        'El área resultante conserva el nombre y el rol base del destino; puedes renombrarla después.',
        ...(areas.length - 1 > MERGE_MAX ? [`Se muestran las ${MERGE_MAX} áreas más cercanas en la lista.`] : []),
      ],
      actions: targets.map(({ b, j }, k) => ({
        label: `[${k + 1}] ${b.name.length > 14 ? `${b.name.slice(0, 13)}…` : b.name}`,
        variant: 'primary' as const,
        run: () => {
          const into = j > i ? j - 1 : j;
          const next = refreshArea(mergeAreas(areas, i, j), into, cwd, draft.files);
          set(next, true);
          select(into, next.length);
          setToast(`«${a.name}» fusionada con «${b.name}» ${g.sep} u deshacer`);
        },
      })),
    });
  };
  const submitPath = (v: string) => {
    if (!current) return;
    const r = addPath(areas, si, v, cwd);
    setPathErr(r.error ?? '');
    if (r.error) return;
    set(refreshArea(r.areas, si, cwd, draft.files));
    setNewPath('');
  };
  const editing = !!focused && FIELDS.includes(focused);

  useShortcuts(
    'teams/parts',
    [
      ...['up', 'down', 'pageup', 'pagedown', 'home', 'end'].map((k) => ({ keys: [k], run: () => moveSel(k) })),
      { keys: ['tab', 'enter'], run: () => (current ? setZone('detail') : setToast('El coordinador no tiene rutas propias')) },
      { keys: ['space'], run: () => current && set(toggleIncluded(areas, si)) },
      { keys: ['c'], run: () => setDraft({ ...draft, lead: cycleLead(roles, leadRole.id) }) },
      { keys: ['w'], run: () => current && set(toggleWrites(areas, si)) },
      { keys: ['b'], run: () => current && set(cycleBase(areas, si, roles)) },
      { keys: ['e'], run: () => current && (setZone('detail'), setFocused('area-name')) },
      { keys: ['n'], run: add },
      { keys: ['f'], run: () => current && askMerge(si) },
      { keys: ['delete'], run: () => current && remove(si) },
      { keys: ['u'], run: undo },
      { keys: ['esc'], run: onDone },
    ],
    { active: zone === 'list' && !editing, footer: 'teams.parts' },
  );
  useShortcuts(
    'teams/parts/detail',
    [
      { keys: ['up'], run: () => setPc(Math.max(0, pc - 1)) },
      { keys: ['down'], run: () => setPc(Math.max(0, Math.min((current?.paths.length ?? 1) - 1, pc + 1))) },
      { keys: ['delete'], run: () => current && current.paths[pc] !== undefined && set(refreshArea(removePath(areas, si, pc), si, cwd, draft.files)) },
      { keys: ['enter'], run: () => setFocused('area-path-add') },
      { keys: ['tab'], run: () => setFocused('area-name') },
      { keys: ['w'], run: () => current && set(toggleWrites(areas, si)) },
      { keys: ['b'], run: () => current && set(cycleBase(areas, si, roles)) },
      { keys: ['u'], run: undo },
      { keys: ['esc', 'shift+tab'], run: () => setZone('list') },
    ],
    { active: zone === 'detail' && !editing, footer: 'teams.parts.detail' },
  );
  useShortcuts(
    'teams/parts/field',
    [
      { keys: ['tab'], run: () => setFocused(cycleZone(FIELDS, focused ?? '', 1)), modes: ['text'] },
      { keys: ['shift+tab'], run: () => setFocused(cycleZone(FIELDS, focused ?? '', -1)), modes: ['text'] },
    ],
    { active: editing, footer: 'form.field' },
  );

  const head = reviewHeader(width - 2, draft.history.length > 0);
  const writers = areas.filter((a) => !a.off && a.writes).length;
  const firstArea = Math.floor(scroll.offset / AREA_H);
  const visibleAreas = Math.ceil((listH - 1) / AREA_H);
  const showCursor = cursor.visible && zone === 'list' && !editing;
  const listInner = listW - (side ? 0 : 2);

  const list = (
    <Box flexDirection="column" width={listW} height={bodyH} paddingX={side ? 0 : 1} overflow="hidden">
      <Divider title={`Áreas (${areas.filter((a) => !a.off).length}) ${g.sep} ${writers} escriben`} width={listInner} color={INFO} />
      <Clickable onClick={() => (cursor.hide(), select(-1))} flexDirection="row" height={1} flexShrink={0} aria-role="option" aria-label={`Coordinador ${leadRole.name}, sin rutas propias`} aria-state={{ selected: si === -1 }}>
        <Text wrap="truncate" inverse={showCursor && si === -1} bold={si === -1}>
          <Text color={WARN}>{g.star}</Text> <Text color={SUCCESS}>{g.checked}</Text> <Text color={toHex(leadRole.color)}>{leadRole.name}</Text>
          <Text color={MUTED}>
            {' '}
            {g.readOnly} coordina (lector), sin rutas {g.sep} c: cambiar
          </Text>
        </Text>
      </Clickable>
      <ScrollArea scroll={scroll} height={listH - 1} onWheel={(d: number) => scroll.onWheel(Math.sign(d) * AREA_H)}>
        {areas.length === 0 && (
          <Box flexDirection="row">
            <Text color={MUTED}>No hay áreas. </Text>
            <Button variant="secondary" label={`${g.add} Añadir área`} onClick={add} />
          </Box>
        )}
        {areas.slice(firstArea, firstArea + visibleAreas).map((a, k) => {
          const i = firstArea + k;
          const on = i === si;
          const color = a.off ? MUTED : toHex(AREA_COLORS[i % AREA_COLORS.length]!);
          const label = `${a.name}, ${a.base || 'dueño de área'}, ${a.writes ? 'escritor' : 'lector'}, ${a.files} ficheros${a.off ? ', excluida' : ''}`;
          return (
            <Box key={`${i}:${a.id}`} flexDirection="column" height={AREA_H} flexShrink={0}>
              <Box flexDirection="row" height={1}>
                <Text color={on ? INFO : MUTED}>{on ? `${g.cursor} ` : '  '}</Text>
                <Clickable onClick={() => (cursor.hide(), select(i), set(toggleIncluded(areas, i)))} aria-role="checkbox" aria-label={`Incluir ${a.name}`} aria-state={{ checked: !a.off }}>
                  <Text color={a.off ? MUTED : SUCCESS}>{a.off ? g.unchecked : g.checked} </Text>
                </Clickable>
                <Clickable onClick={() => (cursor.hide(), select(i), side || setZone('detail'))} flexGrow={1} aria-role="option" aria-label={label} aria-state={{ selected: on }}>
                  <Text wrap="truncate" inverse={showCursor && on} bold={on}>
                    <Text color={color}>{a.name}</Text>
                    {conflicted.has(a.id) ? <Text color={DANGER}> {g.warning}</Text> : null}
                  </Text>
                </Clickable>
                <Clickable onClick={() => (select(i), set(toggleWrites(areas, i)))} aria-role="checkbox" aria-label={`${a.name}: ${a.writes ? 'escribe' : 'lee'}`} aria-state={{ checked: a.writes }}>
                  <Text color={a.writes ? WARN : MUTED}>
                    {' '}
                    {a.writes ? `${g.write} escritor` : `${g.readOnly} lector`} {String(a.files).padStart(3)}
                  </Text>
                </Clickable>
              </Box>
              <Text color={MUTED} wrap="truncate">
                {'    '}
                {a.paths.length ? a.paths.join(` ${g.sep} `) : 'sin rutas'}
              </Text>
            </Box>
          );
        })}
      </ScrollArea>
      <Box flexDirection="column" height={issuesH} flexShrink={0} overflow="hidden">
        {issues.length === 0 && <Text color={SUCCESS}>{g.tick} Rutas sin solapes</Text>}
        {issues.slice(0, issuesH).map((i, k) => {
          const more = k === issuesH - 1 && issues.length > issuesH ? ` (+${issues.length - issuesH} más)` : '';
          const target = areas.findIndex((a) => i.agents.includes(a.id));
          return (
            <Clickable key={k} onClick={() => target >= 0 && select(target)} height={1}>
              <Text color={i.level === 'error' ? DANGER : WARN} wrap="truncate">
                {g.warning} {i.text}
                {more}
              </Text>
            </Clickable>
          );
        })}
      </Box>
    </Box>
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection="row" flexShrink={0} height={1} paddingX={1} overflow="hidden">
        {!side && zone === 'detail' ? (
          <BackButton onClick={() => setZone('list')} />
        ) : (
          <BackButton label={head.back} onClick={onDone} />
        )}
        <Button variant="primary" label="Listo" onClick={onDone} />
        <Button variant="tertiary" label={head.restore} onClick={() => setDraft(restoreDraft(draft))} />
        <Button variant="secondary" label={head.add} onClick={add} />
        {draft.history.length > 0 && <Button variant="tertiary" label={head.undo} onClick={undo} />}
      </Box>
      <Box flexDirection="row" height={bodyH}>
        {showList && list}
        {side && <VSep height={bodyH} />}
        {showDetail && (
          <AreaDetail
            area={current}
            leadName={leadRole.name}
            files={draft.files}
            cwd={cwd}
            width={detailW}
            height={bodyH}
            pc={zone === 'detail' && !editing ? pc : -1}
            newPath={newPath}
            pathErr={pathErr}
            onNewPath={(v) => (setNewPath(v), setPathErr(''))}
            onSubmitPath={submitPath}
            onRename={(v) => set(renameArea(areas, si, v))}
            onWrites={() => set(toggleWrites(areas, si))}
            onBase={(d) => set(cycleBase(areas, si, roles, d))}
            onRemovePath={(j) => set(refreshArea(removePath(areas, si, j), si, cwd, draft.files))}
            onMerge={() => askMerge(si)}
            onRemove={() => remove(si)}
          />
        )}
      </Box>
    </Box>
  );
}

function AreaDetail({
  area,
  leadName,
  files,
  cwd,
  width,
  height,
  pc,
  newPath,
  pathErr,
  onNewPath,
  onSubmitPath,
  onRename,
  onWrites,
  onBase,
  onRemovePath,
  onMerge,
  onRemove,
}: {
  area?: PlanArea;
  leadName: string;
  files: string[];
  cwd: string;
  width: number;
  height: number;
  /** Path under the keyboard cursor; -1 = none. */
  pc: number;
  newPath: string;
  pathErr: string;
  onNewPath: (v: string) => void;
  onSubmitPath: (v: string) => void;
  onRename: (v: string) => void;
  onWrites: () => void;
  onBase: (dir: 1 | -1) => void;
  onRemovePath: (i: number) => void;
  onMerge: () => void;
  onRemove: () => void;
}) {
  const { roles } = useApp();
  const inner = width - 2;
  if (!area)
    return (
      <Box flexDirection="column" width={width} height={height} paddingX={1}>
        <Text bold>
          {g.star} {leadName}
        </Text>
        <Text color={MUTED}>El coordinador integra y reparte; no tiene rutas propias. Pulsa c para cambiarlo.</Text>
      </Box>
    );
  const base = area.base ? roles.find((r) => r.id === area.base) : undefined;
  const reasonLines = wrap(area.reason || '—', inner, 2);
  // name · base/permission · paths divider · paths · add · hint · error · reason divider + lines · actions
  const pathsH = Math.max(1, height - 5 - (pathErr ? 1 : 0) - 1 - reasonLines.length - 1);
  const rows = area.writes ? pathsH : pathsH - 1;
  const first = Math.max(0, Math.min(pc, area.paths.length - 1) - rows + 1);
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} overflow="hidden">
      <TextField id="area-name" label="Nombre  " value={area.name} onChange={onRename} width={Math.max(12, Math.min(40, inner - 10))} />
      <Box flexDirection="row" flexShrink={0} height={1}>
        <Text color={MUTED}>Rol base </Text>
        <Button variant="tertiary" label={g.back} onClick={() => onBase(-1)} />
        <Box flexShrink={0}>
          <Text bold color={base ? toHex(base.color) : TEXT}>
            {base ? base.id : 'dueño de área'}{' '}
          </Text>
        </Box>
        <Button variant="tertiary" label={g.next} onClick={() => onBase(1)} />
        <Toggle
          label="Permiso del área"
          value={area.writes ? 'w' : 'r'}
          onChange={(v) => v !== (area.writes ? 'w' : 'r') && onWrites()}
          options={[
            { value: 'w', label: `${g.write} Escritor` },
            { value: 'r', label: `${g.readOnly} Lector` },
          ]}
        />
      </Box>
      <Divider title="Rutas propias" width={inner} color={area.writes ? INFO : MUTED} />
      <Box flexDirection="column" height={pathsH} flexShrink={0} overflow="hidden">
        {!area.writes && <Text color={MUTED}>Los lectores no escriben; pueden leer todo el repo.</Text>}
        {area.paths.length === 0 && area.writes && <Text color={MUTED}>Sin rutas: añade una abajo.</Text>}
        {area.paths.slice(first, first + rows).map((p, k) => {
          const j = first + k;
          const n = resolvePaths(cwd, [p], files).length;
          const here = j === pc;
          return (
            <Box key={p} flexDirection="row" height={1}>
              <Text wrap="truncate" inverse={here} color={area.writes ? TEXT : MUTED}>
                {here ? `${g.cursor} ` : '  '}
                {p}
              </Text>
              <Box flexGrow={1} />
              <Text color={n ? MUTED : WARN}>{n ? `${pathKind(p, files.includes(p))} ${g.sep} ${n} ` : `${g.warning} No hay ficheros que coincidan `}</Text>
              <Button variant="danger" label={`${g.close} Quitar`} onClick={() => onRemovePath(j)} />
            </Box>
          );
        })}
      </Box>
      <Box flexDirection="row" flexShrink={0} height={1}>
        <TextField id="area-path-add" label="Añadir ruta:" value={newPath} onChange={onNewPath} onSubmit={onSubmitPath} placeholder="carpeta, fichero o carpeta/*" width={Math.max(12, Math.min(36, inner - 18))} />
        <Text> </Text>
        <Button variant="secondary" label={g.add} onClick={() => onSubmitPath(newPath)} />
      </Box>
      <Text color={MUTED} wrap="truncate">
        carpeta = recursivo {g.sep} carpeta/* = solo directos
      </Text>
      {pathErr && (
        <Text color={DANGER} wrap="truncate">
          {g.warning} {pathErr}
        </Text>
      )}
      <Divider title="Por qué esta área" width={inner} />
      {reasonLines.map((l, i) => (
        <Text key={i} color={MUTED} wrap="truncate">
          {l}
        </Text>
      ))}
      <Box flexDirection="row" flexShrink={0} height={1}>
        <Button variant="secondary" label={`${g.merge} Fusionar con…`} onClick={onMerge} />
        <Button variant="danger" label={`${g.close} Quitar área`} onClick={onRemove} />
      </Box>
    </Box>
  );
}
