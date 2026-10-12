'use client';

import { useEffect, useState } from 'react';
import { TutorialRunner } from './TutorialRunner';
import { takeQueuedTutorial } from './tutorialQueue';
import { tutorialById, type Tutorial } from './tutorials';

/* A tutorial that left the admin screen for this page (1-1 goes on on the class list). */

/** Runs the tutorial the admin screen sent to this page, from the step it got to. */
export function PendingTutorial() {
  const [run, setRun] = useState<Readonly<{ tutorial: Tutorial; step: number }> | null>(null);
  useEffect(() => {
    // After the first paint, so the page's own controls are there to point at.
    const frame = window.requestAnimationFrame(() => {
      const queued = takeQueuedTutorial();
      const tutorial = queued ? tutorialById(queued.id) : null;
      if (tutorial && queued && queued.step < tutorial.steps.length) setRun({ tutorial, step: queued.step });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  if (!run) return null;
  return <TutorialRunner key={run.tutorial.id} tutorial={run.tutorial} firstStep={run.step} onNavigate={() => {}} onClose={() => setRun(null)} />;
}
