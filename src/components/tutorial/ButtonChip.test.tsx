import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { ButtonChip, findButton } from './ButtonChip';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function shown() {
  // jsdom lays nothing out: give every element a box so it counts as shown.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 10, left: 10, top: 10, width: 80, height: 40, right: 90, bottom: 50, toJSON: () => ({}) } as DOMRect);
}

describe('ButtonChip', () => {
  it('copies the real button, icon included, as an unusable picture', async () => {
    shown();
    const { container } = render(<>
      <button type="button" className="real" onClick={() => {}}><svg viewBox="0 0 24 24" data-icon="plus"><path d="M12 5v14" /></svg>학생 추가</button>
      <p><ButtonChip label="학생 추가" /></p>
    </>);
    const chip = container.querySelector('[data-chip-label="학생 추가"]')!;
    await waitFor(() => expect(chip.getAttribute('data-chip-source')).toBe('live'));
    const copy = chip.querySelector('[inert] > *') as HTMLElement;
    expect(copy.textContent).toBe('학생 추가');
    expect(copy.querySelector('svg path')?.getAttribute('d')).toBe('M12 5v14');
    // A picture, not a second button: no class, no handlers, no focus, nothing to click.
    expect(copy.getAttribute('class')).toBeNull();
    expect(copy.style.pointerEvents).toBe('none');
    expect(chip.querySelector('.sr-only')?.textContent).toBe('학생 추가');
  });

  it('shows the new name when a chip is reused for the next step, not the old button', async () => {
    shown();
    const page = <button type="button">행사 관리</button>;
    const { container, rerender } = render(<>{page}<p><ButtonChip label="행사 관리" /></p></>);
    await waitFor(() => expect(container.querySelector('[data-chip-label="행사 관리"]')?.getAttribute('data-chip-source')).toBe('live'));
    rerender(<>{page}<p><ButtonChip label="다음" /></p></>);
    const chip = container.querySelector('[data-chip-label="다음"]')!;
    expect(chip.getAttribute('data-chip-source')).toBe('known');
    expect(chip.querySelector('[inert]')?.childElementCount).toBe(0);
    expect(chip.textContent).toBe('다음');
  });

  it('finds a button by its count (전체 8, 3명 저장) and never inside the help box itself', () => {
    shown();
    render(<>
      <div data-testid="tutorial"><button type="button">다음</button><button type="button">3명 저장</button></div>
      <button type="button">전체<span> 8</span></button>
      <button type="button" id="save">3명 저장</button>
    </>);
    expect(findButton('전체', null)?.textContent).toBe('전체 8');
    expect(findButton('N명 저장', null)?.id).toBe('save');
    expect(findButton('다음', null)).toBeNull();
    render(<button type="button" id="add">더하기 +5</button>);
    expect(findButton('더하기', null)?.id).toBe('add');
  });

  it('prefers the matching button nearest to what the step points at', () => {
    render(<><button type="button" id="far">삭제</button><button type="button" id="near">삭제</button><div id="target" /></>);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLElement) {
      const x = this.id === 'far' ? 900 : this.id === 'near' ? 110 : 100;
      return { x, y: 100, left: x, top: 100, width: 40, height: 30, right: x + 40, bottom: 130, toJSON: () => ({}) } as DOMRect;
    });
    expect(findButton('삭제', document.getElementById('target'))?.id).toBe('near');
  });

  it('draws a known button that is not on the screen, and a key cap for anything else', () => {
    const { container } = render(<p><ButtonChip label="다음" /> <ButtonChip label="어딘가의 버튼" /></p>);
    expect(container.querySelector('[data-chip-label="다음"]')?.getAttribute('data-chip-source')).toBe('known');
    expect(container.querySelector('[data-chip-label="다음"] svg')).toBeTruthy();
    expect(container.querySelector('[data-chip-label="어딘가의 버튼"]')?.getAttribute('data-chip-source')).toBe('plain');
  });
});
