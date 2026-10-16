// Pure rules of «elegir y confirmar» (OptionPicker + ReplyPopup): which options a message
// offers, the recommended one, the exact text that will be sent and the confirm button.

export type PickOption = { value: string; label: string; recommended?: boolean; danger?: boolean };

const RECOMMENDED = /\s*[([]\s*recomendad[oa]\s*[)\]]\s*/i;

/** Options from raw labels: «(recomendado/a)» is removed from the text and the option goes first; repeated labels are dropped. */
export function parseOptions(raw: string[]): PickOption[] {
  const seen = new Set<string>();
  const labels = raw.filter((l) => {
    const k = l.replace(RECOMMENDED, ' ').trim().toLowerCase();
    return !seen.has(k) && !!seen.add(k);
  });
  const opts = labels.map((l) => (RECOMMENDED.test(l) ? { value: l, label: l.replace(RECOMMENDED, ' ').trim(), recommended: true } : { value: l, label: l.trim() }));
  return [...opts.filter((o) => o.recommended), ...opts.filter((o) => !o.recommended)];
}

/** What goes to the agent: «opción. comentario», just the option, or just the comment. */
export function replyText(option?: string, comment = ''): string {
  const c = comment.trim();
  if (option && c) return `${option}. ${c}`;
  return option ?? c;
}

export type ReplyKind = 'question' | 'report' | 'decision' | 'none';
export type Decision = 'hire' | 'trust' | 'bypass';

const ASK_DEFAULTS = ['Sí, adelante', 'No', 'Decide tú y continúa'];
const REJECTED: Record<Decision, (role?: string) => string> = {
  hire: (role) => `No se contratará a ${role ?? 'ese rol'}; el lead seguirá sin él.`,
  trust: () => 'El agente no podrá trabajar en esta carpeta.',
  bypass: () => 'El agente seguirá pidiendo permisos.',
};
const CONSEQUENCE: Record<Decision, string> = {
  hire: 'Se abrirá una sesión nueva de Claude (consume cuota).',
  trust: 'El agente confiará en esta carpeta.',
  bypass: '⚠ El agente podrá actuar sin pedir permisos.',
};

/** The picker of a message or alert: its options and, for decisions, the consequence line. */
export function replyPlan(kind: string, o: { options?: string[]; role?: string; canReply: boolean }): { kind: ReplyKind; options: PickOption[]; consequence?: string; rejected?: string } {
  if (kind === 'hire' || kind === 'trust' || kind === 'bypass')
    return {
      kind: 'decision',
      options: [
        { value: 'accept', label: kind === 'hire' ? `Aceptar: contratar a ${o.role ?? 'el rol'}` : 'Aceptar' },
        { value: 'reject', label: 'Rechazar', danger: true },
      ],
      consequence: CONSEQUENCE[kind],
      rejected: REJECTED[kind](o.role),
    };
  if (!o.canReply) return { kind: 'none', options: [] };
  if (kind === 'question') return { kind: 'question', options: parseOptions(o.options?.length ? o.options : ASK_DEFAULTS) };
  // Reports: «Entendido» becomes the direct «Marcar como leído» button.
  return { kind: 'report', options: [{ value: 'Sigue así', label: 'Sigue así' }, { value: 'Para y espera', label: 'Para y espera', danger: true }] };
}

/** The consequence line of a decision for the chosen option (accepting's while nothing is chosen). */
export const consequenceOf = (plan: { consequence?: string; rejected?: string }, picked?: string) => (picked === 'reject' ? plan.rejected : plan.consequence);

/** Label, look and state of the confirm button; a disabled one says why. */
export function confirmButton(kind: ReplyKind, picked: PickOption | undefined, comment: string): { label: string; variant: 'primary' | 'danger'; disabled: boolean } {
  if (kind === 'decision') {
    if (!picked) return { label: 'Elige una opción', variant: 'primary', disabled: true };
    return picked.value === 'accept' ? { label: 'Confirmar: aceptar (↵)', variant: 'primary', disabled: false } : { label: 'Confirmar: rechazar (↵)', variant: 'danger', disabled: false };
  }
  if (!picked && !comment.trim()) return { label: 'Elige una opción o escribe', variant: 'primary', disabled: true };
  if (picked?.danger) return { label: '■ Enviar: parar y esperar (↵)', variant: 'danger', disabled: false };
  return { label: '▶ Enviar respuesta (↵)', variant: 'primary', disabled: false };
}

/** ↵ right after choosing with a key is ignored for `guardMs` (no accidental double tap). */
export const confirmReady = (lastPickAt: number, now: number, guardMs: number) => now - lastPickAt >= guardMs;

/** Selection kept per message while the popup is closed and reopened (Esc keeps it). */
export const picks = new Map<string, string>();
