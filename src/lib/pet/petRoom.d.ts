import type PETS from './petSprites';

export type PetRoomDecor = Readonly<Record<'wall' | 'rug' | 'bed' | 'plant' | 'frame' | 'toy', string>>;

/** One animal in the room (the pet being raised, or a graduated one keeping it company). */
export type PetRoomPetInit = Readonly<{ id: string; species: string; color: string | null; stage: number; accessory?: string | null }>;

export type PetRoomPetState = {
  id: string;
  species: string;
  color: string | null;
  stage: number;
  acc: string | null;
  x: number;
  y: number;
  dir: number;
  action: string;
  emote: string | null;
  needs: { hunger: number; energy: number; fun: number };
  sleepReason: 'tired' | 'off' | null;
};

export type PetRoomState = {
  /** Kibble left in the bowl (3 per animal when full). */
  food: number;
  /** Speed of the needs (1 in the sample page). */
  rate: number;
  decor: PetRoomDecor;
  offHours: boolean;
};

/** What the animals saved between visits: how rested and how happy they were, and the ball games played lately. */
export type PetRoomSnapshot = Readonly<{ energy: number; fun: number; asleep: boolean; plays: ReadonlyArray<number>; boredUntil: number }>;

export type PetRoom = Readonly<{
  state: PetRoomState;
  pets: ReadonlyArray<Readonly<{ s: PetRoomPetState }>>;
  /** One frame (12 fps). */
  tick(): void;
  /** The room as 80×48 colors; `accessories` tries accessories on (pet id → accessory id, null for none). */
  render(opt?: Readonly<{ decor?: Partial<PetRoomDecor>; noPet?: boolean; accessories?: Readonly<Record<string, string | null>> }>): string[][];
  actions: Readonly<{
    feed(): void;
    warm(): void;
    play(): Readonly<{ played: number; tired: number; bored: number; asleep: number }>;
    pat(): Readonly<{ petted: number; asleep: number }>;
    setPets(pets: ReadonlyArray<PetRoomPetInit>): void;
    setOffHours(on: boolean): void;
    setDecor(decor: Partial<PetRoomDecor>): void;
    restore(id: string, o: Readonly<{ hunger?: number; energy?: number; fun?: number; asleep?: boolean; plays?: ReadonlyArray<number>; boredUntil?: number }>): void;
    snapshot(id: string): PetRoomSnapshot | null;
    moods(): ReadonlyArray<Readonly<{ id: string; mood: string }>>;
    sleepInfo(): Readonly<{ reason: 'tired' | 'off'; framesLeft: number | null }> | null;
    awakeCount(): number;
    readiness(): Readonly<{ awake: number; ready: number; tired: number; bored: number; boredMinutes: number }>;
  }>;
  W: number;
  H: number;
}>;

declare const ROOM: Readonly<{
  W: number;
  H: number;
  create(P: typeof PETS, init: Readonly<{ pets?: ReadonlyArray<PetRoomPetInit>; decor?: Partial<PetRoomDecor> }>): PetRoom;
  ICONS: Readonly<Record<string, ReadonlyArray<string>>>;
  ICON_KEY: Readonly<Record<string, string>>;
  BUBBLE: ReadonlyArray<string>;
  EMOTES: Readonly<Record<string, string>>;
  GAITS: Readonly<Record<string, Readonly<{ label: string }>>>;
  DECOR_CROP: Readonly<Record<string, readonly [number, number, number, number]>>;
}>;

export default ROOM;
