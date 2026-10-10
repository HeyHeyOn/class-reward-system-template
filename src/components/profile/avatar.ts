// Teacher profile icon model. Pure data + validation: no React, no 'use client',
// because server code imports it to validate stored/submitted avatars.

export type AvatarConfig = Readonly<{
  v: 1;
  background: string;
  face: string;
  eyes: string;
  mouth: string;
  accessory: string;
}>;

export type AvatarPartKey = 'background' | 'face' | 'eyes' | 'mouth' | 'accessory';
export type AvatarOption = Readonly<{ id: string; label: string }>;

export const AVATAR_PART_KEYS: ReadonlyArray<AvatarPartKey> = ['background', 'face', 'eyes', 'mouth', 'accessory'];

export const AVATAR_PART_LABELS: Readonly<Record<AvatarPartKey, string>> = {
  background: '배경색',
  face: '얼굴',
  eyes: '눈',
  mouth: '입',
  accessory: '꾸미기',
};

export const AVATAR_PARTS: Readonly<Record<AvatarPartKey, ReadonlyArray<AvatarOption>>> = {
  background: [
    { id: 'sky', label: '하늘' },
    { id: 'pink', label: '분홍' },
    { id: 'mint', label: '민트' },
    { id: 'yellow', label: '노랑' },
    { id: 'lavender', label: '보라' },
    { id: 'peach', label: '살구' },
    { id: 'lime', label: '연두' },
    { id: 'gray', label: '회색' },
    { id: 'navy', label: '남색' },
    { id: 'orange', label: '주황' },
  ],
  face: [
    { id: 'skin-light', label: '밝은 피부' },
    { id: 'skin-medium', label: '중간 피부' },
    { id: 'skin-dark', label: '어두운 피부' },
    { id: 'bear', label: '곰' },
    { id: 'cat', label: '고양이' },
    { id: 'rabbit', label: '토끼' },
    { id: 'dog', label: '강아지' },
    { id: 'penguin', label: '펭귄' },
  ],
  eyes: [
    { id: 'basic', label: '기본' },
    { id: 'happy', label: '웃는 눈' },
    { id: 'sparkle', label: '반짝 눈' },
    { id: 'sleepy', label: '졸린 눈' },
    { id: 'wink', label: '윙크' },
  ],
  mouth: [
    { id: 'smile', label: '미소' },
    { id: 'grin', label: '활짝' },
    { id: 'surprised', label: '놀람' },
    { id: 'neutral', label: '무표정' },
    { id: 'tongue', label: '메롱' },
  ],
  accessory: [
    { id: 'none', label: '없음' },
    { id: 'glasses', label: '안경' },
    { id: 'crown', label: '왕관' },
    { id: 'ribbon', label: '리본' },
    { id: 'hat', label: '모자' },
    { id: 'headphones', label: '헤드폰' },
    { id: 'flower', label: '꽃' },
  ],
};

function avatar(background: string, face: string, eyes: string, mouth: string, accessory: string): AvatarConfig {
  return Object.freeze({ v: 1, background, face, eyes, mouth, accessory });
}

export const AVATAR_PRESETS: ReadonlyArray<{ id: string; label: string; config: AvatarConfig }> = [
  { id: 'sunny-bear', label: '햇살 곰', config: avatar('yellow', 'bear', 'basic', 'smile', 'none') },
  { id: 'royal-cat', label: '왕관 고양이', config: avatar('lavender', 'cat', 'sparkle', 'grin', 'crown') },
  { id: 'ribbon-rabbit', label: '리본 토끼', config: avatar('pink', 'rabbit', 'basic', 'smile', 'ribbon') },
  { id: 'music-dog', label: '음악 강아지', config: avatar('mint', 'dog', 'happy', 'tongue', 'headphones') },
  { id: 'winter-penguin', label: '겨울 펭귄', config: avatar('sky', 'penguin', 'sparkle', 'surprised', 'hat') },
  { id: 'glasses-teacher', label: '안경 선생님', config: avatar('lime', 'skin-medium', 'basic', 'smile', 'glasses') },
  { id: 'flower-teacher', label: '꽃 선생님', config: avatar('peach', 'skin-light', 'happy', 'grin', 'flower') },
  { id: 'wink-teacher', label: '윙크 선생님', config: avatar('orange', 'skin-dark', 'wink', 'smile', 'hat') },
];

/** Upper bound for the serialized JSON accepted by the server (longest valid config is ~100 chars). */
export const AVATAR_JSON_MAX_LENGTH = 200;

const CONFIG_KEYS: ReadonlyArray<keyof AvatarConfig> = ['v', ...AVATAR_PART_KEYS];
const OPTION_IDS: Readonly<Record<AvatarPartKey, ReadonlySet<string>>> = {
  background: new Set(AVATAR_PARTS.background.map((option) => option.id)),
  face: new Set(AVATAR_PARTS.face.map((option) => option.id)),
  eyes: new Set(AVATAR_PARTS.eyes.map((option) => option.id)),
  mouth: new Set(AVATAR_PARTS.mouth.map((option) => option.id)),
  accessory: new Set(AVATAR_PARTS.accessory.map((option) => option.id)),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Strict validation: a plain object with exactly the config keys (no extras,
 * no symbols, no accessors), `v === 1` and every part id from its option list.
 * Returns a fresh frozen copy, or null for anything else.
 */
export function normalizeAvatar(value: unknown): AvatarConfig | null {
  if (!isPlainObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== CONFIG_KEYS.length) return null;
  for (const key of keys) {
    if (typeof key !== 'string' || !(CONFIG_KEYS as ReadonlyArray<string>).includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return null;
  }
  if (value.v !== 1) return null;
  for (const part of AVATAR_PART_KEYS) {
    const id = value[part];
    if (typeof id !== 'string' || !OPTION_IDS[part].has(id)) return null;
  }
  return avatar(value.background as string, value.face as string, value.eyes as string, value.mouth as string, value.accessory as string);
}

/** Canonical JSON (fixed key order) for storage. */
export function serializeAvatar(config: AvatarConfig): string {
  return JSON.stringify({ v: 1, background: config.background, face: config.face, eyes: config.eyes, mouth: config.mouth, accessory: config.accessory });
}

/** Parse stored/submitted JSON with a size cap before JSON.parse. */
export function parseAvatarJson(text: unknown): AvatarConfig | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > AVATAR_JSON_MAX_LENGTH) return null;
  try {
    return normalizeAvatar(JSON.parse(text));
  } catch {
    return null;
  }
}

export function isSameAvatar(a: AvatarConfig, b: AvatarConfig): boolean {
  return a.v === b.v && AVATAR_PART_KEYS.every((part) => a[part] === b[part]);
}

export function avatarOptionLabel(part: AvatarPartKey, id: string): string | undefined {
  return AVATAR_PARTS[part].find((option) => option.id === id)?.label;
}

/** Short Korean summary, e.g. "보라 배경 · 고양이 · 반짝 눈 · 활짝 · 왕관". */
export function describeAvatar(config: AvatarConfig): string {
  const label = (part: AvatarPartKey) => avatarOptionLabel(part, config[part]) ?? '';
  const parts = [`${label('background')} 배경`, label('face'), label('eyes'), label('mouth')];
  if (config.accessory !== 'none') parts.push(label('accessory'));
  return parts.filter(Boolean).join(' · ');
}

/** Stable default for a new user: FNV-1a hash of the seed picks a preset. */
export function defaultAvatarFor(seed: string): AvatarConfig {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return AVATAR_PRESETS[(hash >>> 0) % AVATAR_PRESETS.length].config;
}
