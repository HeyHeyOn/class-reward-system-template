import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const appDir = join(process.cwd(), 'src', 'app');
const publicDir = join(process.cwd(), 'public');

function readAppFile(relativePath: string) {
  return readFileSync(join(appDir, relativePath), 'utf8');
}

describe('browser tab metadata', () => {
  it('sets distinct tab titles for each main route', () => {
    const expectedTitles: Array<[string, string]> = [
      ['page.tsx', '학급 매점'],
      [join('bank', 'page.tsx'), '학급 은행'],
      [join('admin', 'login', 'page.tsx'), '학급 보상 시스템'],
      [join('admin', 'page.tsx'), '학급 보상 시스템'],
      [join('admin', 'manage', 'page.tsx'), '학급 보상 시스템'],
      [join('admin', 'settings', 'page.tsx'), '학급 보상 시스템'],
      [join('admin', 'student-qrs', 'page.tsx'), '학급 보상 시스템'],
      [join('admin', 'transactions', 'page.tsx'), '학급 보상 시스템'],
      [join('admin', 'generator', 'page.tsx'), '학급 보상 시스템'],
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
    expect(statSync(join(publicDir, 'class-reward-system-icon.png')).size).toBeGreaterThan(500);

    const layout = readAppFile('layout.tsx');
    expect(layout).toContain("icon: '/icon.png'");
    expect(layout).toContain("apple: '/apple-icon.png'");
  });
});
