import { cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { AVATAR_PART_KEYS, AVATAR_PARTS, AVATAR_PRESETS, type AvatarConfig } from './avatar';
import { UserAvatar } from './UserAvatar';

afterEach(cleanup);

const config = AVATAR_PRESETS[0].config;

describe('UserAvatar', () => {
  it('renders an accessible inline svg with the given label and size', () => {
    render(<UserAvatar config={config} size={56} title="김선생님 프로필" className="ring-2" />);
    const img = screen.getByRole('img', { name: '김선생님 프로필' });
    expect(img.tagName.toLowerCase()).toBe('svg');
    expect(img.getAttribute('viewBox')).toBe('0 0 64 64');
    expect(img.getAttribute('width')).toBe('56');
    expect(img.getAttribute('height')).toBe('56');
    expect(img.getAttribute('class')).toBe('ring-2');
    expect(img.getAttribute('aria-hidden')).toBeNull();
    expect(img.querySelector('text, image, foreignObject')).toBeNull();
  });

  it('uses a default label and size', () => {
    render(<UserAvatar config={config} />);
    const img = screen.getByRole('img', { name: '프로필 아이콘' });
    expect(img.getAttribute('width')).toBe('40');
  });

  it('is decorative when the title is empty', () => {
    const { container } = render(<UserAvatar config={config} title="" />);
    expect(screen.queryByRole('img')).toBeNull();
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();
    expect(svg.getAttribute('aria-label')).toBeNull();
  });

  it('renders on the server without hooks and differs per option', () => {
    const markups = new Set<string>();
    for (const part of AVATAR_PART_KEYS) {
      for (const option of AVATAR_PARTS[part]) {
        const next: AvatarConfig = { ...config, [part]: option.id };
        const html = renderToStaticMarkup(<UserAvatar config={next} title="" />);
        expect(html.startsWith('<svg')).toBe(true);
        markups.add(html.replace(/data-avatar="[^"]*"/, ''));
      }
    }
    // Every option (minus the base config's own id, counted once per part) draws something different.
    const optionCount = AVATAR_PART_KEYS.reduce((sum, part) => sum + AVATAR_PARTS[part].length, 0);
    expect(markups.size).toBe(optionCount - AVATAR_PART_KEYS.length + 1);
  });

  it('falls back to default parts for unknown ids instead of crashing', () => {
    const broken = { ...config, face: 'toString', eyes: 'nope', accessory: '__proto__' } as AvatarConfig;
    render(<UserAvatar config={broken} title="깨진 설정" />);
    const img = screen.getByRole('img', { name: '깨진 설정' });
    expect(img.querySelectorAll('ellipse, circle, path').length).toBeGreaterThan(5);
  });
});
