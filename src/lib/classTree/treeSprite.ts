/*
 * The class apple tree drawn in pixels (64×64). Every part has a fill and a darker outline of the
 * same hue, with four tones each (c highlight, b fill, d shade, a outline); light comes from the
 * top left. A cell holds a part letter plus a tone letter: L leaf, W wood, G grass, E earth,
 * R red apple, N green apple, F blossom, S seed; Xw white glint, Xy blossom centre, Xs sparkle.
 */

export const TREE_SIZE = 64;
export type TreeCells = ReadonlyArray<ReadonlyArray<string | null>>;
type Grid = Array<Array<string | null>>;
type Inside = (x: number, y: number) => boolean;

const W = TREE_SIZE, H = TREE_SIZE;

const PAIRS: Record<string, readonly [string, string]> = {
  L: ['#66bb6a', '#2e7d32'],
  W: ['#8d6e63', '#4e342e'],
  G: ['#9ccc65', '#558b2f'],
  E: ['#a1887f', '#6d4c41'],
  R: ['#ef5350', '#b71c1c'],
  N: ['#d4e157', '#827717'],
  F: ['#f8bbd0', '#ec407a'],
  S: ['#8d6e63', '#3e2723'],
};

function mix(from: string, to: string, t: number): string {
  const a = [1, 3, 5].map((i) => parseInt(from.slice(i, i + 2), 16));
  const b = [1, 3, 5].map((i) => parseInt(to.slice(i, i + 2), 16));
  return `#${a.map((value, i) => Math.round(value + (b[i] - value) * t).toString(16).padStart(2, '0')).join('')}`;
}

export const TREE_PALETTE: Readonly<Record<string, string>> = (() => {
  const palette: Record<string, string> = { Xw: '#ffffff', Xy: '#fff176', Xs: '#ffca28' };
  for (const [part, [fill, outline]] of Object.entries(PAIRS)) {
    palette[`${part}c`] = mix(fill, '#ffffff', 0.42);
    palette[`${part}b`] = fill;
    palette[`${part}d`] = mix(fill, outline, 0.45);
    palette[`${part}a`] = outline;
  }
  return palette;
})();

const blank = (): Grid => Array.from({ length: H }, () => new Array<string | null>(W).fill(null));
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
function hash(x: number, y: number, seed = 0): number {
  let h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 7, 668265263) ^ Math.imul(seed + 3, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const lit = (nx: number, ny: number) => nx * -0.6 + ny * -0.8;

function paintShape(g: Grid, part: string, inside: Inside, normal: (x: number, y: number) => readonly [number, number],
  opt: { y0?: number; hi?: number; lo?: number } = {}): void {
  const { y0 = 0, hi = 0.45, lo = -0.3 } = opt;
  for (let y = y0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!inside(x, y)) continue;
    if (N4.some(([dx, dy]) => !inside(x + dx, y + dy))) { g[y][x] = `${part}a`; continue; }
    const [nx, ny] = normal(x, y);
    const l = lit(nx, ny);
    g[y][x] = part + (l > hi ? 'c' : l < lo ? 'd' : 'b');
  }
}

/* Ground: a round grass bed with three rows of earth in front. */
const BED = { cx: 32, cy: 55, rx: 21.5, ry: 4.8 };
const onBed: Inside = (x, y) => ((x + 0.5 - BED.cx) / BED.rx) ** 2 + ((y + 0.5 - BED.cy) / BED.ry) ** 2 <= 1;
function ground(g: Grid): void {
  const soil: Inside = (x, y) => !onBed(x, y) && (onBed(x, y - 1) || onBed(x, y - 2) || onBed(x, y - 3));
  const any: Inside = (x, y) => onBed(x, y) || soil(x, y);
  for (let y = 40; y < H; y++) for (let x = 0; x < W; x++) {
    if (!soil(x, y)) continue;
    const edge = N4.some(([dx, dy]) => !any(x + dx, y + dy));
    const nx = (x + 0.5 - BED.cx) / BED.rx;
    let tone = edge ? 'a' : nx > 0.5 || !soil(x, y + 1) ? 'd' : 'b';
    if (!edge && tone === 'b' && hash(x, y, 5) < 0.12) tone = 'd';
    g[y][x] = `E${tone}`;
  }
  paintShape(g, 'G', onBed, (x, y) => [(x + 0.5 - BED.cx) / BED.rx, (y + 0.5 - BED.cy) / BED.ry], { y0: 40, hi: 0.5, lo: -0.45 });
  for (const [x, y] of [[17, 54], [23, 57], [44, 54], [40, 57], [28, 57], [13, 56], [49, 56], [35, 58]]) {
    for (const [dx, dy] of [[0, 0], [1, 1], [2, 0]]) {
      const cell = g[y + dy]?.[x + dx];
      if (cell && cell[0] === 'G' && cell !== 'Ga') g[y + dy][x + dx] = 'Gd';
    }
  }
}

type Segment = readonly [number, number, number, number, number, number];
/* Trunk and branches: tapered sticks. */
function wood(g: Grid, segments: readonly Segment[]): void {
  const inside: Inside = (x, y) => segments.some(([ax, ay, bx, by, ra, rb]) => {
    const px = x + 0.5, py = y + 0.5, vx = bx - ax, vy = by - ay, length2 = vx * vx + vy * vy;
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / length2));
    return Math.hypot(px - ax - vx * t, py - ay - vy * t) <= ra + (rb - ra) * t;
  });
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!inside(x, y)) continue;
    if (N4.some(([dx, dy]) => !inside(x + dx, y + dy))) { g[y][x] = 'Wa'; continue; }
    let left = x, right = x;
    while (inside(left - 1, y)) left--;
    while (inside(right + 1, y)) right++;
    const width = right - left + 1;
    let tone = x === left + 1 && width >= 4 ? 'c' : x === right - 1 ? 'd' : 'b';
    if (tone === 'b' && width >= 6 && hash(x, Math.floor(y / 3), 9) < 0.18) tone = 'd';
    g[y][x] = `W${tone}`;
  }
}

/* One leaf from its base to its tip. */
function leaf(g: Grid, bx: number, by: number, tx: number, ty: number, width: number, round: number): void {
  const vx = tx - bx, vy = ty - by, length = Math.hypot(vx, vy), ux = vx / length, uy = vy / length;
  const at = (x: number, y: number) => { const px = x + 0.5 - bx, py = y + 0.5 - by; return [(px * ux + py * uy) / length, px * -uy + py * ux] as const; };
  const half = (t: number) => width * Math.pow(Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, t)))), round);
  const inside: Inside = (x, y) => { const [t, s] = at(x, y); return t >= 0 && t <= 1 && Math.abs(s) <= half(t); };
  paintShape(g, 'L', inside, (x, y) => { const [t, s] = at(x, y); const k = s / Math.max(half(t), 0.5); return [-uy * k, ux * k]; }, { hi: 0.35, lo: -0.35 });
}

type Clump = readonly [number, number, number];
/* Round leaf clumps; lower clumps sit in front, their upper rims shaded against the ones behind. */
function canopy(g: Grid, clumps: readonly Clump[], under = 4): Inside {
  const list = [...clumps].sort((a, b) => a[1] - b[1]);
  const owner: Array<Array<number | null>> = Array.from({ length: H }, () => new Array<number | null>(W).fill(null));
  list.forEach(([cx, cy, r], index) => {
    for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      if (inb(x, y) && Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) owner[y][x] = index;
    }
  });
  const inside: Inside = (x, y) => inb(x, y) && owner[y][x] !== null;
  let bottom = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(x, y)) bottom = y;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!inside(x, y)) continue;
    if (N4.some(([dx, dy]) => !inside(x + dx, y + dy))) { g[y][x] = 'La'; continue; }
    const index = owner[y][x] as number;
    const [cx, cy, r] = list[index];
    const nx = (x + 0.5 - cx) / r, ny = (y + 0.5 - cy) / r, d = Math.hypot(nx, ny), l = lit(nx, ny);
    let tone = l > 0.5 && d > 0.4 && d < 0.9 ? 'c' : l < -0.3 ? 'd' : 'b';
    const behind = N4.some(([dx, dy]) => inside(x + dx, y + dy) && (owner[y + dy][x + dx] as number) < index);
    if (behind && ny < 0.25) tone = 'd';
    if (y > bottom - under && tone !== 'd') tone = tone === 'c' ? 'b' : 'd';
    if (tone === 'b' && l > 0.15 && hash(x, y, 1) < 0.05) tone = 'c';
    if (tone === 'b' && l < -0.05 && hash(x, y, 2) < 0.09) tone = 'd';
    g[y][x] = `L${tone}`;
  }
  return inside;
}

function stamp(g: Grid, x0: number, y0: number, rows: readonly string[], map: Readonly<Record<string, string>>): void {
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => {
    if (ch !== '.' && inb(x0 + dx, y0 + dy)) g[y0 + dy][x0 + dx] = map[ch];
  }));
}
const APPLE = ['.T..', 'awba', 'abda', '.aa.'];
const FLOWER = ['.p.', 'pyp', '.p.'];
const BUD = ['pq', 'qq'];
const SPARKLES = [[3, 6, 1], [55, 2, 1], [59, 16, 0], [1, 19, 0], [60, 41, 1], [4, 45, 0]] as const;

/* Evenly spread places inside the canopy; any first n of them are spread too (farthest first). */
function spots(inside: Inside, w: number, h: number, count: number, seed: number): Array<readonly [number, number]> {
  const fits = (x: number, y: number) => {
    for (let dy = -1; dy <= h; dy++) for (let dx = -1; dx <= w; dx++) if (!inside(x + dx, y + dy)) return false;
    return true;
  };
  const candidates: Array<readonly [number, number]> = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fits(x, y)) candidates.push([x, y]);
  if (candidates.length === 0) return [];
  const first = candidates.reduce((best, c) => (hash(c[0], c[1], seed) > hash(best[0], best[1], seed) ? c : best));
  const out = [first];
  const distance = candidates.map(([x, y]) => Math.hypot(x - first[0], (y - first[1]) * 1.15));
  while (out.length < count) {
    let bestIndex = -1, bestValue = -1;
    candidates.forEach((c, i) => { const v = distance[i] + hash(c[0], c[1], seed + 1) * 0.8; if (v > bestValue) { bestValue = v; bestIndex = i; } });
    if (bestIndex < 0 || distance[bestIndex] < 1) break;
    const p = candidates[bestIndex];
    out.push(p);
    candidates.forEach(([x, y], i) => { distance[i] = Math.min(distance[i], Math.hypot(x - p[0], (y - p[1]) * 1.15)); });
  }
  return out;
}

const BIG: readonly Clump[] = [[32, 12, 9], [22, 15, 8], [42, 15, 8], [14, 24, 7.5], [27, 22, 9], [38, 22, 9], [50, 25, 7], [20, 31, 8], [32, 32, 8.5], [44, 31, 8], [10, 31, 5], [54, 31, 5]];
const BIG_WOOD: readonly Segment[] = [[32, 56, 32, 38, 5, 3.2], [32, 44, 24, 33, 2.4, 1.5], [32, 42, 41, 32, 2.2, 1.5], [32, 56, 26, 57.5, 2.2, 1], [32, 56, 38, 57.5, 2.2, 1]];
export const MAX_TREE_APPLES = 40;

export type TreeDrawOptions = Readonly<{ apples?: number; ripe?: number; flowers?: number; done?: boolean; noApples?: boolean }>;

/** The tree at `stage` (0 seed … 7 fruit). */
export function drawClassTree(stage: number, options: TreeDrawOptions = {}): TreeCells {
  const g = blank();
  ground(g);
  if (stage === 0) {
    stamp(g, 26, 52, ['..aaaaaaaa..', '.addddddddda', '..aaaaaaaa..'], { a: 'Ea', d: 'Ed' });
    stamp(g, 29, 48, ['..aa.', '.acba', 'acbba', 'abbda', '.aaa.'], { a: 'Sa', b: 'Sb', c: 'Sc', d: 'Sd' });
    stamp(g, 35, 44, ['..w..', '..w..', 'ww.ww', '..w..', '..w..'], { w: 'Xs' });
  } else if (stage === 1) {
    for (let y = 48; y <= 55; y++) { g[y][31] = 'Lb'; g[y][32] = 'Ld'; }
    leaf(g, 31.8, 48.5, 24.5, 45, 3.1, 0.35);
    leaf(g, 32.2, 48.5, 39.5, 45, 3.1, 0.35);
  } else if (stage === 2) {
    for (let y = 40; y <= 55; y++) { g[y][31] = 'Lb'; g[y][32] = 'Ld'; }
    leaf(g, 31.8, 50.5, 24, 47.5, 3, 0.35);
    leaf(g, 32.2, 50.5, 40, 47.5, 3, 0.35);
    leaf(g, 31.8, 44.5, 23.5, 40, 3.2, 0.6);
    leaf(g, 32.2, 42.5, 40.5, 38, 3.2, 0.6);
    leaf(g, 32, 41, 31.5, 31.5, 2.8, 0.6);
  } else if (stage === 3) {
    wood(g, [[32, 56, 32, 34, 2.1, 1.6], [32, 56, 29.5, 57, 1.2, 0.8], [32, 56, 34.5, 57, 1.2, 0.8]]);
    leaf(g, 31, 46.5, 24.5, 43, 2.4, 0.8);
    leaf(g, 33, 44.5, 39.5, 41, 2.4, 0.8);
    canopy(g, [[32, 27, 7], [25.5, 32, 5.5], [38.5, 32, 5.5], [32, 34, 5]], 2);
  } else if (stage === 4) {
    wood(g, [[32, 56, 32, 32, 2.6, 1.8], [32, 44, 25, 34, 1.4, 1], [32, 42, 40, 33, 1.3, 1], [32, 56, 28, 57, 1.4, 0.8], [32, 56, 36, 57, 1.4, 0.8]]);
    canopy(g, [[32, 21, 8], [23, 26, 7], [41, 26, 7], [27, 32, 6.5], [37, 32, 6.5], [18, 32, 4.5], [46, 32, 4.5]], 3);
  } else {
    wood(g, BIG_WOOD);
    for (let y = 50; y < 60; y++) for (let x = 0; x < W; x++) {
      const cell = g[y][x];
      if (cell && cell[0] === 'G' && cell !== 'Ga' && ((x + 0.5 - 32) / 15) ** 2 + ((y + 0.5 - 55.5) / 2.6) ** 2 <= 1) g[y][x] = 'Gd';
    }
    const inside = canopy(g, BIG);
    if (stage === 6) {
      spots(inside, 3, 3, options.flowers ?? 34, 11).forEach(([x, y], i) => (i % 4 === 3
        ? stamp(g, x, y, BUD, { p: 'Fb', q: 'Fd' })
        : stamp(g, x, y, FLOWER, { p: i % 3 ? 'Fb' : 'Fc', y: 'Xy' })));
      for (const [x, y] of [[8, 42], [55, 40], [14, 47], [50, 46], [4, 37]]) g[y][x] = 'Fb';
    }
    if (stage >= 7 && !options.noApples) {
      const count = Math.max(1, Math.min(MAX_TREE_APPLES, options.apples ?? 25));
      const ripe = Math.min(count, options.ripe ?? count);
      const places = spots(inside, 4, 4, count, 3);
      const order = places.map((p, i) => [hash(p[0], p[1], 21), i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
      const red = new Set(order.slice(0, ripe));
      places.forEach(([x, y], i) => {
        const part = red.has(i) ? 'R' : 'N';
        stamp(g, x, y, APPLE, { T: 'Wa', a: `${part}a`, b: `${part}b`, d: `${part}d`, w: red.has(i) ? 'Xw' : `${part}c` });
      });
      if (options.done) for (const [x, y, big] of SPARKLES) {
        stamp(g, x, y, big ? ['..s..', '..s..', 'ss.ss', '..s..', '..s..'] : ['.s.', 's.s', '.s.'], { s: 'Xs' });
      }
    }
  }
  return g;
}

/** Where the apples of a full tree hang (for the harvest animation), the same places drawClassTree uses. */
export function treeApplePlaces(apples: number): Array<readonly [number, number]> {
  return spots(canopy(blank(), BIG), 4, 4, Math.max(1, Math.min(MAX_TREE_APPLES, apples)), 3);
}
