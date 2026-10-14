import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AVATAR_PART_KEYS, AVATAR_PART_LABELS, AVATAR_PARTS, AVATAR_PRESETS, type AvatarConfig } from './avatar';
import { AvatarEditor } from './AvatarEditor';

afterEach(cleanup);

const bear = AVATAR_PRESETS[0].config; // yellow · bear · basic · smile · none

function pressed(name: string) {
  return screen.getByRole('button', { name }).getAttribute('aria-pressed');
}

describe('AvatarEditor', () => {
  it('shows a labelled live preview, a preset row, and one labelled group per part', () => {
    render(<AvatarEditor value={bear} onChange={() => {}} />);
    expect(screen.getByRole('img', { name: '프로필 아이콘 미리보기' })).toBeTruthy();
    expect(screen.getByText('노랑 배경, 곰, 기본, 미소')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: '추천 조합' })).getAllByRole('button')).toHaveLength(AVATAR_PRESETS.length);
    for (const part of AVATAR_PART_KEYS) {
      const group = screen.getByRole('group', { name: AVATAR_PART_LABELS[part] });
      const buttons = within(group).getAllByRole('button');
      expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(
        AVATAR_PARTS[part].map((option) => `${AVATAR_PART_LABELS[part]}: ${option.label}`));
    }
    expect(['배경색', '얼굴', '눈', '입', '꾸미기'].map((name) => screen.getByRole('group', { name }))).toHaveLength(5);
  });

  it('marks the current preset and options with aria-pressed', () => {
    const { rerender } = render(<AvatarEditor value={bear} onChange={() => {}} />);
    expect(pressed('추천 조합: 햇살 곰')).toBe('true');
    expect(pressed('추천 조합: 왕관 고양이')).toBe('false');
    expect(pressed('배경색: 노랑')).toBe('true');
    expect(pressed('배경색: 하늘')).toBe('false');
    expect(pressed('얼굴: 곰')).toBe('true');
    expect(pressed('눈: 기본')).toBe('true');
    expect(pressed('입: 미소')).toBe('true');
    expect(pressed('꾸미기: 없음')).toBe('true');
    expect(screen.getAllByRole('button').filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(6);

    const custom: AvatarConfig = { ...bear, face: 'cat' };
    rerender(<AvatarEditor value={custom} onChange={() => {}} />);
    expect(pressed('얼굴: 고양이')).toBe('true');
    expect(pressed('얼굴: 곰')).toBe('false');
    expect(within(screen.getByRole('group', { name: '추천 조합' })).getAllByRole('button')
      .every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true);
  });

  it('calls onChange with the preset config when a preset is clicked', () => {
    const onChange = vi.fn();
    render(<AvatarEditor value={bear} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '추천 조합: 왕관 고양이' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(AVATAR_PRESETS[1].config);
  });

  it('calls onChange with only the clicked part changed', () => {
    const onChange = vi.fn();
    render(<AvatarEditor value={bear} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '얼굴: 고양이' }));
    fireEvent.click(screen.getByRole('button', { name: '배경색: 남색' }));
    fireEvent.click(screen.getByRole('button', { name: '눈: 윙크' }));
    fireEvent.click(screen.getByRole('button', { name: '입: 메롱' }));
    fireEvent.click(screen.getByRole('button', { name: '꾸미기: 헤드폰' }));
    expect(onChange.mock.calls.map(([next]) => next)).toEqual([
      { ...bear, face: 'cat' },
      { ...bear, background: 'navy' },
      { ...bear, eyes: 'wink' },
      { ...bear, mouth: 'tongue' },
      { ...bear, accessory: 'headphones' },
    ]);
  });

  it('previews each option applied to the current avatar', () => {
    render(<AvatarEditor value={bear} onChange={() => {}} />);
    const option = screen.getByRole('button', { name: '꾸미기: 왕관' });
    const svg = option.querySelector('svg[data-avatar]')!;
    expect(svg.getAttribute('data-avatar')).toBe('yellow bear basic smile crown');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
});
