import { describe, expect, test } from 'bun:test';
import { MINI, STATE_ORDER, WALK_MS, builtinAnim, defaultLook, lastOutAt, miniRows, spriteRows, stateFor } from './sprites.ts';
import { SPRITE_STATE_ES } from './theme.ts';

describe('walk cycle', () => {
  const walk = builtinAnim('walking');

  test('4 distinct frames, same size, 6-8 fps', () => {
    expect(walk.frames).toHaveLength(4);
    expect(new Set(walk.frames.map((f) => f.join('\n'))).size).toBe(4);
    for (const f of walk.frames) {
      expect(f).toHaveLength(14);
      for (const row of f) expect(row).toHaveLength(12);
    }
    expect(walk.fps).toBeGreaterThanOrEqual(6);
    expect(walk.fps).toBeLessThanOrEqual(8);
  });

  test('passing frames drop the body 1 px; feet stay on the ground row', () => {
    expect(walk.dy).toEqual([0, 1, 0, 1]);
    walk.frames.forEach((f, i) => {
      expect(f[walk.dy![i]!]).toBe('....HHHH....'); // top of the head
      expect(f.at(-1)).toMatch(/K/); // a shoe touches the ground in every frame
    });
  });

  test('contact frames mirror each other (left/right legs alternate)', () => {
    const [l, , r] = walk.frames;
    expect(l!.slice(-3)).not.toEqual(r!.slice(-3));
  });

  test('every built-in state has the same canvas (7 terminal rows)', () => {
    for (const st of STATE_ORDER) for (const f of builtinAnim(st).frames) expect(f).toHaveLength(14);
    const look = defaultLook('x', 'cyan', 'headset');
    for (const st of STATE_ORDER) for (let t = 0; t < 20; t++) expect(spriteRows('no-such-role', look, st, t)).toHaveLength(7);
    for (let t = 0; t < 20; t++) expect(spriteRows('no-such-role', look, 'walking', t, 'xl')).toHaveLength(14);
  });

  test('walking is in the previews and has a Spanish name', () => {
    expect(STATE_ORDER).toContain('walking');
    expect(SPRITE_STATE_ES.walking).toBe('caminando');
  });
});

describe('stateFor', () => {
  const now = 1_000_000;
  test('walks for WALK_MS after sending a message', () => {
    expect(stateFor('working', false, now - 500, now)).toBe('walking');
    expect(stateFor('idle', false, now - WALK_MS, now)).toBe('idle');
    expect(stateFor('working', false, undefined, now)).toBe('working');
  });
  test('errors, stopped and starting win over walking', () => {
    expect(stateFor('error', false, now, now)).toBe('error');
    expect(stateFor('stopped', false, now, now)).toBe('sleeping');
    expect(stateFor('starting', false, now, now)).toBe('starting');
  });
  test('lastOutAt reads the latest msg_out of the timeline', () => {
    expect(lastOutAt({ timeline: [{ ts: 1, kind: 'msg_out' }, { ts: 2, kind: 'msg_in' }, { ts: 3, kind: 'msg_out' }, { ts: 4, kind: 'tool' }] })).toBe(3);
    expect(lastOutAt({ timeline: [] })).toBeUndefined();
  });
});

describe('mini step', () => {
  const look = defaultLook('x', 'cyan');
  test('alternates the feet on the bottom rows only', () => {
    expect(MINI).toHaveLength(4);
    for (const f of MINI) expect(f.slice(0, 6)).toEqual(MINI[0]!.slice(0, 6));
    expect(MINI[0]!.slice(6)).not.toEqual(MINI[2]!.slice(6));
  });
  test('steps only while walking/working when a state is given', () => {
    expect(miniRows(look, 0, 'normal', 'idle')).toEqual(miniRows(look, 3, 'normal', 'idle'));
    expect(miniRows(look, 0, 'normal', 'walking')).not.toEqual(miniRows(look, 3, 'normal', 'walking'));
  });
});

test('ORQ_REDUCED_MOTION: walking shows one still standing frame', () => {
  const look = defaultLook('x', 'cyan');
  const prev = process.env.ORQ_REDUCED_MOTION;
  process.env.ORQ_REDUCED_MOTION = '1';
  try {
    const frames = new Set(Array.from({ length: 20 }, (_, t) => spriteRows('no-such-role', look, 'walking', t).join('\n')));
    expect(frames.size).toBe(1);
    expect([...frames][0]).toBe(spriteRows('no-such-role', look, 'idle', 0).join('\n'));
    expect(miniRows(look, 0, 'normal', 'walking')).toEqual(miniRows(look, 3, 'normal', 'walking'));
  } finally {
    if (prev === undefined) delete process.env.ORQ_REDUCED_MOTION;
    else process.env.ORQ_REDUCED_MOTION = prev;
  }
});
