import { describe, expect, it } from 'vitest';
import { endsWithBatchim, withParticle } from './koreanParticle';

describe('Korean particles after a chosen word', () => {
  it('follows the final consonant of the last sound', () => {
    expect(withParticle('사과나무', '을/를')).toBe('사과나무를');
    expect(withParticle('햇살 나무', '을/를')).toBe('햇살 나무를');
    expect(withParticle('느티나무숲', '을/를')).toBe('느티나무숲을');
    expect(withParticle('우리반 나무 2', '이/가')).toBe('우리반 나무 2가');
    expect(withParticle('나무 3', '은/는')).toBe('나무 3은');
    expect(withParticle('Tree', '을/를')).toBe('Tree를');
    expect(withParticle('Apple Garden', '을/를')).toBe('Apple Garden을');
  });

  it('ignores trailing symbols and handles words without letters', () => {
    expect(endsWithBatchim('별빛숲!')).toBe(true);
    expect(endsWithBatchim('   ')).toBe(false);
  });
});
