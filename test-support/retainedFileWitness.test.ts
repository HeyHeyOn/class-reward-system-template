// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { expectRetainedFilesUnchanged } from './retainedFileWitness';

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true }); });
function fixture(count = 4) {
  const root = mkdtempSync(join(tmpdir(), 'retained-witness-')); owned.push(root);
  for (let index = 0; index < count; index++) writeFileSync(join(root, `${index}.sql`), `SELECT ${index};\n`);
  let reads = 0;
  const capture = vi.fn(() => Object.fromEntries(readdirSync(root).sort().map(name => {
    reads++;
    return [name, createHash('sha256').update(readFileSync(join(root, name))).digest('hex')];
  })));
  const before = capture(); capture.mockClear(); reads = 0;
  return { root, before, capture, reads: () => reads };
}
it.each([4, 32])('reads each real artifact once per phase for %s inherited files, accepting only extra paths', count => {
  const f = fixture(count);
  writeFileSync(join(f.root, 'new.sql'), 'SELECT 100;\n');
  expectRetainedFilesUnchanged(f.before, f.capture);
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.reads()).toBe(count + 1);
});
it.each(['changed', 'missing'])('rejects a %s inherited file even when other files are intact', kind => {
  const f = fixture();
  if (kind === 'changed') writeFileSync(join(f.root, '3.sql'), 'SELECT 999;\n');
  else unlinkSync(join(f.root, '3.sql'));
  expect(() => expectRetainedFilesUnchanged(f.before, f.capture)).toThrow(/3\.sql/);
});
it('takes a fresh snapshot after intervening work rather than reusing earlier success', () => {
  const f = fixture();
  expectRetainedFilesUnchanged(f.before, f.capture);
  writeFileSync(join(f.root, '2.sql'), 'SELECT 999;\n');
  expect(() => expectRetainedFilesUnchanged(f.before, f.capture)).toThrow(/2\.sql/);
});
it('rejects a changed directory witness and propagates unreadable-tree errors', () => {
  expect(() => expectRetainedFilesUnchanged({ directory: 'directory' }, () => ({ directory: 'file digest' }))).toThrow(/directory/);
  const failure = new Error('unreadable tree');
  expect(() => expectRetainedFilesUnchanged({ file: 'digest' }, () => { throw failure; })).toThrow(failure);
});
