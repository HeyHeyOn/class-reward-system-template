'use client';

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AdminTab } from '../admin/adminTypes';
import { Button, Icon, IconButton, cx } from '../ui';
import { areaElements, boxOf, firstShown, inFixedLayer, place, unionBox, type ArrowSide, type Box } from './tutorialDom';
import { ButtonChip } from './ButtonChip';
import { clearQueuedTutorial, queueTutorial } from './tutorialQueue';
import type { Tutorial } from './tutorials';

/**
 * `fixed`: the target stays put while the page scrolls (in a dialog, a sticky bar) and so does the
 * tutorial. `page`: the target scrolls with the page and the tutorial is laid on the page in page
 * coordinates, so it moves with it by itself.
 */
type Anchor = 'fixed' | 'page';
type View =
  | Readonly<{ step: number; kind: 'searching' }>
  | Readonly<{ step: number; kind: 'missing' }>
  | Readonly<{ step: number; kind: 'shown'; anchor: Anchor; area: Box; arrow: Box & { side: ArrowSide }; box: Box; canvas: Readonly<{ w: number; h: number }> }>;

const BOX_WIDTH = 360;

const MISSING_AFTER_MS = 2500;
const WAIT_MS = 2500;
/** How long a step that only applies sometimes (`skipUnless`) waits for its sign before it is passed over. */
const SKIP_AFTER_MS = 400;
/** …not counting the time the screen is still loading (a spinner shows), up to this long. */
const SKIP_LOADING_MAX_MS = 5000;
/** How long a step waits before clicking `reveal` (its menu may still be switching). */
const REVEAL_AFTER_MS = 150;
const AREA_PAD = 8;

/** Where the admin menu is: down the left on a wide screen, across the top on a narrow one (lg). */
function menuWord(): string {
  return typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1024px)').matches ? '왼쪽 메뉴' : '맨 위 메뉴';
}

/** **굵게** and [버튼] in the guide's words; `{menu}` is where the menu is on this screen. A [버튼]
 * looks like the real button (the one nearest `near`, the step's target). */
export function TutorialText({ text, near }: { text: string; near?: Element | null }) {
  const parts = text.replaceAll('{menu}', menuWord()).split(/(\*\*[^*]+\*\*|\[[^\]]+\])/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('**')) return <b key={index} className="font-extrabold text-[var(--theme-text)]">{part.slice(2, -2)}</b>;
        if (part.startsWith('[')) return <ButtonChip key={index} label={part.slice(1, -1)} near={near} />;
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}

function waitFor(selector: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = performance.now();
    const check = () => {
      if (firstShown(selector)) { resolve(true); return; }
      if (performance.now() - started > ms) { resolve(false); return; }
      window.setTimeout(check, 60);
    };
    check();
  });
}

function fullyVisible(box: Box, visible: Box): boolean {
  return box.y >= visible.y && box.x >= visible.x && box.y + box.h <= visible.y + visible.h && box.x + box.w <= visible.x + visible.w;
}

/**
 * The part of the page the teacher can see, in the coordinates getBoundingClientRect uses. On a
 * zoomed phone screen (iPhone Safari zooms in when a small input is tapped and stays zoomed after
 * the keyboard closes) that is only part of the layout viewport, and Safari may measure from it.
 * `fixedOrigin` is where a fixed element placed at 0,0 really is, measured the same way.
 */
function visibleRegion(fixedOrigin: DOMRect): Box {
  const viewport = window.visualViewport;
  if (!viewport) return { x: fixedOrigin.left, y: fixedOrigin.top, w: window.innerWidth, h: window.innerHeight };
  return { x: viewport.offsetLeft + fixedOrigin.left, y: viewport.offsetTop + fixedOrigin.top, w: viewport.width, h: viewport.height };
}

/**
 * Runs one tutorial over the real admin screen: the step's understanding unit stays lit (and
 * clickable), the rest is dimmed and blocks clicks, an arrow points at the control and a box
 * explains it. 이전/다음 move freely; 끝내기 or Esc stops at any time. Nothing is saved for the
 * teacher — 다음 only ever opens a dialog or a tab.
 */
export function TutorialRunner({ tutorial, onNavigate, onClose, firstStep = 0, after }: {
  tutorial: Tutorial;
  onNavigate: (tab: AdminTab) => void;
  onClose: () => void;
  /** Where this run starts: a tutorial that went on from another page. */
  firstStep?: number;
  /** What to offer once it is done. Without it 마치기 just closes. */
  after?: Readonly<{ next: Tutorial | null; onNext: (id: string) => void; onMenu: () => void }>;
}) {
  const [index, setIndex] = useState(firstStep);
  const [view, setView] = useState<View>({ step: firstStep, kind: 'searching' });
  const [moving, setMoving] = useState(false);
  const [done, setDone] = useState(false);
  // Counts clicks on the dimmed page: each one nudges the box, so the teacher sees where to look.
  const [nudges, setNudges] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // Invisible marks at 0,0 of the two layers the tutorial draws on (the screen and the page). Where
  // they really are tells how to turn measured positions into drawn ones, whatever the browser does.
  const fixedProbe = useRef<HTMLDivElement>(null);
  const pageProbe = useRef<HTMLDivElement>(null);
  const navigate = useRef(onNavigate);
  const close = useRef(onClose);
  const finish = useRef<() => void>(() => onClose());
  // Which way the teacher is going, so a step that does not apply is passed over in that direction.
  const direction = useRef<1 | -1>(1);
  useEffect(() => {
    navigate.current = onNavigate;
    close.current = onClose;
    finish.current = after ? () => setDone(true) : onClose;
  });

  const steps = tutorial.steps;
  const step = steps[index];
  // The last step, or every step after it applies only to something that is not on the screen.
  const last = steps.slice(index + 1).every((later) => later.skipUnless !== undefined && !firstShown(later.skipUnless));
  const current = view.step === index ? view : { step: index, kind: 'searching' as const };

  /** Moves from `from` to `to` once (a click that already moved on is not counted twice). */
  const moveTo = useCallback((from: number, to: number) => {
    if (to >= steps.length) { finish.current(); return; }
    direction.current = to < from ? -1 : 1;
    setIndex((now) => (now === from ? Math.max(firstStep, to) : now));
  }, [steps.length, firstStep]);

  // A step that leaves for another page: if the teacher goes there, the tutorial goes on there.
  useEffect(() => {
    if (!step.opensPage || done) return;
    queueTutorial({ id: tutorial.id, step: index + 1 });
    return () => clearQueuedTutorial();
  }, [step, index, tutorial.id, done]);

  // Each step: show its menu, find its target, keep the light on it as the page moves.
  useEffect(() => {
    if (done) return;
    let alive = true;
    let frame = 0;
    let lastKey = '';
    let revealed = false;
    let anchorOf: { element: HTMLElement; anchor: Anchor } | null = null;
    // A step that only applies sometimes is undecided until its sign shows up (or does not, in time).
    let applies = !step.skipUnless;
    let passedOver = false;
    let settledAt = 0;
    let revealClicked = false;
    if (step.tab) navigate.current(step.tab);
    const startedAt = performance.now();
    // Moving on by itself only counts what appears after the step began (not a dialog left open).
    const alreadyThere = step.advanceWhen ? Boolean(firstShown(step.advanceWhen)) : true;
    const shift = (box: Box, dx: number, dy: number): Box => ({ x: box.x + dx, y: box.y + dy, w: box.w, h: box.h });
    const measure = () => {
      if (!alive) return;
      if (step.advanceWhen && !alreadyThere && firstShown(step.advanceWhen)) { moveTo(index, index + 1); return; }
      const elapsed = performance.now() - startedAt;
      if (!applies && step.skipUnless) {
        if (firstShown(step.skipUnless)) applies = true;
        else {
          // The sign may still come while the screen is loading.
          if (firstShown('.animate-spin') && elapsed < SKIP_LOADING_MAX_MS) settledAt = 0;
          else if (!settledAt) settledAt = performance.now();
          if (settledAt && performance.now() - settledAt > SKIP_AFTER_MS && !passedOver) {
            passedOver = true;
            const to = index + direction.current;
            moveTo(index, to < firstStep ? index + 1 : to);
          }
          return;
        }
      }
      let target = firstShown(step.target);
      // The target is behind a tab of its own (a sub-menu): open it, once.
      if (!target && step.reveal && !revealClicked && elapsed > REVEAL_AFTER_MS) {
        revealClicked = true;
        firstShown(step.reveal)?.click();
        target = firstShown(step.target);
      }
      const fixedOrigin = fixedProbe.current?.getBoundingClientRect();
      const pageOrigin = pageProbe.current?.getBoundingClientRect();
      if (!fixedOrigin || !pageOrigin) return;
      const visible = visibleRegion(fixedOrigin);
      const vw = window.innerWidth, vh = window.innerHeight;
      if (!target) {
        if (elapsed > MISSING_AFTER_MS && lastKey !== 'missing') { lastKey = 'missing'; setView({ step: index, kind: 'missing' }); }
        return;
      }
      const parts = areaElements(step, target);
      let area = unionBox(parts.map(boxOf), AREA_PAD);
      if (!revealed) {
        revealed = true;
        if (!fullyVisible(area, visible)) {
          const big = area.h > visible.h * 0.8;
          (big ? target : parts[0]).scrollIntoView({ block: big ? 'center' : 'nearest', inline: 'nearest' });
          area = unionBox(parts.map(boxOf), AREA_PAD);
        }
        // The target itself may still be out of sight inside a row that scrolls sideways (the phone menu).
        if (!fullyVisible(boxOf(target), visible)) {
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          area = unionBox(parts.map(boxOf), AREA_PAD);
        }
        // Only with a mouse: on a touch screen a focused field pops up the keyboard (and zooms) uninvited.
        if (step.focus && !step.peek && window.matchMedia?.('(pointer: fine)').matches) {
          window.setTimeout(() => { if (alive) target.focus({ preventScroll: true }); }, 180);
        }
      }
      if (anchorOf?.element !== target) anchorOf = { element: target, anchor: inFixedLayer(target) ? 'fixed' : 'page' };
      const anchor = anchorOf.anchor;
      if (anchor === 'fixed') {
        // Keep the ring on screen (a footer button at the very bottom).
        const x0 = Math.max(visible.x + 3, area.x), y0 = Math.max(visible.y + 3, area.y);
        area = { x: x0, y: y0, w: Math.min(visible.x + visible.w - 3, area.x + area.w) - x0, h: Math.min(visible.y + visible.h - 3, area.y + area.h) - y0 };
      }
      const targetBox = boxOf(target);
      const measured = boxRef.current?.getBoundingClientRect();
      // As wide as fits what the teacher sees (a zoomed phone screen shows fewer CSS pixels).
      const width = Math.round(Math.min(BOX_WIDTH, visible.w - 16));
      const size = { w: width, h: measured && measured.height > 0 ? Math.round(measured.height) : 200 };
      // Measured → drawn: subtract where the layer's 0,0 really is. On the page that stays the same
      // while the page scrolls, so scrolling alone redraws nothing.
      const origin = anchor === 'page' ? pageOrigin : fixedOrigin;
      const dx = -origin.left, dy = -origin.top;
      const canvas = anchor === 'page'
        ? { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }
        : { w: vw, h: vh };
      // On the page, where the visible part is (scrolling) must not re-place anything: it all moves with the page.
      const seen = anchor === 'page' ? [visible.w, visible.h] : [visible.x + dx, visible.y + dy, visible.w, visible.h];
      const key = [anchor, area.x + dx, area.y + dy, area.w, area.h, targetBox.x + dx, targetBox.y + dy, targetBox.w, targetBox.h,
        ...seen, canvas.w, canvas.h, size.w, size.h]
        .map((value) => (typeof value === 'number' ? Math.round(value) : value)).join(',');
      if (key === lastKey) return;
      lastKey = key;
      // Arrow and box go where the teacher can see them: placed within the visible part. An arrow
      // means "press this", so a step only to look at (or an option) has none.
      const local = place(shift(area, -visible.x, -visible.y), shift(targetBox, -visible.x, -visible.y), size, visible.w, visible.h, pointing(step));
      const placed = { arrow: { ...shift(local.arrow, visible.x, visible.y), side: local.arrow.side }, box: shift(local.box, visible.x, visible.y) };
      setView({ step: index, kind: 'shown', anchor, canvas, area: shift(area, dx, dy),
        arrow: { ...shift(placed.arrow, dx, dy), side: placed.arrow.side }, box: shift(placed.box, dx, dy) });
    };
    const loop = () => { measure(); if (alive) frame = requestAnimationFrame(loop); };
    frame = requestAnimationFrame(loop);
    // Phones can pause animation frames while scrolling; scrolling itself measures too.
    const viewport = window.visualViewport;
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
    };
  }, [index, step, moveTo, done, firstStep]);

  // Over a layer that stays put, the dimmed page must not scroll underneath it.
  const dimRef = useRef<SVGPathElement>(null);
  const shownAnchor = view.step === index && view.kind === 'shown' ? view.anchor : null;
  useEffect(() => {
    if (shownAnchor !== 'fixed') return;
    // The dimmed part and the message box: neither scrolls, so a swipe on them must not scroll the page.
    const layers = [dimRef.current, boxRef.current].filter((node): node is SVGPathElement | HTMLDivElement => node !== null);
    const stop = (event: Event) => { if (event.cancelable) event.preventDefault(); };
    for (const layer of layers) {
      layer.addEventListener('wheel', stop, { passive: false });
      layer.addEventListener('touchmove', stop, { passive: false });
    }
    return () => {
      for (const layer of layers) { layer.removeEventListener('wheel', stop); layer.removeEventListener('touchmove', stop); }
    };
  }, [shownAnchor, index]);

  // Esc ends the tutorial (before a dialog under it would take Esc to close itself).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  async function next() {
    if (moving) return;
    if (last) { finish.current(); return; }
    const from = index;
    if (step.next && !firstShown(step.next.wait)) {
      setMoving(true);
      // Only harmless clicks: they open a dialog or a tab, never save anything.
      firstShown(step.next.click ?? step.target)?.click();
      await waitFor(step.next.wait, WAIT_MS);
      setMoving(false);
    }
    moveTo(from, from + 1);
  }

  if (done && after) return <TutorialDone tutorial={tutorial} next={after.next} onNext={after.onNext} onMenu={after.onMenu} onClose={() => close.current()} />;

  const shown = current.kind === 'shown' ? current : null;
  const position = shown?.anchor === 'page' ? 'absolute' : 'fixed';
  const nudge = () => setNudges((count) => count + 1);
  // Buttons named in the text are copied from the screen, nearest to what the step points at.
  const near = shown ? firstShown(step.target) : null;
  const missingText = step.missing ?? '이 단계에서 가리킬 곳이 지금 화면에 없어요. 창을 닫았다면 [이전]으로 돌아가 다시 열거나, [다음]으로 넘어가세요.';

  return (
    <div data-testid="tutorial" data-tutorial-step={`${tutorial.id}:${index + 1}`} data-tutorial-state={current.kind} className="crs-tutorial">
      <div ref={fixedProbe} aria-hidden="true" style={{ position: 'fixed', left: 0, top: 0, width: 1, height: 1, visibility: 'hidden', pointerEvents: 'none' }} />
      <div ref={pageProbe} aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, visibility: 'hidden', pointerEvents: 'none' }} />
      <style>{`
        @keyframes crs-tour-nudge-left { 0%, 100% { transform: translateX(0) } 50% { transform: translateX(7px) } }
        @keyframes crs-tour-nudge-right { 0%, 100% { transform: translateX(0) } 50% { transform: translateX(-7px) } }
        @keyframes crs-tour-nudge-top { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(7px) } }
        @keyframes crs-tour-nudge-bottom { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(-7px) } }
        @keyframes crs-tour-pulse { 0%, 100% { opacity: .95 } 50% { opacity: .55 } }
        @keyframes crs-tour-shake-0 { 0%, 100% { translate: 0 } 20%, 60% { translate: -7px 0 } 40%, 80% { translate: 7px 0 } }
        @keyframes crs-tour-shake-1 { 0%, 100% { translate: 0 } 20%, 60% { translate: -7px 0 } 40%, 80% { translate: 7px 0 } }
      `}</style>
      {shown ? (
        <>
          {/* The dimmed page: it takes the clicks (and nudges the box); the hole over the lit unit lets them through. */}
          <svg aria-hidden="true" className="pointer-events-none z-[76]"
            style={{ position, left: 0, top: 0, width: shown.canvas.w, height: shown.canvas.h }}>
            <path ref={dimRef} fillRule="evenodd" fill="rgb(15 23 42 / 0.62)" className="pointer-events-auto" onPointerDown={nudge}
              d={`M0 0H${shown.canvas.w}V${shown.canvas.h}H0Z ${roundedRect(shown.area, 14)}`} />
            {/* A step only to look at: the lit unit is shown, not used. */}
            {step.peek ? <rect x={shown.area.x} y={shown.area.y} width={shown.area.w} height={shown.area.h} rx="14" fill="rgb(0 0 0 / 0)"
              className="pointer-events-auto" onPointerDown={nudge} /> : null}
            <rect x={shown.area.x} y={shown.area.y} width={shown.area.w} height={shown.area.h} rx="14" fill="none"
              stroke="#FFD43B" strokeWidth="3" style={{ animation: 'crs-tour-pulse 1.6s ease-in-out infinite' }} />
          </svg>
          {pointing(step) ? <TutorialArrow side={shown.arrow.side} box={shown.arrow} position={position} /> : null}
        </>
      ) : null}
      <div ref={boxRef} role="dialog" aria-modal="false" aria-label={`도움말 ${tutorial.id} ${tutorial.title}`}
        style={{ ...(shown ? { position, left: shown.box.x, top: shown.box.y, width: shown.box.w } : { position: 'fixed' as const }),
          ...(nudges ? { animation: `crs-tour-shake-${nudges % 2} .4s ease-in-out` } : {}) }}
        className={cx('z-[78] w-[min(360px,calc(100vw-24px))] rounded-[18px] border border-[var(--crs-line)] bg-[var(--theme-surface)] text-[var(--theme-text)] shadow-[0_18px_48px_rgb(15_23_42/0.35)]',
          !shown && 'bottom-5 left-1/2 -translate-x-1/2', current.kind === 'searching' && step.skipUnless && 'invisible')}>
        <div className="flex items-start gap-2 border-b border-[var(--crs-line)] px-4 pb-2.5 pt-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-bold text-[var(--theme-muted-text)]">도움말 {tutorial.id} {tutorial.title}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[15px] font-black tracking-[-0.02em]">
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--theme-accent-solid)] px-1.5 text-[11px] font-black text-[var(--theme-accent-on-solid)]">{index + 1}</span>
              {step.title}
            </p>
          </div>
          <IconButton icon="close" label="도움말 끝내기" size="sm" onClick={() => close.current()} />
        </div>
        <div aria-live="polite" className="space-y-1.5 px-4 py-3 text-[14px] leading-relaxed">
          {current.kind === 'missing' ? (
            <p className="flex gap-2 text-[13px] text-[var(--theme-muted-text)]"><span className="mt-0.5 shrink-0"><Icon name="info" size={15} /></span><span><TutorialText text={missingText} near={near} /></span></p>
          ) : (
            <>
              {index === 0 ? (
                <p className="mb-2 rounded-[10px] bg-[var(--theme-accent-soft)] px-2.5 py-1.5 text-[12.5px] font-semibold leading-snug text-[var(--theme-accent-text)]">
                  [목표] {tutorial.goal}
                </p>
              ) : null}
              <p><TutorialText text={step.text} near={near} /></p>
              {step.sub ? <p className="text-[12.5px] text-[var(--theme-muted-text)]"><TutorialText text={step.sub} near={near} /></p> : null}
              {step.warn ? (
                <p className="mt-1 flex gap-1.5 rounded-[10px] bg-[var(--crs-warning-bg)] px-2.5 py-2 text-[12.5px] font-semibold text-[var(--crs-warning-text)]">
                  <span className="mt-0.5 shrink-0"><Icon name="alert" size={14} /></span><span><TutorialText text={step.warn} near={near} /></span>
                </p>
              ) : null}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 px-4 pb-3.5">
          <div className="flex flex-1 gap-1" aria-label={`${steps.length}단계 중 ${index + 1}단계`}>
            {steps.map((_, dot) => <span key={dot} className={cx('h-1.5 flex-1 rounded-full', dot <= index ? 'bg-[var(--theme-accent-text)]' : 'bg-[var(--crs-line-strong)]')} />)}
          </div>
          <Button size="sm" variant="ghost" icon="chevronLeft" disabled={index <= firstStep || moving} onClick={() => moveTo(index, index - 1)}>이전</Button>
          <Button size="sm" variant="primary" iconRight={last ? undefined : 'chevronRight'} icon={last ? 'check' : undefined} loading={moving} disabled={moving}
            onClick={() => void next()}>{last ? '마치기' : '다음'}</Button>
        </div>
      </div>
    </div>
  );
}

/** Shown when the tutorial is done: what to learn next, the list, or close. */
function TutorialDone({ tutorial, next, onNext, onMenu, onClose }: {
  tutorial: Tutorial;
  next: Tutorial | null;
  onNext: (id: string) => void;
  onMenu: () => void;
  onClose: () => void;
}) {
  return (
    <div data-testid="tutorial" data-tutorial-step={`${tutorial.id}:done`} data-tutorial-state="done" className="crs-tutorial">
      <div role="dialog" aria-modal="false" aria-label={`도움말 ${tutorial.id} 마침`}
        className="fixed bottom-5 left-1/2 z-[78] w-[min(380px,calc(100vw-24px))] -translate-x-1/2 rounded-[18px] border border-[var(--crs-line)] bg-[var(--theme-surface)] text-[var(--theme-text)] shadow-[0_18px_48px_rgb(15_23_42/0.35)] [animation:crs-pop-in_.18s_ease-out]">
        <div className="flex items-start gap-3 px-4 pt-4">
          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--crs-success-bg)] text-[var(--crs-success-text)]"><Icon name="check" size={18} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-black tracking-[-0.02em]">다 했어요</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--theme-muted-text)]"><b className="font-bold text-[var(--theme-text)]">{tutorial.id} {tutorial.title}</b> 도움말을 마쳤어요.</p>
          </div>
          <IconButton icon="close" label="도움말 닫기" size="sm" onClick={onClose} />
        </div>
        <div className="space-y-2 px-4 pb-4 pt-3">
          {next ? (
            <button type="button" onClick={() => onNext(next.id)}
              className="flex w-full items-center gap-3 rounded-[12px] bg-[var(--theme-accent-solid)] px-3.5 py-2.5 text-left text-[var(--theme-accent-on-solid)] outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]">
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-bold opacity-80">다음 도움말</span>
                <span className="block text-[14px] font-extrabold leading-snug">{next.id} {next.title}</span>
              </span>
              <Icon name="chevronRight" size={18} />
            </button>
          ) : null}
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onMenu}>도움말 목록</Button>
            <Button variant="ghost" className="flex-1" onClick={onClose}>닫기</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function roundedRect(box: Box, radius: number): string {
  const r = Math.min(radius, box.w / 2, box.h / 2);
  const { x, y, w, h } = box;
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

/** An arrow asks the teacher to press or fill in what it points at; explanations and options get none. */
function pointing(step: Tutorial['steps'][number]): boolean {
  return !step.peek && !step.look;
}

const ROTATE: Record<ArrowSide, number> = { left: 0, top: 90, right: 180, bottom: 270 };

/** A big arrow beside the lit unit, pointing at the control, gently nudging toward it. */
function TutorialArrow({ side, box, position }: { side: ArrowSide; box: Box; position: 'fixed' | 'absolute' }): ReactNode {
  return (
    <div aria-hidden="true" className="pointer-events-none z-[77]" style={{ position, left: box.x, top: box.y, width: box.w, height: box.h }}>
      <div style={{ animation: `crs-tour-nudge-${side} 1s ease-in-out infinite` }}>
        <svg viewBox="0 0 48 48" width={box.w} height={box.h} style={{ transform: `rotate(${ROTATE[side]}deg)` }}>
          <path d="M6 18h20V8l18 16-18 16V30H6z" fill="#FFD43B" stroke="#1F2937" strokeWidth="2.5" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}
