import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TUTORIAL_CHAPTERS, TUTORIALS, type TutorialStep } from './tutorials';

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

  it('opens the class list for the tutorial that runs there, and nothing else', () => {
    expect(TUTORIALS.filter((tutorial) => tutorial.page).map((tutorial) => tutorial.id)).toEqual(['1-1']);
    for (const step of TUTORIALS.find((tutorial) => tutorial.id === '1-1')!.steps) expect(step.tab).toBeUndefined();
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
