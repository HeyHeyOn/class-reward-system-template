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
];

describe('tutorials', () => {
  it('lists every tutorial in the table of contents, and every listed section once', () => {
    const listed = TUTORIAL_CHAPTERS.flatMap((chapter) => chapter.items.map(([no]) => no));
    expect(new Set(listed).size).toBe(listed.length);
    for (const tutorial of TUTORIALS) expect(listed).toContain(tutorial.id);
    expect(TUTORIALS.map((tutorial) => tutorial.id)).toEqual(['2-1', '3-1', '3-5', '4-1', '5-1', '5-4', '6-1', '9-1']);
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
      const present = code.includes(`data-tour="${hook}"`) || (hook.startsWith('sheet-tab-') && code.includes('data-tour={`sheet-tab-${tab}`}'));
      expect(present, hook).toBe(true);
    }
  });
});
