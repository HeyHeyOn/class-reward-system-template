'use client';

import { useEffect, type CSSProperties, type RefObject } from 'react';

// 알림 (ddanssaem-brand README '창 고르기와 상호작용'): notices sit at the bottom centre of the screen, above
// whatever is docked there (the 여러 개 고르기 bar, the settings save bar, the finished-help card, a notice
// banner). Each docked thing reports how much of the bottom it takes; notices rise above the tallest.

const docked = new Map<symbol, number>();
const VARIABLE = '--crs-bottom-dock';

function publish() {
  const tallest = Math.max(0, ...docked.values());
  if (tallest > 0) document.documentElement.style.setProperty(VARIABLE, `${tallest}px`);
  else document.documentElement.style.removeProperty(VARIABLE);
}

/** While `active`, the element (placed `gap` pixels above the screen's bottom) keeps notices above it. */
export function useBottomDock(ref: RefObject<HTMLElement | null>, gap: number, active = true): void {
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    const id = Symbol('bottom-dock');
    const measure = () => { docked.set(id, element.offsetHeight + gap); publish(); };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      docked.delete(id);
      publish();
    };
  }, [ref, gap, active]);
}

/** Where the notice stack sits: the bottom centre, 16px (or the phone's safe area) above whatever is docked. */
export const NOTICE_DOCK_STYLE: CSSProperties = {
  bottom: `calc(max(1rem, env(safe-area-inset-bottom)) + var(${VARIABLE}, 0px))`,
  transition: 'bottom .18s ease-out',
};
