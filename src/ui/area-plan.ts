// Pure logic of the automatic team composition ("Auto por rol" / "Auto por partes del
// código"): editing the proposal, validation copy, the launch gate and the team to launch.
// No React and no claude: the screens only wire these helpers to mouse and keyboard.
import path from 'node:path';
import { type AreaIssue, type AreaProposal, areaId, areaRole, coordinatorRole, resolvePaths } from '../areas.ts';
import type { RoleTeamProposal } from '../stack.ts';
import type { Role } from '../types.ts';

/** How the Teams tab composes the next team. */
export type ComposeMode = 'dept' | 'auto-role' | 'auto-area';
export const COMPOSE_MODES: ComposeMode[] = ['dept', 'auto-role', 'auto-area'];

/** An area of the plan; `off` = left out of the team (☐ in the review). */
export type PlanArea = AreaProposal & { off?: boolean };

// ------------------------------------------------------------------ paths

/** "a, b" or "a, b +3" when more than `max` paths. */
export function formatPaths(paths: string[], max = Infinity): string {
  const shown = paths.slice(0, max).join(', ');
  return paths.length > max ? `${shown} +${paths.length - max}` : shown;
}

/** A path outside the session directory (absolute, or climbing with ".."). */
export function isOutside(p: string): boolean {
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) return true;
  const n = path.posix.normalize(p.replace(/\\/g, '/'));
  return n === '..' || n.startsWith('../');
}

/** "solo directos" / "fichero" / "recursivo" description of a path. */
export function pathKind(p: string, isFile: boolean): string {
  if (p === '*' || p.endsWith('/*')) return 'solo directos';
  return isFile ? 'fichero' : 'recursivo';
}

// ---------------------------------------------------------------- editing

const at = (areas: PlanArea[], index: number, fn: (a: PlanArea) => PlanArea) => areas.map((a, i) => (i === index ? fn(a) : a));

export const renameArea = (areas: PlanArea[], index: number, name: string) => at(areas, index, (a) => ({ ...a, name, id: areaId(name) }));
export const toggleWrites = (areas: PlanArea[], index: number) => at(areas, index, (a) => ({ ...a, writes: !a.writes }));
export const toggleIncluded = (areas: PlanArea[], index: number) => at(areas, index, (a) => ({ ...a, off: !a.off }));
export const removeArea = (areas: PlanArea[], index: number) => areas.filter((_, i) => i !== index);
export const removePath = (areas: PlanArea[], index: number, pathIndex: number) => at(areas, index, (a) => ({ ...a, paths: a.paths.filter((_, j) => j !== pathIndex) }));

/** Adds a path, or says why not (outside the directory: blocks, never added). */
export function addPath(areas: PlanArea[], index: number, raw: string, dir: string): { areas: PlanArea[]; error?: string } {
  const p = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) return { areas };
  if (isOutside(p)) return { areas, error: `La ruta debe estar dentro de ${dir}.` };
  return { areas: at(areas, index, (a) => (a.paths.includes(p) ? a : { ...a, paths: [...a.paths, p] })) };
}

/**
 * After a hand edit of an area's paths: real file count from the cached project list, and a
 * reason/description that say so (the description reaches every agent's roster via areaRole).
 */
export function refreshArea(areas: PlanArea[], index: number, cwd: string, files: string[]): PlanArea[] {
  return at(areas, index, (a) => {
    const n = resolvePaths(cwd, a.paths, files).length;
    const count = `${n} fichero${n === 1 ? '' : 's'}`;
    return { ...a, files: n, reason: `Editada a mano · ${count}`, description: a.paths.length ? `${count} en ${a.paths.join(', ')}` : 'sin rutas' };
  });
}

/** Selection index clamped to a list of `length` items (-1 = the lead row above the areas). */
export const clampSel = (i: number, length: number) => Math.max(-1, Math.min(length - 1, i));

/** Appends an empty writer area named "Área N" with a name not taken yet. */
export function addArea(areas: PlanArea[]): PlanArea[] {
  const taken = new Set(areas.map((a) => a.id));
  let n = areas.length + 1;
  while (taken.has(areaId(`Área ${n}`))) n++;
  const name = `Área ${n}`;
  return [...areas, { id: areaId(name), name, paths: [], description: '', writes: true, files: 0, base: '', reason: 'Añadida a mano.' }];
}

/** Merges area `from` into `into`: union of paths, writer if either writes; keeps `into`'s name and base. */
export function mergeAreas(areas: PlanArea[], from: number, into: number): PlanArea[] {
  const a = areas[from];
  const b = areas[into];
  if (!a || !b || from === into) return areas;
  const merged: PlanArea = {
    ...b,
    paths: [...new Set([...b.paths, ...a.paths])],
    files: b.files + a.files,
    writes: a.writes || b.writes,
    description: [b.description, a.description].filter(Boolean).join('; '),
    reason: `Fusión de «${b.name}» y «${a.name}».`,
    off: false,
  };
  return areas.flatMap((x, i) => (i === from ? [] : i === into ? [merged] : [x]));
}

/** Base role choices of an area: '' (generic area owner) then every library role. */
export const baseOptions = (roles: Role[]) => ['', ...roles.filter((r) => !r.area).map((r) => r.id)];

/** Moves an area's base role to the next/previous option. */
export function cycleBase(areas: PlanArea[], index: number, roles: Role[], dir: 1 | -1 = 1): PlanArea[] {
  const opts = baseOptions(roles);
  return at(areas, index, (a) => {
    const i = Math.max(0, opts.indexOf(a.base));
    return { ...a, base: opts[(i + dir + opts.length) % opts.length]! };
  });
}

// ------------------------------------------------------------------- lead

// Same preference as the core (stack.ts): cto, then pm, then the library's own coordinator.
const LEAD_ORDER = ['cto', 'pm', 'coordinator'];

/** Roles that can coordinate, best first; the generic coordinator last unless the library has one. */
export function leadCandidates(roles: Role[]): Role[] {
  const lib = roles.filter((r) => !r.area);
  const first = LEAD_ORDER.map((id) => lib.find((r) => r.id === id)).filter(Boolean) as Role[];
  const rest = lib.filter((r) => !LEAD_ORDER.includes(r.id));
  const generic = lib.some((r) => r.id === coordinatorRole().id) ? [] : [coordinatorRole()];
  return [...first, ...rest, ...generic];
}

/** Default lead: cto ?? pm ?? the library's coordinator ?? the generic coordinator. */
export function defaultLeadId(roles: Role[]): string {
  return leadCandidates(roles).find((r) => LEAD_ORDER.includes(r.id))?.id ?? coordinatorRole().id;
}

/** The lead role of an area plan; a lead id no longer in the library falls back to the default. */
export function resolveLead(roles: Role[], lead: string): Role {
  const c = leadCandidates(roles);
  return c.find((r) => r.id === lead) ?? c.find((r) => r.id === defaultLeadId(roles))!;
}

export function cycleLead(roles: Role[], lead: string, dir: 1 | -1 = 1): string {
  const c = leadCandidates(roles);
  const i = c.findIndex((r) => r.id === lead);
  return c[(i + dir + c.length) % c.length]!.id;
}

// ------------------------------------------------------------- validation

export type PlanIssue = { level: 'error' | 'warning'; text: string; agents: string[] };

/** «{a}» y «{b}» comparten rutas: {files | path}. … — or the issue's own message. */
export function issueText(i: AreaIssue, nameOf: (id: string) => string = (id) => id): string {
  if (i.level === 'error' && i.agents?.length === 2 && (i.files?.length || i.path)) {
    const shared = i.files?.length ? formatPaths(i.files, 3) : i.path!;
    return `«${nameOf(i.agents[0]!)}» y «${nameOf(i.agents[1]!)}» comparten rutas: ${shared}. Quita la ruta de una, fusiónalas o marca una como lectora.`;
  }
  return i.path && !i.message.includes(i.path) ? `${i.message} (${i.path})` : i.message;
}

/** Issues of the included areas: the core ones (validateAreas) plus names and writers; errors first. */
export function planIssues(areas: PlanArea[], core: AreaIssue[]): PlanIssue[] {
  const on = areas.filter((a) => !a.off);
  if (!on.length) return [{ level: 'error', text: 'No hay agentes. Incluye al menos un área.', agents: [] }];
  const nameOf = (id: string) => on.find((a) => a.id === id)?.name ?? id;
  const out: PlanIssue[] = [];
  const seen = new Set<string>();
  let dupNames = false;
  for (const a of on) {
    const key = a.name.trim().toLowerCase();
    if (!key) out.push({ level: 'error', text: 'Escribe un nombre.', agents: [a.id] });
    else if (seen.has(key)) (dupNames = true), out.push({ level: 'error', text: `Ya hay un área «${a.name.trim()}».`, agents: [a.id] });
    seen.add(key);
  }
  for (const i of core) {
    // Duplicate ids come from duplicate names, already reported above.
    if (dupNames && i.level === 'error' && /duplicad/i.test(i.message)) continue;
    out.push({ level: i.level, text: issueText(i, nameOf), agents: i.agents ?? [] });
  }
  if (!on.some((a) => a.writes)) out.push({ level: 'warning', text: 'Nadie puede escribir. Marca al menos un área como escritora.', agents: [] });
  return [...out.filter((i) => i.level === 'error'), ...out.filter((i) => i.level === 'warning')];
}

export type LaunchGate = { blocked: boolean; reason?: string; errors: PlanIssue[]; warnings: PlanIssue[] };

/** Any error (or a running session, for code areas) blocks launching; warnings never do. */
export function launchGate(issues: PlanIssue[], running = false): LaunchGate {
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  const reason = running
    ? 'Detén la sesión para componer por partes'
    : errors.length
      ? `${errors.length === 1 ? '1 conflicto' : `${errors.length} conflictos`}: revisa antes de lanzar`
      : undefined;
  return { blocked: !!reason, reason, errors, warnings };
}

// ------------------------------------------------------------------ teams

/** Lead first (exactly one agent without paths, never a writer), then one ephemeral role per included area. */
export function buildAreaTeam(areas: PlanArea[], lead: Role, library: Role[] = []): Role[] {
  const { area: _, ...plainLead } = lead;
  return [{ ...plainLead, writes: false }, ...areas.filter((a) => !a.off).map((a, i) => areaRole(a, i, library))];
}

/** A role proposal under review: who is left out and who leads. */
export type RolePlan = { members: RoleTeamProposal['members']; off: string[]; lead: string };

export const rolePlanOf = (p: RoleTeamProposal): RolePlan => ({ members: p.members, off: [], lead: p.lead });

/** Included members, lead first; the lead falls back to the first included member. */
export function roleTeam(plan: RolePlan): { roles: Role[]; lead: string | undefined; generated: string[] } {
  const on = plan.members.filter((m) => !plan.off.includes(m.role.id));
  const lead = on.some((m) => m.role.id === plan.lead) ? plan.lead : on[0]?.role.id;
  const ordered = [...on.filter((m) => m.role.id === lead), ...on.filter((m) => m.role.id !== lead)];
  return { roles: ordered.map((m) => m.role), lead, generated: ordered.filter((m) => m.generated).map((m) => m.role.id) };
}

/** Adds a library role to the plan (reason: added by hand); re-includes it when already there. */
export function addMember(plan: RolePlan, role: Role): RolePlan {
  if (plan.members.some((m) => m.role.id === role.id)) return { ...plan, off: plan.off.filter((id) => id !== role.id) };
  return { ...plan, members: [...plan.members, { role, reason: `${role.id}: añadido a mano`, generated: false }] };
}

export const toggleMember = (plan: RolePlan, id: string): RolePlan => ({ ...plan, off: plan.off.includes(id) ? plan.off.filter((x) => x !== id) : [...plan.off, id] });

/** Roles of a team not yet in the running session (adding to it never duplicates agents). */
export function missingFrom(roles: Role[], running: Iterable<string>): Role[] {
  const have = new Set(running);
  return roles.filter((r) => !have.has(r.id));
}

/** «Ya existe el rol «X» en este proyecto: se guardará como «X-2».» (at most `max` lines, then «+N más»). */
export function saveConflicts(idMap: Record<string, string>, max = 2): string[] {
  const clashes = Object.entries(idMap).filter(([a, b]) => a !== b);
  const lines = clashes.slice(0, max).map(([a, b]) => `Ya existe el rol «${a}» en este proyecto: se guardará como «${b}».`);
  if (clashes.length > max) lines.push(`+${clashes.length - max} más`);
  return lines;
}

/** Applies the ids the project library assigned on save to the team about to launch. */
export function remapIds(roles: Role[], lead: string, idMap: Record<string, string>): { roles: Role[]; lead: string } {
  return { roles: roles.map((r) => (idMap[r.id] ? { ...r, id: idMap[r.id]! } : r)), lead: idMap[lead] ?? lead };
}
