'use client';

import { useEffect, useRef } from 'react';
import PETS, { type PetGrid } from '@/lib/pet/petSprites';

type PetPictureProps = Readonly<{
  species: string;
  stage: number;
  color: string | null;
  /** An accessory the pet wears (ignored for an egg). */
  accessory?: string | null;
  /** Shown width in CSS pixels; the cells are scaled up without smoothing. */
  size: number;
  /** Play the idle animation (blinks, tail, habits) at 12 fps. */
  animate?: boolean;
  /** Draw a grey shape only (a 도감 cell not collected yet). */
  silhouette?: boolean;
  /** Part of the 24×24 picture to show [x, y, width, height], e.g. to show an egg larger. */
  crop?: readonly [number, number, number, number];
  label?: string;
  className?: string;
}>;

const SILHOUETTE = 'rgba(128, 116, 104, 0.38)';

function paint(canvas: HTMLCanvasElement, grid: PetGrid, crop: readonly [number, number, number, number], silhouette: boolean): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const [x0, y0, w, h] = crop;
  context.clearRect(0, 0, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cell = grid[y0 + y]?.[x0 + x];
      if (!cell) continue;
      context.fillStyle = silhouette ? SILHOUETTE : cell;
      context.fillRect(x, y, 1, 1);
    }
  }
}

/** One pet in pixels: a still picture, or its idle animation. */
export function PetPicture({ species, stage, color, accessory = null, size, animate = false, silhouette = false, crop, label, className }: PetPictureProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const area = crop ?? [0, 0, PETS.W, PETS.H] as const;
  const [x0, y0, w, h] = area;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const box = [x0, y0, w, h] as const;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const acc = silhouette ? null : accessory;
    if (!animate || reduce || silhouette) {
      paint(canvas, PETS.draw(species, stage, color, { acc }), box, silhouette);
      return;
    }
    let frame = 0;
    paint(canvas, PETS.scene(species, stage, color, 'idle', frame, { acc }), box, false);
    const timer = window.setInterval(() => {
      frame += 1;
      paint(canvas, PETS.scene(species, stage, color, 'idle', frame, { acc }), box, false);
    }, 1000 / 12);
    return () => window.clearInterval(timer);
  }, [accessory, animate, color, h, silhouette, species, stage, w, x0, y0]);

  return (
    <canvas ref={ref} width={w} height={h} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}
      className={className} style={{ width: size, maxWidth: '100%', height: 'auto', aspectRatio: `${w} / ${h}`, imageRendering: 'pixelated' }} />
  );
}
