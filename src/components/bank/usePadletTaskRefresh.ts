'use client';

import { useEffect } from 'react';

/** Observe response-time background syncs without polling hidden or unrelated screens. */
export function usePadletTaskRefresh(enabled: boolean, refresh: () => Promise<void>): void {
  useEffect(() => {
    if (!enabled) return;
    let pending = false;
    let stopped = false;
    const check = async () => {
      if (stopped || pending || document.visibilityState === 'hidden') return;
      pending = true;
      try { await refresh(); } finally { pending = false; }
    };
    const onVisible = () => { void check(); };
    const timer = window.setInterval(onVisible, 20_000);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, refresh]);
}
