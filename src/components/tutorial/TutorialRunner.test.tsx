import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { TutorialRunner } from './TutorialRunner';
import type { Tutorial } from './tutorials';
import { takeQueuedTutorial } from './tutorialQueue';

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
  // A wide screen with a mouse.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: /pointer: fine|min-width/.test(query), media: query, addEventListener() {}, removeEventListener() {} }));
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

  it('passes over a step that does not apply, going either way, and ends when nothing after it applies', async () => {
    const onClose = vi.fn();
    const optional: Tutorial = { ...TUTORIAL, steps: [
      TUTORIAL.steps[0],
      { target: '#inside', skipUnless: '#inside', title: '창 안', text: '창이 열렸을 때만 보여요.' },
      { target: '#open', area: ['@target'], title: '창 열기', text: '[열기]를 누르세요.' },
      { target: '#inside', skipUnless: '#inside', title: '끝', text: '창이 열렸을 때만 보여요.' },
    ] };
    render(<><Page /><TutorialRunner tutorial={optional} onNavigate={() => {}} onClose={onClose} /></>);
    await waitFor(() => expect(tour().getAttribute('data-tutorial-state')).toBe('shown'));
    fireEvent.click(screen.getByRole('button', { name: /다음/ }));
    await waitFor(() => expect(stepOf()).toBe('9-9:3'));
    expect(screen.getByText('열기', { selector: 'span' })).toBeTruthy();
    // Nothing after this step applies: it is the last one.
    expect(screen.getByRole('button', { name: /마치기/ })).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: /이전/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /이전/ }));
    await waitFor(() => expect(stepOf()).toBe('9-9:1'));
    fireEvent.click(screen.getByRole('button', { name: /다음/ }));
    await waitFor(() => expect(stepOf()).toBe('9-9:3'));
    fireEvent.click(screen.getByRole('button', { name: /마치기/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('says where the menu is, shows the goal first, and offers what is next once it is done', async () => {
    const onNext = vi.fn();
    const onMenu = vi.fn();
    const onClose = vi.fn();
    const next: Tutorial = { ...TUTORIAL, id: '9-10', title: '다음 연습' };
    const short: Tutorial = { ...TUTORIAL, steps: [{ target: '#name', title: '이름', text: '**{menu}**에서 고르세요.' }, TUTORIAL.steps[2]] };
    render(<><Page /><TutorialRunner tutorial={short} onNavigate={() => {}} onClose={onClose} after={{ next, onNext, onMenu }} /></>);
    await waitFor(() => expect(tour().getAttribute('data-tutorial-state')).toBe('shown'));
    expect(screen.getByText('왼쪽 메뉴')).toBeTruthy();
    expect(screen.getByText('[목표] 시험용')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /다음/ }));
    await waitFor(() => expect(stepOf()).toBe('9-9:2'));
    expect(screen.queryByText(/\[목표\]/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /마치기/ }));
    await waitFor(() => expect(tour().getAttribute('data-tutorial-state')).toBe('done'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('다 했어요')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /다음 도움말/ }));
    expect(onNext).toHaveBeenCalledWith('9-10');
    fireEvent.click(screen.getByRole('button', { name: '도움말 목록' }));
    expect(onMenu).toHaveBeenCalledTimes(1);
  });

  it('draws an arrow only on a step that asks the teacher to do something', async () => {
    const arrow = (container: HTMLElement) => container.querySelector('path[d^="M6 18h20"]');
    const mixed: Tutorial = { ...TUTORIAL, steps: [
      { target: '#open', area: ['@target'], title: '누르기', text: '[열기]를 누르세요.' },
      { target: '#open', area: ['@target'], look: true, title: '선택', text: '필요하면 열어요.' },
      { target: '#name', peek: true, title: '보기', text: '이름 칸이에요.' },
    ] };
    const { container } = render(<><Page /><TutorialRunner tutorial={mixed} onNavigate={() => {}} onClose={() => {}} /></>);
    await waitFor(() => expect(tour().getAttribute('data-tutorial-state')).toBe('shown'));
    expect(arrow(container)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /다음/ }));
    await waitFor(() => expect(stepOf()).toBe('9-9:2'));
    await waitFor(() => expect(tour().getAttribute('data-tutorial-state')).toBe('shown'));
    expect(arrow(container)).toBeNull();
    // An option stays usable: nothing covers the lit unit.
    expect(container.querySelector('svg rect[fill="rgb(0 0 0 / 0)"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /다음/ }));
    await waitFor(() => expect(stepOf()).toBe('9-9:3'));
    await waitFor(() => expect(container.querySelector('svg rect[fill="rgb(0 0 0 / 0)"]')).toBeTruthy());
    expect(arrow(container)).toBeNull();
  });

  it('only shows a step to look at, and nudges the box when the dimmed page is clicked', async () => {
    const look: Tutorial = { ...TUTORIAL, steps: [{ target: '#open', area: ['@target'], peek: true, title: '보기', text: '보기만 해요.' }, TUTORIAL.steps[0]] };
    const { container } = render(<><Page /><TutorialRunner tutorial={look} onNavigate={() => {}} onClose={() => {}} /></>);
    await waitFor(() => expect(tour().getAttribute('data-tutorial-state')).toBe('shown'));
    const cover = container.querySelector('svg rect[fill="rgb(0 0 0 / 0)"]');
    expect(cover).toBeTruthy();
    const box = screen.getByRole('dialog', { name: /도움말 9-9/ });
    expect(box.style.animation).toBe('');
    fireEvent.pointerDown(container.querySelector('svg path')!);
    expect(box.style.animation).toContain('crs-tour-shake-1');
    fireEvent.pointerDown(cover!);
    expect(box.style.animation).toContain('crs-tour-shake-0');
  });

  it('hands the tutorial over to the page a step leads to, and goes on there from the next step', async () => {
    const crossing: Tutorial = { ...TUTORIAL, steps: [{ target: '#open', area: ['@target'], opensPage: 'classes', title: '가기', text: '누르세요.' }, TUTORIAL.steps[0], TUTORIAL.steps[2]] };
    const first = render(<><Page /><TutorialRunner tutorial={crossing} onNavigate={() => {}} onClose={() => {}} /></>);
    await waitFor(() => expect(tour().getAttribute('data-tutorial-state')).toBe('shown'));
    expect(window.sessionStorage.getItem('crs-tutorial-pending')).toBe(JSON.stringify({ id: '9-9', step: 1 }));
    // Closing it (not leaving the page) forgets the hand-over.
    first.unmount();
    expect(takeQueuedTutorial()).toBeNull();

    render(<><Page /><TutorialRunner tutorial={crossing} firstStep={1} onNavigate={() => {}} onClose={() => {}} /></>);
    await waitFor(() => expect(stepOf()).toBe('9-9:2'));
    expect((screen.getByRole('button', { name: /이전/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the tab its target sits behind', async () => {
    function Tabs() {
      const [tab, setTab] = useState<'a' | 'b'>('a');
      return (
        <div>
          <button id="tab-b" type="button" onClick={() => setTab('b')}>B</button>
          {tab === 'b' ? <div data-field=""><input id="in-b" aria-label="B 칸" /></div> : null}
        </div>
      );
    }
    const behind: Tutorial = { ...TUTORIAL, steps: [{ target: '#in-b', reveal: '#tab-b', title: 'B 칸', text: '**B 칸**을 보세요.' }, TUTORIAL.steps[0]] };
    render(<><Tabs /><Page /><TutorialRunner tutorial={behind} onNavigate={() => {}} onClose={() => {}} /></>);
    await waitFor(() => expect(tour().getAttribute('data-tutorial-state')).toBe('shown'));
    expect(document.getElementById('in-b')).toBeTruthy();
  });
});
