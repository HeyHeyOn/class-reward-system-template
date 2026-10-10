/*
 * Korean particles after a word the teacher chose (a tree name, for example): 을/를, 이/가, 은/는, 과/와
 * depend on whether the word's last sound ends in a final consonant (받침).
 */

const DIGIT_BATCHIM: Readonly<Record<string, boolean>> = {
  0: true, 1: true, 2: false, 3: true, 4: false, 5: false, 6: true, 7: true, 8: true, 9: false,
};
/** Latin letters read with a final consonant: 엘, 엠, 엔, 알. */
const LATIN_BATCHIM = new Set(['l', 'm', 'n', 'r']);

/** Whether the word's last sound has a final consonant (받침). Ignores trailing spaces and symbols. */
export function endsWithBatchim(word: string): boolean {
  const last = [...word.trim()].reverse().find((char) => /[\p{L}\p{N}]/u.test(char));
  if (!last) return false;
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (last in DIGIT_BATCHIM) return DIGIT_BATCHIM[last];
  return LATIN_BATCHIM.has(last.toLowerCase());
}

export type ParticlePair = '을/를' | '이/가' | '은/는' | '과/와';

/** The word followed by the particle that fits it, e.g. withParticle('햇살 나무', '을/를') → '햇살 나무를'. */
export function withParticle(word: string, pair: ParticlePair): string {
  const [afterConsonant, afterVowel] = pair.split('/');
  return `${word}${endsWithBatchim(word) ? afterConsonant : afterVowel}`;
}
