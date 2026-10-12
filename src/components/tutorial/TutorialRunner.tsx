'use client';

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AdminTab } from '../admin/adminTypes';
import { Button, Icon, IconButton, cx } from '../ui';
import { areaElements, boxOf, firstShown, inFixedLayer, place, unionBox, type ArrowSide, type Box } from './tutorialDom';
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

const MISSING_AFTER_MS = 2500;
const WAIT_MS = 2500;
const AREA_PAD = 8;

/** **굵게** and [버튼] in the guide's words. */
export function TutorialText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+\])/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('**')) return <b key={index} className="font-extrabold text-[var(--theme-text)]">{part.slice(2, -2)}</b>;
        if (part.startsWith('[')) {
          return (
            <span key={index} className="mx-0.5 inline-block whitespace-nowrap rounded-[7px] border border-[var(--crs-line-strong)] bg-[var(--theme-surface)] px-1.5 text-[0.93em] font-bold text-[var(--theme-text)] shadow-[0_1px_0_var(--crs-line-strong)]">
              {part.slice(1, -1)}
            </span>
          );
        }
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

function fullyVisible(box: Box, vw: number, vh: number): boolean {
  return box.y >= 0 && box.x >= 0 && box.y + box.h <= vh && box.x + box.w <= vw;
}

/**
 * Runs one tutorial over the real admin screen: the step's understanding unit stays lit (and
 * clickable), the rest is dimmed and blocks clicks, an arrow points at the control and a box
 * explains it. 이전/다음 move freely; 끝내기 or Esc stops at any time. Nothing is saved for the
 * teacher — 다음 only ever opens a dialog or a tab.
 */
export function TutorialRunner({ tutorial, onNavigate, onClose }: {
  tutorial: Tutorial;
  onNavigate: (tab: AdminTab) => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [view, setView] = useState<View>({ step: 0, kind: 'searching' });
  const [moving, setMoving] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const navigate = useRef(onNavigate);
  const close = useRef(onClose);
  useEffect(() => { navigate.current = onNavigate; close.current = onClose; });

  const steps = tutorial.steps;
  const step = steps[index];
  const last = index === steps.length - 1;
  const current = view.step === index ? view : { step: index, kind: 'searching' as const };

  /** Moves from `from` to `to` once (a click that already moved on is not counted twice). */
  const moveTo = useCallback((from: number, to: number) => {
    if (to >= steps.length) { close.current(); return; }
    setIndex((now) => (now === from ? Math.max(0, to) : now));
  }, [steps.length]);

  // Each step: show its menu, find its target, keep the light on it as the page moves.
  useEffect(() => {
    let alive = true;
    let frame = 0;
    let lastKey = '';
    let revealed = false;
    let anchorOf: { element: HTMLElement; anchor: Anchor } | null = null;
    if (step.tab) navigate.current(step.tab);
    const startedAt = performance.now();
    // Moving on by itself only counts what appears after the step began (not a dialog left open).
    const alreadyThere = step.advanceWhen ? Boolean(firstShown(step.advanceWhen)) : true;
    const shift = (box: Box, dx: number, dy: number): Box => ({ x: box.x + dx, y: box.y + dy, w: box.w, h: box.h });
    const measure = () => {
      if (!alive) return;
      if (step.advanceWhen && !alreadyThere && firstShown(step.advanceWhen)) { moveTo(index, index + 1); return; }
      const target = firstShown(step.target);
      const vw = window.innerWidth, vh = window.innerHeight;
      if (!target) {
        if (performance.now() - startedAt > MISSING_AFTER_MS && lastKey !== 'missing') { lastKey = 'missing'; setView({ step: index, kind: 'missing' }); }
        return;
      }
      const parts = areaElements(step, target);
      let area = unionBox(parts.map(boxOf), AREA_PAD);
      if (!revealed) {
        revealed = true;
        if (!fullyVisible(area, vw, vh)) {
          const big = area.h > vh * 0.8;
          (big ? target : parts[0]).scrollIntoView({ block: big ? 'center' : 'nearest', inline: 'nearest' });
          area = unionBox(parts.map(boxOf), AREA_PAD);
        }
        if (step.focus) window.setTimeout(() => { if (alive) target.focus({ preventScroll: true }); }, 180);
      }
      if (anchorOf?.element !== target) anchorOf = { element: target, anchor: inFixedLayer(target) ? 'fixed' : 'page' };
      const anchor = anchorOf.anchor;
      if (anchor === 'fixed') {
        // Keep the ring on screen (a footer button at the very bottom).
        const x0 = Math.max(3, area.x), y0 = Math.max(3, area.y);
        area = { x: x0, y: y0, w: Math.min(vw - 3, area.x + area.w) - x0, h: Math.min(vh - 3, area.y + area.h) - y0 };
      }
      const targetBox = boxOf(target);
      const measured = boxRef.current?.getBoundingClientRect();
      const size = measured && measured.width > 0 ? { w: Math.round(measured.width), h: Math.round(measured.height) } : { w: 360, h: 200 };
      // Page coordinates do not change while the page scrolls, so scrolling alone redraws nothing.
      const dx = anchor === 'page' ? window.scrollX : 0, dy = anchor === 'page' ? window.scrollY : 0;
      const canvas = anchor === 'page'
        ? { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }
        : { w: vw, h: vh };
      const key = [anchor, area.x + dx, area.y + dy, area.w, area.h, targetBox.x + dx, targetBox.y + dy, targetBox.w, targetBox.h,
        vw, vh, canvas.w, canvas.h, size.w, size.h].map((value) => (typeof value === 'number' ? Math.round(value) : value)).join(',');
      if (key === lastKey) return;
      lastKey = key;
      const placed = place(area, targetBox, size, vw, vh);
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
  }, [index, step, moveTo]);

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

  const shown = current.kind === 'shown' ? current : null;
  const position = shown?.anchor === 'page' ? 'absolute' : 'fixed';
  const missingText = step.missing ?? '이 단계에서 가리킬 곳이 지금 화면에 없어요. 창을 닫았다면 [이전]으로 돌아가 다시 열거나, [다음]으로 넘어가세요.';

  return (
    <div data-testid="tutorial" data-tutorial-step={`${tutorial.id}:${index + 1}`} data-tutorial-state={current.kind} className="crs-tutorial">
      <style>{`
        @keyframes crs-tour-nudge-left { 0%, 100% { transform: translateX(0) } 50% { transform: translateX(7px) } }
        @keyframes crs-tour-nudge-right { 0%, 100% { transform: translateX(0) } 50% { transform: translateX(-7px) } }
        @keyframes crs-tour-nudge-top { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(7px) } }
        @keyframes crs-tour-nudge-bottom { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(-7px) } }
        @keyframes crs-tour-pulse { 0%, 100% { opacity: .95 } 50% { opacity: .55 } }
      `}</style>
      {shown ? (
        <>
          {/* The dimmed page: it takes the clicks; the hole over the lit unit lets them through. */}
          <svg aria-hidden="true" className="pointer-events-none z-[76]"
            style={{ position, left: 0, top: 0, width: shown.canvas.w, height: shown.canvas.h }}>
            <path ref={dimRef} fillRule="evenodd" fill="rgb(15 23 42 / 0.62)" className="pointer-events-auto"
              d={`M0 0H${shown.canvas.w}V${shown.canvas.h}H0Z ${roundedRect(shown.area, 14)}`} />
            <rect x={shown.area.x} y={shown.area.y} width={shown.area.w} height={shown.area.h} rx="14" fill="none"
              stroke="#FFD43B" strokeWidth="3" style={{ animation: 'crs-tour-pulse 1.6s ease-in-out infinite' }} />
          </svg>
          <TutorialArrow side={shown.arrow.side} box={shown.arrow} position={position} />
        </>
      ) : null}
      <div ref={boxRef} role="dialog" aria-modal="false" aria-label={`튜토리얼 ${tutorial.id} ${tutorial.title}`}
        style={shown ? { position, left: shown.box.x, top: shown.box.y } : { position: 'fixed' }}
        className={cx('z-[78] w-[min(360px,calc(100vw-24px))] rounded-[18px] border border-[var(--crs-line)] bg-[var(--theme-surface)] text-[var(--theme-text)] shadow-[0_18px_48px_rgb(15_23_42/0.35)]',
          !shown && 'bottom-5 left-1/2 -translate-x-1/2')}>
        <div className="flex items-start gap-2 border-b border-[var(--crs-line)] px-4 pb-2.5 pt-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-bold text-[var(--theme-muted-text)]">튜토리얼 · {tutorial.id} {tutorial.title}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[15px] font-black tracking-[-0.02em]">
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--theme-accent-solid)] px-1.5 text-[11px] font-black text-[var(--theme-accent-on-solid)]">{index + 1}</span>
              {step.title}
            </p>
          </div>
          <IconButton icon="close" label="튜토리얼 끝내기" size="sm" onClick={() => close.current()} />
        </div>
        <div aria-live="polite" className="space-y-1.5 px-4 py-3 text-[14px] leading-relaxed">
          {current.kind === 'missing' ? (
            <p className="flex gap-2 text-[13px] text-[var(--theme-muted-text)]"><span className="mt-0.5 shrink-0"><Icon name="info" size={15} /></span><span><TutorialText text={missingText} /></span></p>
          ) : (
            <>
              <p><TutorialText text={step.text} /></p>
              {step.sub ? <p className="text-[12.5px] text-[var(--theme-muted-text)]"><TutorialText text={step.sub} /></p> : null}
              {step.warn ? (
                <p className="mt-1 flex gap-1.5 rounded-[10px] bg-[var(--crs-warning-bg)] px-2.5 py-2 text-[12.5px] font-semibold text-[var(--crs-warning-text)]">
                  <span className="mt-0.5 shrink-0"><Icon name="alert" size={14} /></span><span><TutorialText text={step.warn} /></span>
                </p>
              ) : null}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 px-4 pb-3.5">
          <div className="flex flex-1 gap-1" aria-label={`${steps.length}단계 중 ${index + 1}단계`}>
            {steps.map((_, dot) => <span key={dot} className={cx('h-1.5 flex-1 rounded-full', dot <= index ? 'bg-[var(--theme-accent-text)]' : 'bg-[var(--crs-line-strong)]')} />)}
          </div>
          <Button size="sm" variant="ghost" icon="chevronLeft" disabled={index === 0 || moving} onClick={() => moveTo(index, index - 1)}>이전</Button>
          <Button size="sm" variant="primary" iconRight={last ? undefined : 'chevronRight'} icon={last ? 'check' : undefined} loading={moving} disabled={moving}
            onClick={() => void next()}>{last ? '마치기' : '다음'}</Button>
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
