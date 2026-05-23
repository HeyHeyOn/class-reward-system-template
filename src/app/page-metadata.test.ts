import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const appDir = join(process.cwd(), 'src', 'app');

function readAppFile(relativePath: string) {
  return readFileSync(join(appDir, relativePath), 'utf8');
}

describe('browser tab metadata', () => {
  it('sets distinct tab titles for each main route', () => {
    const expectedTitles: Array<[string, string]> = [
      ['page.tsx', '학급 매점'],
      [join('bank', 'page.tsx'), '학급 은행'],
      [join('admin', 'login', 'page.tsx'), '관리자 로그인'],
      [join('admin', 'page.tsx'), '관리자 센터'],
      [join('admin', 'manage', 'page.tsx'), '관리자 관리'],
      [join('admin', 'settings', 'page.tsx'), '설정'],
      [join('admin', 'student-qrs', 'page.tsx'), '학생 QR 카드 인쇄'],
      [join('admin', 'transactions', 'page.tsx'), '거래 내역 확인'],
      [join('admin', 'generator', 'page.tsx'), 'CRS 생성기'],
    ];

    for (const [relativePath, title] of expectedTitles) {
      const source = readAppFile(relativePath);
      expect(source, relativePath).toContain('export const metadata');
      expect(source, relativePath).toContain(`title: '${title}'`);
    }
  });

  it('uses the uploaded icon as the shared browser icon source', () => {
    for (const fileName of ['favicon.ico', 'icon.png', 'apple-icon.png']) {
      const icon = statSync(join(appDir, fileName));
      expect(icon.size, fileName).toBeGreaterThan(500);
    }

    const layout = readAppFile('layout.tsx');
    expect(layout).toContain("icon: '/icon.png'");
    expect(layout).toContain("apple: '/apple-icon.png'");
  });
});
