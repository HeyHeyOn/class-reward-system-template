'use client';

import { useEffect, useState } from 'react';
import { TutorialRunner } from './TutorialRunner';
import { tutorialById, type Tutorial } from './tutorials';

/* A tutorial started on the admin screen that runs on another page (1-1 on the class list). */

const PENDING_KEY = 'crs-tutorial-pending';

/** The page a tutorial runs on, when it is not the admin screen. */
export const TUTORIAL_PAGE_HREF: Readonly<Record<NonNullable<Tutorial['page']>, string>> = { classes: '/classes' };

/** Remembers the tutorial for its page (the link to the page is followed right after). */
export function queueTutorial(id: string) {
  try { window.sessionStorage.setItem(PENDING_KEY, id); } catch { /* the page then simply opens without it */ }
}

function takePending(page: NonNullable<Tutorial['page']>): Tutorial | null {
  let id: string | null = null;
  try {
    id = window.sessionStorage.getItem(PENDING_KEY);
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch { return null; }
  const tutorial = id ? tutorialById(id) : null;
  return tutorial?.page === page ? tutorial : null;
}

/** Runs the tutorial the admin screen sent to this page, once. */
export function PendingTutorial({ page }: { page: NonNullable<Tutorial['page']> }) {
  const [tutorial, setTutorial] = useState<Tutorial | null>(null);
  useEffect(() => {
    // After the first paint, so the page's own controls are there to point at.
    const frame = window.requestAnimationFrame(() => setTutorial(takePending(page)));
    return () => window.cancelAnimationFrame(frame);
  }, [page]);
  if (!tutorial) return null;
  return <TutorialRunner key={tutorial.id} tutorial={tutorial} onNavigate={() => {}} onClose={() => setTutorial(null)} />;
}
