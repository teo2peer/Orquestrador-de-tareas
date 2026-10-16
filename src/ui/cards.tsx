import { Box, Text } from 'ink';
import React from 'react';
import type { Department, Role } from '../types.ts';
import { wrap } from './app-context.tsx';
import { border, g, safeText } from './glyphs.ts';
import { Clickable } from './mouse.tsx';
import { type SpriteState, defaultLook, miniRows, spriteRows, toHex } from './sprites.ts';
import { BORDER, FOCUS, INFO, MUTED, PRIMARY, SUCCESS, WARN } from './theme.ts';

export const lookOfRole = (r: Role) => defaultLook(r.id, r.color, r.accessory, r.hair, r.skin);

export function BigSprite({ role, state = 'idle', tick, xl }: { role: Role; state?: SpriteState; tick: number; xl?: boolean }) {
  return (
    <Box flexDirection="column" width={xl ? 24 : 12} flexShrink={0} aria-hidden>
      {spriteRows(role.id, lookOfRole(role), state, tick, xl ? 'xl' : 'normal').map((r, i) => (
        <Text key={i}>{r}</Text>
      ))}
    </Box>
  );
}

export function MiniSprite({ role, tick, dim }: { role: Role; tick: number; dim?: boolean }) {
  const rows = miniRows(lookOfRole(role), dim ? 0 : tick, dim ? 'gray' : 'normal');
  return (
    <Box flexDirection="column" width={6} flexShrink={0} aria-hidden>
      {rows.map((r, i) => (
        <Text key={i}>{r}</Text>
      ))}
    </Box>
  );
}

export const writesLabel = (r: Role) => (r.writes ? <Text color={WARN}>{g.edit} escribe</Text> : <Text color={MUTED}>{g.readOnly} solo lectura</Text>);

/**
 * Card frame: keyboard cursor = bold border; selected (open in the panel) = double
 * border; both in the focus colour. Everything else uses the border colour.
 */
const frame = (selected: boolean, cursor?: boolean) => ({
  borderStyle: border(cursor ? 'bold' : selected ? 'double' : 'round'),
  borderColor: selected || cursor ? FOCUS : BORDER,
});

/** "▶ " (cursor) or "▸ " (open) before the name, then "☑ " when picked. */
function Marks({ selected, picked, cursor }: { selected: boolean; picked?: boolean; cursor?: boolean }) {
  return (
    <>
      {cursor ? <Text color={FOCUS}>{`${g.cursor} `}</Text> : selected ? <Text color={FOCUS}>{`${g.focus} `}</Text> : null}
      {picked ? <Text color={SUCCESS}>{`${g.checked} `}</Text> : null}
    </>
  );
}

/** " · abierta" after the name when the cursor sits on the open card. */
const OpenTag = ({ show }: { show: boolean }) => (show ? <Text color={MUTED}>{` ${g.sep} abierta`}</Text> : null);

// ------------------------------------------------------------------ teams

export const TEAM_W = 38;
export const TEAM_H = 11;
export const TEAM_H_COMPACT = 5;

/**
 * Team card. Full: header, minis, lead, description, counts (TEAM_H rows).
 * `compact`: header, lead, counts (TEAM_H_COMPACT rows).
 */
export function TeamCard({
  d,
  roles,
  selected,
  tick,
  onClick,
  width = TEAM_W,
  compact,
  cursor,
}: {
  d: Department;
  roles: Map<string, Role>;
  selected: boolean;
  tick: number;
  onClick: () => void;
  width?: number;
  compact?: boolean;
  /** Keyboard cursor on this card. */
  cursor?: boolean;
}) {
  const members = d.roles.map((id) => roles.get(id)).filter(Boolean) as Role[];
  const ordered = d.lead ? [...members.filter((m) => m.id === d.lead), ...members.filter((m) => m.id !== d.lead)] : members;
  const lead = d.lead ? roles.get(d.lead) : undefined;
  const writers = members.filter((m) => m.writes).length;
  const color = toHex(d.color);
  const inner = width - 4;
  // Each mini takes 7 columns (6 + gap); reserve room for "+N" when not all fit.
  const all = Math.floor((inner + 1) / 7);
  const shown = ordered.length <= all ? ordered.length : Math.max(0, Math.floor((inner + 1 - (String(ordered.length).length + 1)) / 7));
  const hidden = ordered.length - shown;
  return (
    <Clickable
      onClick={onClick}
      width={width}
      height={compact ? TEAM_H_COMPACT : TEAM_H}
      flexDirection="column"
      {...frame(selected, cursor)}
      paddingX={1}
      marginRight={1}
      flexShrink={0}
      aria-role="listitem"
      aria-label={`${d.name}, ${members.length} roles`}
      aria-state={{ selected: !!cursor, expanded: selected }}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexShrink={1}>
          <Text wrap="truncate">
            <Marks selected={selected} cursor={cursor} />
            <Text bold color={color}>
              {safeText(d.icon)} {d.name}
            </Text>
            <OpenTag show={!!cursor && selected} />
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text color={MUTED}>{members.length} roles</Text>
        </Box>
      </Box>
      {!compact && (
        <Box flexDirection="row" height={4} overflow="hidden">
          {ordered.slice(0, shown).map((m, i) => (
            <Box key={m.id} marginRight={1} flexShrink={0}>
              <MiniSprite role={m} tick={selected ? tick + i * 3 : 0} />
            </Box>
          ))}
          {hidden > 0 && (
            <Box alignItems="center" height={4} flexShrink={0}>
              <Text color={MUTED}>+{hidden}</Text>
            </Box>
          )}
        </Box>
      )}
      <Text color={WARN} wrap="truncate">
        {lead ? `${g.star} ${lead.name}` : <Text color={MUTED}>sin coordinador</Text>}
      </Text>
      {!compact &&
        wrap(d.description || 'Sin descripción', inner, 2).map((l, i) => (
          <Text key={i} color={MUTED} wrap="truncate">
            {l}
          </Text>
        ))}
      <Text wrap="truncate">
        <Text color={WARN}>
          {g.edit}
          {writers} escriben
        </Text>
        <Text color={MUTED}>
          {` ${g.sep} ${g.readOnly}`}
          {members.length - writers} leen
        </Text>
        {d.scope === 'project' ? <Text color={PRIMARY}>{` ${g.sep} proyecto`}</Text> : null}
      </Text>
    </Clickable>
  );
}

export function NewCard({ label, width, height, onClick, cursor }: { label: string; width: number; height: number; onClick: () => void; cursor?: boolean }) {
  return (
    <Clickable
      onClick={onClick}
      width={width}
      height={height}
      borderStyle={border(cursor ? 'bold' : 'round')}
      borderColor={cursor ? FOCUS : SUCCESS}
      alignItems="center"
      justifyContent="center"
      flexDirection="column"
      marginRight={1}
      flexShrink={0}
      aria-role="button"
      aria-label={label}
      aria-state={{ selected: !!cursor }}
    >
      <Text color={SUCCESS} bold wrap="truncate">
        {cursor ? `${g.cursor} ` : ''}
        {height > 3 ? g.add : `${g.add} ${label}`}
      </Text>
      {height > 3 && (
        <Text color={SUCCESS} bold wrap="truncate">
          {label}
        </Text>
      )}
    </Clickable>
  );
}

// ------------------------------------------------------------------ roles

export const ROLE_W = 34;
export const ROLE_H = 11;
export const ROLE_H_COMPACT = 4;

/** `title` only when it adds something to `name`. */
const titleOf = (r: Role) => (r.title && r.title.trim().toLowerCase() !== r.name.trim().toLowerCase() ? r.title : '');

/**
 * Role card. Full: sprite + name, title, writes, model, pack and a 2-line description
 * (ROLE_H rows). `compact`: name + ✎/◌, then title · model (ROLE_H_COMPACT rows).
 * `picked` puts a ☑ before the name; the border only reflects `selected`.
 */
export function RoleCard({
  r,
  selected,
  picked,
  tick,
  onClick,
  width = ROLE_W,
  compact,
  cursor,
}: {
  r: Role;
  selected: boolean;
  picked: boolean;
  tick: number;
  onClick: () => void;
  width?: number;
  compact?: boolean;
  /** Keyboard cursor on this card. */
  cursor?: boolean;
}) {
  const color = toHex(r.color);
  const title = titleOf(r);
  const box = {
    onClick,
    width,
    flexDirection: 'column' as const,
    ...frame(selected, cursor),
    paddingX: 1,
    marginRight: 1,
    flexShrink: 0,
    'aria-role': 'listitem' as const,
    'aria-label': [r.name, title, picked ? 'seleccionado' : ''].filter(Boolean).join(', '),
    'aria-state': { selected: !!cursor, expanded: selected, checked: picked },
  };
  const name = (
    <Text wrap="truncate">
      <Marks selected={selected} picked={picked} cursor={cursor} />
      <Text bold color={color}>
        {r.name}
      </Text>
      <OpenTag show={!!cursor && selected} />
    </Text>
  );

  if (compact) {
    const sub = [title, r.model].filter(Boolean).join(` ${g.sep} `);
    return (
      <Clickable {...box} height={ROLE_H_COMPACT}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexShrink={1}>{name}</Box>
          <Box flexShrink={0} marginLeft={1}>
            {r.writes ? <Text color={WARN}>{g.edit}</Text> : <Text color={MUTED}>{g.readOnly}</Text>}
          </Box>
        </Box>
        <Text color={MUTED} wrap="truncate">
          {sub}
        </Text>
      </Clickable>
    );
  }

  // Below ~28 columns the big sprite leaves too little room for text: drop it.
  const sprite = width >= 28;
  const textW = width - 4 - (sprite ? 13 : 0);
  return (
    <Clickable {...box} height={ROLE_H}>
      <Box flexDirection="row" height={7}>
        {sprite && <BigSprite role={r} tick={selected ? tick : 0} state={selected ? 'working' : 'idle'} />}
        <Box flexDirection="column" marginLeft={sprite ? 1 : 0} width={textW} overflow="hidden">
          {name}
          <Text color={MUTED} wrap="truncate">
            {title}
          </Text>
          <Text wrap="truncate">{writesLabel(r)}</Text>
          <Text color={INFO} wrap="truncate">
            {r.model ?? ''}
          </Text>
          <Text color={MUTED} wrap="truncate">
            {r.pack ? `pack ${r.pack}` : ''}
          </Text>
        </Box>
      </Box>
      {wrap(r.description || '—', width - 4, 2).map((l, i) => (
        <Text key={i} color={MUTED} wrap="truncate">
          {l}
        </Text>
      ))}
    </Clickable>
  );
}
