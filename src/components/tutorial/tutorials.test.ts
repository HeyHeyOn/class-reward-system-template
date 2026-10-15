import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_TUTORIAL_ID, TUTORIAL_CHAPTERS, TUTORIALS, tutorialAfter, tutorialById, tutorialUsable, type TutorialStep } from './tutorials';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [readFileSync(path, 'utf8')] : [];
  });
}

const selectorsOf = (step: TutorialStep) => [
  ...(typeof step.target === 'string' ? [step.target] : step.target),
  ...(step.area ?? []).flatMap((part) => (typeof part === 'string' ? (part.startsWith('@') ? [] : [part]) : [part.closest])),
  ...(step.next ? [step.next.wait, ...(step.next.click ? [step.next.click] : [])] : []),
  ...(step.advanceWhen ? [step.advanceWhen] : []),
  ...(step.skipUnless ? [step.skipUnless] : []),
  ...(step.reveal ? [step.reveal] : []),
];

describe('tutorials', () => {
  it('has a tutorial for every section of the table of contents, in its order and under its title', () => {
    const listed = TUTORIAL_CHAPTERS.flatMap((chapter) => chapter.items);
    expect(new Set(listed.map(([no]) => no)).size).toBe(listed.length);
    expect(TUTORIALS.map((tutorial) => tutorial.id)).toEqual(listed.map(([no]) => no));
    for (const [no, title] of listed) expect(TUTORIALS.find((tutorial) => tutorial.id === no)?.title).toBe(title);
  });

  it('starts every tutorial where the teacher finds the screen: the menu (or the class list logo, the shortcuts)', () => {
    for (const tutorial of TUTORIALS) {
      const first = tutorial.steps[0];
      const targets = typeof first.target === 'string' ? [first.target] : first.target;
      // The tour starts by showing the menu as a whole, then picks its first screen there.
      const menuStep = tutorial.id === FIRST_TUTORIAL_ID ? tutorial.steps[1] : first;
      const menuTargets = typeof menuStep.target === 'string' ? [menuStep.target] : menuStep.target;
      const where = tutorial.id === '1-1' ? 'a[aria-label="딴쌤 홈"]' : tutorial.id === '9-1' ? 'shortcuts' : '#admin-tab-';
      expect(tutorial.id === '9-1' ? targets.some((target) => target.includes('shortcuts')) : menuTargets.some((target) => target.startsWith(where)), tutorial.id).toBe(true);
      // The menu step is chosen by the teacher: it moves on once that screen opens, or when the
      // menu is pressed while it is open already (no "already open? press 다음" line needed).
      if (where === '#admin-tab-') {
        expect(menuStep.advanceWhen, tutorial.id).toMatch(/^#admin-panel-/);
        expect(menuStep.clickMovesOn, tutorial.id).toBe(true);
      }
    }
  });

  it('points an arrow only where the step tells the teacher to do something', () => {
    // An arrow reads as "press this": explanations (peek) and options (look) have none, and every
    // step that keeps one says what to do (…세요).
    for (const tutorial of TUTORIALS) {
      for (const [index, step] of tutorial.steps.entries()) {
        if (step.peek || step.look) continue;
        expect(step.text, `${tutorial.id}:${index + 1} ${step.title}`).toMatch(/세요/);
      }
    }
    // The first-time tour only shows: its arrows are on the menu items the teacher picks.
    for (const step of TUTORIALS.find((tutorial) => tutorial.id === FIRST_TUTORIAL_ID)!.steps) {
      if (!step.peek) expect(String(step.target)).toMatch(/^#admin-tab-/);
    }
  });

  it('never tells the teacher to press 다음 because a screen is open already', () => {
    for (const tutorial of TUTORIALS) {
      for (const step of tutorial.steps) expect(`${step.text} ${step.sub ?? ''}`, `${tutorial.id} ${step.title}`).not.toMatch(/이미 .*(열려|이면).*\[다음\]/);
    }
  });

  it('goes on to the class list only from 1-1, and runs nothing there that needs the admin menu', () => {
    expect(TUTORIALS.filter((tutorial) => tutorial.steps.some((step) => step.opensPage)).map((tutorial) => tutorial.id)).toEqual(['1-1']);
    const steps = TUTORIALS.find((tutorial) => tutorial.id === '1-1')!.steps;
    expect(steps[0].opensPage).toBe('classes');
    for (const step of steps.slice(1)) expect(step.tab).toBeUndefined();
  });

  it('offers what to learn next: the tour suggests the setup, ledger tutorials only where the ledger is', () => {
    const everywhere = { ledgerMode: true, classList: true };
    expect(tutorialAfter(tutorialById(FIRST_TUTORIAL_ID)!, everywhere)?.id).toBe('2-1');
    expect(tutorialAfter(tutorialById('4-4')!, everywhere)?.id).toBe('5-0');
    expect(tutorialAfter(tutorialById('4-4')!, { ledgerMode: false, classList: true })?.id).toBe('6-1');
    expect(tutorialAfter(tutorialById('9-1')!, everywhere)).toBeNull();
    expect(tutorialUsable(tutorialById('1-1')!, { ledgerMode: true, classList: false })).toBe(false);
  });

  it('gives every step something to point at and words to say', () => {
    for (const tutorial of TUTORIALS) {
      expect(tutorial.steps.length).toBeGreaterThan(1);
      for (const step of tutorial.steps) {
        expect(step.title.trim()).not.toBe('');
        expect(step.text.trim()).not.toBe('');
        expect(selectorsOf(step).length).toBeGreaterThan(0);
        for (const selector of selectorsOf(step)) expect(() => document.querySelector(selector)).not.toThrow();
      }
    }
  });

  it('points only at tour hooks that the screens really have', () => {
    const code = sources(join(process.cwd(), 'src/components')).join('\n');
    const hooks = new Set(TUTORIALS.flatMap((tutorial) => tutorial.steps.flatMap(selectorsOf))
      .flatMap((selector) => [...selector.matchAll(/data-tour="([^"]+)"/g)].map((match) => match[1])));
    expect(hooks.size).toBeGreaterThan(10);
    for (const hook of hooks) {
      const present = code.includes(`data-tour="${hook}"`) || code.includes(`tour="${hook}"`)
        || (hook.startsWith('sheet-tab-') && code.includes('data-tour={`sheet-tab-${tab}`}'));
      expect(present, hook).toBe(true);
    }
  });
});
