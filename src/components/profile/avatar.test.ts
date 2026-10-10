import { describe, expect, it } from 'vitest';
import {
  AVATAR_JSON_MAX_LENGTH, AVATAR_PART_KEYS, AVATAR_PARTS, AVATAR_PRESETS,
  defaultAvatarFor, describeAvatar, isSameAvatar, normalizeAvatar, parseAvatarJson, serializeAvatar,
  type AvatarConfig,
} from './avatar';

const sample: AvatarConfig = AVATAR_PRESETS[1].config;

function* everyCombination(): Generator<AvatarConfig> {
  for (const background of AVATAR_PARTS.background) for (const face of AVATAR_PARTS.face) for (const eyes of AVATAR_PARTS.eyes)
    for (const mouth of AVATAR_PARTS.mouth) for (const accessory of AVATAR_PARTS.accessory)
      yield { v: 1, background: background.id, face: face.id, eyes: eyes.id, mouth: mouth.id, accessory: accessory.id };
}

describe('avatar option sets', () => {
  it('has the agreed option counts with unique ids and Korean labels', () => {
    expect(AVATAR_PARTS.background).toHaveLength(10);
    expect(AVATAR_PARTS.face).toHaveLength(8);
    expect(AVATAR_PARTS.eyes).toHaveLength(5);
    expect(AVATAR_PARTS.mouth).toHaveLength(5);
    expect(AVATAR_PARTS.accessory).toHaveLength(7);
    for (const part of AVATAR_PART_KEYS) {
      const ids = AVATAR_PARTS[part].map((option) => option.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const option of AVATAR_PARTS[part]) expect(option.label).toMatch(/[가-힣]/);
    }
    expect(AVATAR_PARTS.accessory[0]).toEqual({ id: 'none', label: '없음' });
  });

  it('ships 8 valid presets with unique ids and distinct combinations', () => {
    expect(AVATAR_PRESETS).toHaveLength(8);
    expect(new Set(AVATAR_PRESETS.map((preset) => preset.id)).size).toBe(8);
    expect(new Set(AVATAR_PRESETS.map((preset) => serializeAvatar(preset.config))).size).toBe(8);
    for (const preset of AVATAR_PRESETS) {
      expect(preset.label).toMatch(/[가-힣]/);
      expect(normalizeAvatar(preset.config)).toEqual(preset.config);
    }
  });
});

describe('normalizeAvatar', () => {
  it('accepts every option combination and round-trips through JSON within the size cap', () => {
    let count = 0;
    for (const config of everyCombination()) {
      count += 1;
      expect(normalizeAvatar(config)).toEqual(config);
      const json = serializeAvatar(config);
      expect(json.length).toBeLessThanOrEqual(AVATAR_JSON_MAX_LENGTH);
      expect(parseAvatarJson(json)).toEqual(config);
    }
    expect(count).toBe(10 * 8 * 5 * 5 * 7);
  });

  it('returns a fresh frozen copy in canonical key order', () => {
    const input = { accessory: 'crown', mouth: 'grin', eyes: 'sparkle', face: 'cat', background: 'lavender', v: 1 };
    const result = normalizeAvatar(input);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result!)).toEqual(['v', 'background', 'face', 'eyes', 'mouth', 'accessory']);
    input.face = 'bear';
    expect(result?.face).toBe('cat');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['string', JSON.stringify(sample)],
    ['number', 1],
    ['boolean', true],
    ['array', [sample]],
    ['function', () => sample],
  ])('rejects non-objects (%s)', (_name, value) => {
    expect(normalizeAvatar(value)).toBeNull();
  });

  it('rejects extra, missing, or unexpected keys', () => {
    expect(normalizeAvatar({ ...sample, extra: 'x' })).toBeNull();
    expect(normalizeAvatar({ ...sample, name: '선생님' })).toBeNull();
    const missing: Record<string, unknown> = { ...sample };
    delete missing.accessory;
    expect(normalizeAvatar(missing)).toBeNull();
    expect(normalizeAvatar({})).toBeNull();
    expect(normalizeAvatar({ ...sample, [Symbol('x')]: 1 })).toBeNull();
    expect(normalizeAvatar(JSON.parse(`{"__proto__":{"admin":true},${serializeAvatar(sample).slice(1)}`))).toBeNull();
  });

  it('rejects a wrong version', () => {
    for (const v of [0, 2, '1', 1.5, null, undefined]) expect(normalizeAvatar({ ...sample, v })).toBeNull();
  });

  it('rejects unknown ids, ids from another part, and non-string ids', () => {
    for (const part of AVATAR_PART_KEYS) {
      expect(normalizeAvatar({ ...sample, [part]: 'unknown' })).toBeNull();
      expect(normalizeAvatar({ ...sample, [part]: '' })).toBeNull();
      expect(normalizeAvatar({ ...sample, [part]: 1 })).toBeNull();
      expect(normalizeAvatar({ ...sample, [part]: null })).toBeNull();
      expect(normalizeAvatar({ ...sample, [part]: 'toString' })).toBeNull();
      expect(normalizeAvatar({ ...sample, [part]: 'constructor' })).toBeNull();
    }
    expect(normalizeAvatar({ ...sample, face: 'sky' })).toBeNull();
    expect(normalizeAvatar({ ...sample, background: 'cat' })).toBeNull();
    expect(normalizeAvatar({ ...sample, face: 'Cat' })).toBeNull();
    expect(normalizeAvatar({ ...sample, face: ' cat' })).toBeNull();
  });

  it('rejects non-plain objects and accessor properties', () => {
    class Avatar { v = 1; background = 'sky'; face = 'cat'; eyes = 'basic'; mouth = 'smile'; accessory = 'none'; }
    expect(normalizeAvatar(new Avatar())).toBeNull();
    expect(normalizeAvatar(Object.assign(Object.create({ inherited: true }), sample))).toBeNull();
    expect(normalizeAvatar(new Map(Object.entries(sample)))).toBeNull();
    const withGetter = { ...sample };
    Object.defineProperty(withGetter, 'face', { get: () => 'cat', enumerable: true });
    expect(normalizeAvatar(withGetter)).toBeNull();
    expect(normalizeAvatar(Object.assign(Object.create(null), sample))).toEqual(sample);
  });

  it('rejects oversized values', () => {
    expect(normalizeAvatar({ ...sample, face: 'cat'.repeat(10_000) })).toBeNull();
    expect(parseAvatarJson(`${serializeAvatar(sample)}${' '.repeat(AVATAR_JSON_MAX_LENGTH)}`)).toBeNull();
    expect(parseAvatarJson(JSON.stringify({ ...sample, face: 'x'.repeat(AVATAR_JSON_MAX_LENGTH) }))).toBeNull();
  });

  it('parseAvatarJson rejects malformed input', () => {
    expect(parseAvatarJson('')).toBeNull();
    expect(parseAvatarJson('{')).toBeNull();
    expect(parseAvatarJson('null')).toBeNull();
    expect(parseAvatarJson('[]')).toBeNull();
    expect(parseAvatarJson(42)).toBeNull();
    expect(parseAvatarJson(sample)).toBeNull();
    expect(parseAvatarJson(serializeAvatar(sample))).toEqual(sample);
  });
});

describe('helpers', () => {
  it('defaultAvatarFor is deterministic, valid, and spreads across presets', () => {
    for (const seed of ['', 'teacher-1', '김선생', 'user@example.com', 'x'.repeat(1000)]) {
      const first = defaultAvatarFor(seed);
      expect(defaultAvatarFor(seed)).toBe(first);
      expect(normalizeAvatar(first)).toEqual(first);
      expect(AVATAR_PRESETS.some((preset) => preset.config === first)).toBe(true);
    }
    const picked = new Set(Array.from({ length: 200 }, (_, index) => defaultAvatarFor(`teacher-${index}`)));
    expect(picked.size).toBeGreaterThanOrEqual(6);
  });

  it('compares and describes configs', () => {
    expect(isSameAvatar(sample, { ...sample })).toBe(true);
    expect(isSameAvatar(sample, { ...sample, eyes: 'wink' })).toBe(false);
    expect(describeAvatar(sample)).toBe('보라 배경 · 고양이 · 반짝 눈 · 활짝 · 왕관');
    expect(describeAvatar({ ...sample, accessory: 'none' })).toBe('보라 배경 · 고양이 · 반짝 눈 · 활짝');
  });
});
