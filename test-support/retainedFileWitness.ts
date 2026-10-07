import { expect } from 'vitest';

// A phase checks every inherited path while allowing this test's new artifacts.
// Capture is deliberately called again at each phase, never cached across work.
export function expectRetainedFilesUnchanged(before: Record<string, string>, capture: () => Record<string, string>) {
  const after = capture();
  for (const [path, digest] of Object.entries(before)) expect(after[path], path).toBe(digest);
}
