'use client';

import { useEffect, useRef } from 'react';
import type { PetRoom, PetRoomDecor } from '@/lib/pet/petRoom';

type PetRoomCanvasProps = Readonly<{
  room: PetRoom;
  /** Whether the pet moves (12 fps). When false the room is drawn once per change. */
  running: boolean;
  /** A decor item tried on in the 꾸미기/상점, drawn instead of the placed one. */
  previewDecor?: Partial<PetRoomDecor> | null;
  /** Accessories tried on in the 꾸미기/상점 (pet id → accessory id, null for none). */
  previewAccessories?: Readonly<Record<string, string | null>> | null;
  /** Called every few frames so the screen can update what the pet is doing. */
  onFrame?: () => void;
  /** Bumped by the parent to redraw a paused room after an action. */
  redrawKey?: number;
  label: string;
}>;

const FPS = 12;
const rgbCache = new Map<string, readonly [number, number, number]>();
function rgb(hex: string): readonly [number, number, number] {
  let value = rgbCache.get(hex);
  if (!value) {
    value = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] as const;
    rgbCache.set(hex, value);
  }
  return value;
}

type Preview = Readonly<{ previewDecor?: Partial<PetRoomDecor> | null; previewAccessories?: Readonly<Record<string, string | null>> | null }>;

function paint(canvas: HTMLCanvasElement, room: PetRoom, preview: Preview): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const cells = room.render({ decor: preview.previewDecor ?? undefined, accessories: preview.previewAccessories ?? undefined });
  const image = context.createImageData(room.W, room.H);
  for (let y = 0; y < room.H; y++) {
    for (let x = 0; x < room.W; x++) {
      const [r, g, b] = rgb(cells[y][x]);
      const i = (y * room.W + x) * 4;
      image.data[i] = r; image.data[i + 1] = g; image.data[i + 2] = b; image.data[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}

/** The pets' room: they walk about, eat, play and sleep on their own. The room is only watched, never touched. */
export function PetRoomCanvas({ room, running, previewDecor, previewAccessories, onFrame, redrawKey, label }: PetRoomCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ previewDecor, previewAccessories, onFrame });
  useEffect(() => { latest.current = { previewDecor, previewAccessories, onFrame }; });

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    paint(canvas, room, latest.current);
    if (!running) return;
    let handle = 0, last = 0, frames = 0;
    const loop = (time: number) => {
      handle = window.requestAnimationFrame(loop);
      if (time - last < 1000 / FPS) return;
      last = time;
      room.tick();
      paint(canvas, room, latest.current);
      frames += 1;
      if (frames % 4 === 0) latest.current.onFrame?.();
    };
    handle = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(handle);
  }, [room, running]);

  // A paused room still shows what changed (an action, a tried-on item).
  useEffect(() => {
    const canvas = ref.current;
    if (canvas && !running) paint(canvas, room, { previewDecor, previewAccessories });
  }, [previewAccessories, previewDecor, redrawKey, room, running]);

  return (
    <canvas ref={ref} width={room.W} height={room.H} role="img" aria-label={label}
      className="block w-full select-none rounded-[18px]"
      style={{ aspectRatio: `${room.W} / ${room.H}`, imageRendering: 'pixelated' }} />
  );
}

/** One decor item as the 꾸미기/상점 shows it: the room with that item, cropped to it. */
export function DecorPreview({ room, slot, id, crop, size }: Readonly<{
  room: PetRoom; slot: keyof PetRoomDecor; id: string; crop: readonly [number, number, number, number]; size: number;
}>) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [x0, y0, w, h] = crop;
  useEffect(() => {
    const context = ref.current?.getContext('2d');
    if (!context) return;
    const cells = room.render({ noPet: true, decor: { [slot]: id } });
    const image = context.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b] = rgb(cells[y0 + y][x0 + x]);
        const i = (y * w + x) * 4;
        image.data[i] = r; image.data[i + 1] = g; image.data[i + 2] = b; image.data[i + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }, [h, id, room, slot, w, x0, y0]);
  return (
    <canvas ref={ref} width={w} height={h} aria-hidden="true" className="rounded-[10px]"
      style={{ width: size, maxWidth: '100%', height: 'auto', aspectRatio: `${w} / ${h}`, imageRendering: 'pixelated' }} />
  );
}
