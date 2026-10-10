/** One picture: 24×24 cells, each a CSS color or null (transparent). */
export type PetGrid = Array<Array<string | null>>;

export type PetDrawOptions = Readonly<{
  pose?: 'sit' | 'sleep' | 'walk';
  closed?: boolean;
  happy?: boolean;
  dx?: number;
  dy?: number;
  wag?: number;
  awake?: boolean;
  step?: number;
  noPerch?: boolean;
  yawn?: boolean;
  puff?: boolean;
  flap?: boolean;
  sniff?: boolean;
  tongue?: boolean;
  twitch?: boolean;
  /** An accessory to wear (ribbon, flower, crown, pearl, bell, bowtie, scarf). */
  acc?: string | null;
}>;

export type PetPalette = Readonly<Record<string, string>> & Readonly<{ id: string; name: string }>;

declare const PETS: Readonly<{
  W: number;
  H: number;
  COLORS: Readonly<Record<string, ReadonlyArray<PetPalette>>>;
  STAGES: ReadonlyArray<Readonly<{ id: string; name: string }>>;
  ACTIONS: Readonly<Record<string, number>>;
  /** Accessory ids the pictures can draw. */
  ACCESSORIES: ReadonlyArray<string>;
  /** A still picture; `colorId` is ignored for an egg (stage 0). */
  draw(species: string, stage: number, colorId: string | null | undefined, opt?: PetDrawOptions): PetGrid;
  /** Frame `f` (12 fps) of an animation: idle, sleep, pet, feed, hatch, grow. */
  scene(species: string, stage: number, color: string | null | undefined, action: string, f: number, o?: Readonly<{ to?: number; noPerch?: boolean; acc?: string | null }>): PetGrid;
}>;

export default PETS;
