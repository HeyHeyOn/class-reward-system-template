import { describe, expect, it } from 'vitest';
import { shareFileName } from './shareCard';

describe('shareFileName', () => {
  it('names the file after the class and the page', () => {
    expect(shareFileName('5학년 2반', '매점', 'png')).toBe('5학년 2반-매점-QR.png');
    expect(shareFileName('5학년 2반', '관리자 페이지', 'pdf')).toBe('5학년 2반-관리자 페이지-QR.pdf');
  });

  it('replaces characters that file systems refuse', () => {
    const name = shareFileName('5/2반: "별"', '은행', 'png');
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name.startsWith('5-2반')).toBe(true);
    expect(name.endsWith('-은행-QR.png')).toBe(true);
    expect(shareFileName('  ', '은행', 'pdf')).toBe('은행-QR.pdf');
  });
});
