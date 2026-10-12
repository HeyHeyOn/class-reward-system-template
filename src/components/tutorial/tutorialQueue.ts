/*
 * A tutorial that goes on on another page (1-1 leaves the admin screen for the class list) is handed
 * over through the tab's session storage: which tutorial, and the step to go on from.
 */

const PENDING_KEY = 'crs-tutorial-pending';

export type QueuedTutorial = Readonly<{ id: string; step: number }>;

export function queueTutorial(queued: QueuedTutorial) {
  try { window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(queued)); } catch { /* the page then simply opens without it */ }
}

export function clearQueuedTutorial() {
  try { window.sessionStorage.removeItem(PENDING_KEY); } catch { /* nothing was kept */ }
}

/** The handed-over tutorial, once: reading it forgets it. */
export function takeQueuedTutorial(): QueuedTutorial | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(PENDING_KEY);
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch { return null; }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<QueuedTutorial>;
    return typeof value.id === 'string' && Number.isSafeInteger(value.step) && (value.step as number) >= 0 ? { id: value.id, step: value.step as number } : null;
  } catch { return null; }
}
