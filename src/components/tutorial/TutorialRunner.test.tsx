import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { TutorialRunner } from './TutorialRunner';
import type { Tutorial } from './tutorials';

const TUTORIAL: Tutorial = {
  id: '9-9',
  title: '연습',
  goal: '시험용',
  steps: [
    { tab: 'settings', target: '#name', focus: true, title: '이름', text: '**이름**을 적으세요.', sub: '예: 햇살 가게' },
    { target: '#open', area: ['@target'], title: '창 열기', text: '[열기]를 누르세요.', next: { wait: '#inside' }, advanceWhen: '#inside' },
    { target: '#inside', title: '창 안', text: '저장하세요.', warn: '바로 반영돼요.' },
  ],
};

function Page() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div data-field=""><label htmlFor="name">이름</label><input id="name" /></div>
      <button id="open" type="button" onClick={() => setOpen(true)}>열기</button>
      {open ? <div data-field=""><input id="inside" aria-label="창 안 칸" /></div> : null}
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  // jsdom lays nothing out: give every element a box so it counts as shown.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLElement) {
    // The tutorial's own 0,0 marks are where they are placed.
    if (this.style.visibility === 'hidden') return { x: 0, y: 0, left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1, toJSON: () => ({}) } as DOMRect;
    return { x: 100, y: 100, left: 100, top: 100, width: 200, height: 40, right: 300, bottom: 140, toJSON: () => ({}) } as DOMRect;
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const tour = () => screen.getByTestId('tutorial');
const stepOf = () => tour().getAttribute('data-tutorial-step');

describe('TutorialRunner', () => {
  it('shows the menu, lights the step, moves with 다음/이전 and opens a dialog only when asked', async () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<><Page /><TutorialRunner tutorial={TUTORIAL} onNavigate={onNavigate} onClose={onClose} /></>);
    await waitFor(() => expect(tour().getAttribute('data-tutorial-state')).toBe('shown'));
    expect(onNavigate).toHaveBeenCalledWith('settings');
    expect(screen.getByText('이름', { selector: 'b' })).toBeTruthy();
    expect(screen.getByText('예: 햇살 가게')).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('name'));

    fireEvent.click(screen.getByRole('button', { name: /다음/ }));
    await waitFor(() => expect(stepOf()).toBe('9-9:2'));
    expect(screen.getByRole('button', { name: /이전/ })).toBeTruthy();

    // 다음 on a step that opens something clicks it and waits for what it opens.
    fireEvent.click(screen.getByRole('button', { name: /다음/ }));
    await waitFor(() => expect(stepOf()).toBe('9-9:3'));
    expect(document.getElementById('inside')).toBeTruthy();
    expect(screen.getByText('바로 반영돼요.')).toBeTruthy();

    await waitFor(() => expect((screen.getByRole('button', { name: /이전/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /이전/ }));
    // Back on the step whose dialog is still open: it stays there (no moving on by itself).
    await waitFor(() => expect(stepOf()).toBe('9-9:2'));
    await new Promise((done) => setTimeout(done, 200));
    expect(stepOf()).toBe('9-9:2');
    fireEvent.click(screen.getByRole('button', { name: /다음/ }));
    await waitFor(() => expect(stepOf()).toBe('9-9:3'));
    fireEvent.click(screen.getByRole('button', { name: /마치기/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves on by itself when the teacher opens the dialog, and Esc ends it at any time', async () => {
    const onClose = vi.fn();
    render(<><Page /><TutorialRunner tutorial={TUTORIAL} onNavigate={() => {}} onClose={onClose} /></>);
    fireEvent.click(await screen.findByRole('button', { name: /다음/ }));
    await waitFor(() => expect(stepOf()).toBe('9-9:2'));
    fireEvent.click(document.getElementById('open')!);
    await waitFor(() => expect(stepOf()).toBe('9-9:3'));
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('draws the light where the target really is when the browser measures from a zoomed, moved screen', async () => {
    // iPhone Safari after a tapped input zoomed in: its measurements start 30,80 further in than
    // where positioned layers start. The marks at 0,0 show it, and the light lands on the target anyway.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLElement) {
      if (this.style.visibility === 'hidden') return { x: -30, y: -80, left: -30, top: -80, width: 1, height: 1, right: -29, bottom: -79, toJSON: () => ({}) } as DOMRect;
      return { x: 100, y: 100, left: 100, top: 100, width: 200, height: 40, right: 300, bottom: 140, toJSON: () => ({}) } as DOMRect;
    });
    render(<><Page /><TutorialRunner tutorial={TUTORIAL} onNavigate={() => {}} onClose={() => {}} /></>);
    await waitFor(() => expect(tour().getAttribute('data-tutorial-state')).toBe('shown'));
    const ring = document.querySelector('[data-testid="tutorial"] svg rect') as SVGRectElement;
    // The unit (100,100 with 8 px room) drawn 30,80 further, so that on screen it sits on the target.
    expect([ring.getAttribute('x'), ring.getAttribute('y')]).toEqual(['122', '172']);
  });

  it('says so when the step has nothing on screen, and still lets the teacher go on', async () => {
    const lost: Tutorial = { ...TUTORIAL, steps: [{ target: '#nowhere', title: '없음', text: '보이지 않아요.', missing: '넓은 화면에서만 보여요.' }, TUTORIAL.steps[0]] };
    render(<><Page /><TutorialRunner tutorial={lost} onNavigate={() => {}} onClose={() => {}} /></>);
    await waitFor(() => expect(tour().getAttribute('data-tutorial-state')).toBe('missing'), { timeout: 4000 });
    expect(screen.getByText('넓은 화면에서만 보여요.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /다음/ }));
    await waitFor(() => expect(stepOf()).toBe('9-9:2'));
  });
});
