import { Box, type BoxProps, type DOMElement, measureElement, useStdin } from 'ink';
import React, { createContext, useContext, useEffect, useRef } from 'react';

// Ink drops terminal mouse reports, so we enable SGR mouse tracking ourselves,
// parse stdin in parallel and hit-test against measured <Box> rectangles.
// 1002 = button-event tracking: motion is reported while a button is held (drag).

export const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
export const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1002l\x1b[?1006l';

// Selection mode (Alt+S) keeps mouse reporting off until it ends, whoever asks to turn it on.
let selecting = false;
/** Turns mouse reporting back on, unless selection mode is active. */
export const enableMouse = () => void (!selecting && process.stdout.write(ENABLE_MOUSE));
/** Enters or leaves selection mode (mouse reporting off / back on). */
export function setSelectionMode(on: boolean) {
  selecting = on;
  process.stdout.write(on ? DISABLE_MOUSE : ENABLE_MOUSE);
}
export const inSelectionMode = () => selecting;
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Pointer position relative to the region's top-left corner, plus its size. */
export type Pointer = { x: number; y: number; width: number; height: number };

type Region = {
  ref: React.RefObject<DOMElement | null>;
  onClick?: (p: Pointer) => void;
  onWheel?: (delta: number) => void;
  onDrag?: (p: Pointer) => void;
  seq: number;
  /** Mouse layer it belongs to (0 = the app; modals open higher ones). */
  layer: number;
};

const Ctx = createContext<{ register: (r: Region) => () => void; addLayer: (id: number) => () => void } | null>(null);
/** Layer of the Clickables below; set by <MouseLayer>. */
const LayerCtx = createContext(0);
let layerSeq = 0;

let seq = 0;

function pointer(r: Region, x: number, y: number): Pointer | undefined {
  if (!r.ref.current) return;
  const m = measureElement(r.ref.current);
  return { x: x - m.x, y: y - m.y, width: m.width, height: m.height };
}

export function MouseProvider({ children }: { children: React.ReactNode }) {
  const regions = useRef(new Set<Region>());
  const layers = useRef(new Set<number>());
  const dragging = useRef<Region | null>(null);
  const { stdin } = useStdin();

  useEffect(() => {
    enableMouse();
    const hit = (x: number, y: number, kind: 'click' | 'wheel') => {
      // While a modal layer is active only its regions count: clicks outside it go nowhere.
      const top = Math.max(0, ...layers.current);
      let best: { r: Region; area: number } | undefined;
      for (const r of regions.current) {
        if (!r.ref.current || r.layer !== top) continue;
        if (kind === 'click' ? !r.onClick && !r.onDrag : !r.onWheel) continue;
        const m = measureElement(r.ref.current);
        if (x < m.x || y < m.y || x >= m.x + m.width || y >= m.y + m.height) continue;
        const area = m.width * m.height;
        // Innermost (smallest) region wins; on ties the most recently mounted.
        if (!best || area < best.area || (area === best.area && r.seq > best.r.seq)) best = { r, area };
      }
      return best?.r;
    };
    const onData = (data: Buffer | string) => {
      for (const m of String(data).matchAll(SGR)) {
        const b = Number(m[1]);
        const x = Number(m[2]) - 1;
        const y = Number(m[3]) - 1;
        const press = m[4] === 'M';
        if (b === 64 || b === 65) {
          hit(x, y, 'wheel')?.onWheel?.(b === 64 ? -3 : 3);
        } else if (b & 32) {
          // motion with a button held: keep feeding the region that started the drag
          const r = dragging.current;
          const p = r && pointer(r, x, y);
          if (r && p) r.onDrag?.(p);
        } else if ((b & 3) === 0 && press) {
          const r = hit(x, y, 'click');
          const p = r && pointer(r, x, y);
          if (r && p) {
            if (r.onDrag) dragging.current = r;
            (r.onClick ?? r.onDrag)?.(p);
          }
        } else if (!press) {
          dragging.current = null;
        }
      }
    };
    stdin.on('data', onData);
    const off = () => process.stdout.write(DISABLE_MOUSE);
    process.on('exit', off);
    return () => {
      stdin.off('data', onData);
      process.off('exit', off);
      off();
    };
  }, [stdin]);

  const register = (r: Region) => {
    regions.current.add(r);
    return () => void regions.current.delete(r);
  };
  const addLayer = (id: number) => {
    layers.current.add(id);
    return () => void layers.current.delete(id);
  };
  return <Ctx.Provider value={{ register, addLayer }}>{children}</Ctx.Provider>;
}

/**
 * Mouse layer for a modal or overlay: while `active`, clicks and wheel reach only the
 * Clickables inside it (the topmost active layer wins).
 */
export function MouseLayer({ active = true, children }: { active?: boolean; children: React.ReactNode }) {
  const ctx = useContext(Ctx);
  const id = useRef(++layerSeq).current;
  useEffect(() => (active && ctx ? ctx.addLayer(id) : undefined), [ctx, active]);
  return <LayerCtx.Provider value={id}>{children}</LayerCtx.Provider>;
}

type ClickableProps = BoxProps & {
  onClick?: (p: Pointer) => void;
  onWheel?: (delta: number) => void;
  /** Called on press and on every motion while the button stays held. */
  onDrag?: (p: Pointer) => void;
  children?: React.ReactNode;
};

/** A <Box> that reacts to mouse clicks, wheel and drag. */
export function Clickable({ onClick, onWheel, onDrag, children, ...box }: ClickableProps) {
  const ref = useRef<DOMElement>(null);
  const ctx = useContext(Ctx);
  const layer = useContext(LayerCtx);
  const handlers = useRef({ onClick, onWheel, onDrag });
  handlers.current = { onClick, onWheel, onDrag };

  useEffect(() => {
    if (!ctx) return;
    return ctx.register({
      ref,
      onClick: onClick ? (p) => handlers.current.onClick?.(p) : undefined,
      onWheel: onWheel ? (d) => handlers.current.onWheel?.(d) : undefined,
      onDrag: onDrag ? (p) => handlers.current.onDrag?.(p) : undefined,
      seq: ++seq,
      layer,
    });
  }, [ctx, layer, !!onClick, !!onWheel, !!onDrag]);

  return (
    <Box ref={ref} {...box}>
      {children}
    </Box>
  );
}
