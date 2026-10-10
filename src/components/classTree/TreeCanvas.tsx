'use client';

import { useEffect, useMemo, useRef } from 'react';
import { CLASS_TREE_STAGES, classTreeLook } from '@/domain/classTree';
import { TREE_ANIMATIONS, TREE_ANIMATION_FPS, TREE_ANIMATION_PALETTE, type TreeAnimationInfo, type TreeAnimationKind } from '@/lib/classTree/treeAnimation';
import { TREE_PALETTE, TREE_SIZE, drawClassTree, treeApplePlaces, type TreeCells } from '@/lib/classTree/treeSprite';

/** An animation to play once; a new `key` starts it again. */
export type TreePlay = Readonly<{
  key: number;
  /** feed: a student's 양분 주기, classFeed: the teacher's, harvest: the full tree was harvested. */
  kind: 'feed' | 'classFeed' | 'harvest';
  /** The tree before the change: before the nutrient, or the full tree that was harvested. */
  before: Readonly<{ drops: number; goal: number; apples: number }>;
  amount: number;
}>;

type TreeCanvasProps = Readonly<{
  drops: number;
  goal: number;
  /** One apple per active student. */
  apples: number;
  /** Shown size in CSS pixels; the 64×64 picture is scaled up without smoothing. */
  size: number;
  className?: string;
  play?: TreePlay | null;
  onPlayEnd?: () => void;
  /** The class's name for its tree, read out with the picture. */
  name?: string;
}>;

type Scene = Readonly<{ kind: TreeAnimationKind; cells: TreeCells; info: TreeAnimationInfo }>;
const PALETTE: Readonly<Record<string, string>> = { ...TREE_PALETTE, ...TREE_ANIMATION_PALETTE };

function cellsFor(drops: number, goal: number, apples: number): TreeCells {
  const look = classTreeLook(drops, goal, apples);
  return drawClassTree(look.stage, { apples, ripe: look.ripe, flowers: look.flowers, done: look.ready });
}

function paint(context: CanvasRenderingContext2D, cells: TreeCells, overlay: ReadonlyArray<readonly [number, number, string]> = []): void {
  context.clearRect(0, 0, TREE_SIZE, TREE_SIZE);
  cells.forEach((row, y) => row.forEach((cell, x) => {
    if (!cell) return;
    context.fillStyle = PALETTE[cell];
    context.fillRect(x, y, 1, 1);
  }));
  for (const [x, y, cell] of overlay) {
    if (x < 0 || y < 0 || x >= TREE_SIZE || y >= TREE_SIZE) continue;
    context.fillStyle = PALETTE[cell];
    context.fillRect(x, y, 1, 1);
  }
}

/** The class apple tree in pixels, at the stage its 양분 reach; can play a short animation. */
export function TreeCanvas({ drops, goal, apples, size, className, play, onPlayEnd, name = '학급 나무' }: TreeCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const playing = useRef<{ timer: number; finish: () => void } | null>(null);
  const look = classTreeLook(drops, goal, apples);
  const cells = useMemo(() => cellsFor(drops, goal, apples), [apples, drops, goal]);
  const latest = useRef({ cells, onPlayEnd });
  useEffect(() => { latest.current = { cells, onPlayEnd }; });

  useEffect(() => {
    const context = ref.current?.getContext('2d');
    if (context && !playing.current) paint(context, cells);
  }, [cells]);

  const playKey = play?.key;
  useEffect(() => {
    if (!play) return;
    const context = ref.current?.getContext('2d');
    if (!context) return;
    const finish = () => {
      if (!playing.current) return;
      window.clearTimeout(playing.current.timer);
      playing.current = null;
      paint(context, latest.current.cells);
      latest.current.onPlayEnd?.();
    };
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { latest.current.onPlayEnd?.(); return; }
    const after = classTreeLook(drops, goal, apples);
    const scenes: Scene[] = [];
    if (play.kind === 'harvest') {
      scenes.push({ kind: 'harvest', cells: drawClassTree(7, { noApples: true }), info: { stage: 7, applePlaces: treeApplePlaces(play.before.apples) } });
      scenes.push({ kind: 'grow', cells: latest.current.cells, info: { stage: after.stage } });
    } else {
      const before = classTreeLook(play.before.drops, play.before.goal, play.before.apples);
      scenes.push({ kind: 'feed', cells: cellsFor(play.before.drops, play.before.goal, play.before.apples),
        info: { stage: before.stage, amount: play.amount, big: play.kind === 'classFeed' } });
      if (after.stage !== before.stage) scenes.push({ kind: 'grow', cells: latest.current.cells, info: { stage: after.stage } });
    }
    let scene = 0, frame = 0;
    playing.current = { timer: 0, finish };
    const tick = () => {
      if (!playing.current) return;
      while (scene < scenes.length && frame >= TREE_ANIMATIONS[scenes[scene].kind][0]) { scene += 1; frame = 0; }
      if (scene >= scenes.length) { finish(); return; }
      const current = scenes[scene];
      paint(context, current.cells, TREE_ANIMATIONS[current.kind][1](frame, current.info, current.cells));
      frame += 1;
      playing.current.timer = window.setTimeout(tick, 1000 / TREE_ANIMATION_FPS);
    };
    tick();
    return () => { if (playing.current) { window.clearTimeout(playing.current.timer); playing.current = null; paint(context, latest.current.cells); } };
    // The animation starts only for a new play key; drops/goal/apples are read as they are at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playKey]);

  const label = `${name}, ${CLASS_TREE_STAGES[look.stage]} 단계${look.ready ? ', 수확할 수 있어요' : ''}`;
  return (
    <canvas ref={ref} width={TREE_SIZE} height={TREE_SIZE} role="img" aria-label={label} className={className}
      onClick={() => playing.current?.finish()}
      style={{ width: size, maxWidth: '100%', height: 'auto', aspectRatio: '1 / 1', imageRendering: 'pixelated' }} />
  );
}

/** 양분 as a share of the goal, for progress bars (0–100). */
export function treePercent(drops: number, goal: number): number {
  return goal > 0 ? Math.min(100, Math.max(0, Math.floor((drops / goal) * 100))) : 0;
}
