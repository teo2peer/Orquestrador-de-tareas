import { describe, expect, test } from 'bun:test';
import { confirmButton, confirmReady, consequenceOf, parseOptions, replyPlan, replyText } from './pick.ts';

describe('options', () => {
  test('«(recomendado)» is parsed out, case-insensitive, and goes first (not preselected)', () => {
    expect(parseOptions(['Postgres', 'SQLite (Recomendado)', 'Decide tú'])).toEqual([
      { value: 'SQLite (Recomendado)', label: 'SQLite', recommended: true },
      { value: 'Postgres', label: 'Postgres' },
      { value: 'Decide tú', label: 'Decide tú' },
    ]);
    expect(parseOptions(['A [recomendada]'])[0]).toMatchObject({ label: 'A', recommended: true });
    // Same text twice (even once marked recommended) is one option: values never collide.
    expect(parseOptions(['Sí', 'No', 'sí ', 'No (recomendado)']).map((o) => o.label)).toEqual(['Sí', 'No']);
  });
  test('plans: questions, reports (no «Entendido» in the picker) and decisions', () => {
    expect(replyPlan('question', { canReply: true }).options.map((o) => o.label)).toEqual(['Sí, adelante', 'No', 'Decide tú y continúa']);
    expect(replyPlan('report', { canReply: true }).options.map((o) => o.label)).toEqual(['Sigue así', 'Para y espera']);
    const hire = replyPlan('hire', { role: 'qa', canReply: false });
    expect(hire.kind).toBe('decision');
    expect(hire.options.map((o) => o.label)).toEqual(['Aceptar: contratar a qa', 'Rechazar']);
    expect(hire.consequence).toContain('consume cuota');
    expect(replyPlan('bypass', { canReply: false }).consequence).toContain('sin pedir permisos');
    expect(replyPlan('message', { canReply: false }).kind).toBe('none');
  });
});

describe('preview and confirm', () => {
  test('exact text sent', () => {
    expect(replyText('SQLite', ' Prefiero sin servidor ')).toBe('SQLite. Prefiero sin servidor');
    expect(replyText('SQLite')).toBe('SQLite');
    expect(replyText(undefined, 'otra cosa')).toBe('otra cosa');
    expect(replyText(undefined, '  ')).toBe('');
  });
  test('confirm button: disabled with its reason until something is chosen; danger for stop/reject', () => {
    expect(confirmButton('question', undefined, '')).toEqual({ label: 'Elige una opción o escribe', variant: 'primary', disabled: true });
    expect(confirmButton('question', undefined, 'texto libre').disabled).toBe(false);
    expect(confirmButton('report', { value: 'Para y espera', label: 'Para y espera', danger: true }, '')).toMatchObject({ variant: 'danger', label: '■ Enviar: parar y esperar (↵)' });
    expect(confirmButton('decision', undefined, '').disabled).toBe(true);
    expect(confirmButton('decision', { value: 'reject', label: 'Rechazar', danger: true }, '')).toMatchObject({ label: 'Confirmar: rechazar (↵)', variant: 'danger' });
  });
  test('↵ is ignored right after a key pick', () => {
    expect(confirmReady(1000, 1100, 300)).toBe(false);
    expect(confirmReady(1000, 1300, 300)).toBe(true);
  });
});

describe('decision consequences follow the choice', () => {
  test('rejecting says what happens; nothing chosen shows accepting', () => {
    const hire = replyPlan('hire', { role: 'qa', canReply: false });
    expect(consequenceOf(hire, 'reject')).toBe('No se contratará a qa; el lead seguirá sin él.');
    expect(consequenceOf(hire, 'accept')).toContain('consume cuota');
    expect(consequenceOf(hire, undefined)).toContain('consume cuota');
    expect(consequenceOf(replyPlan('trust', { canReply: false }), 'reject')).toBe('El agente no podrá trabajar en esta carpeta.');
    expect(consequenceOf(replyPlan('bypass', { canReply: false }), 'reject')).toBe('El agente seguirá pidiendo permisos.');
  });
});
