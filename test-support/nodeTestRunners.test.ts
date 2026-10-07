// @vitest-environment node
// Native node:test suites run untransformed, with their own assertions intact.
// File-only synthetic recovery; no DB, network, inherited credentials or app flags.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configDefaults } from 'vitest/config';
import config from '../vitest.config.mts';

const suites = [
  { file: 'scripts/task21-synthetic-retained-backup.test.mjs', conditions: [] },
  { file: 'test-support/crs-recovery/retained-store.test.mjs', conditions: ['--conditions=react-server'] },
];
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (args: string[]) => spawnSync(process.execPath, args, {
  cwd: process.cwd(), env: { PATH: process.env.PATH, LANG: 'C.UTF-8', NODE_ENV: 'test' },
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
});

describe('native Node test runner boundary', () => {
  it('routes only the two node:test files away from Vitest while retaining default app isolation', () => {
    expect(config.test?.environment).toBe('jsdom');
    expect(config.test?.exclude).toEqual([...configDefaults.exclude, ...suites.map(({ file }) => file)]);
    expect(config.resolve).not.toHaveProperty('conditions');
    expect(config.resolve).not.toHaveProperty('alias');
  });

  for (const { file, conditions } of suites) {
    it(`executes every native assertion in ${file}`, () => {
      const before = hash(file);
      const args = [...conditions, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--test', '--test-reporter=tap', file];
      const result = run(args);
      // Preserve actual TAP in the default reporter log; structured outer results
      // count this adapter once, not its native children. Report both separately.
      console.info(result.stdout);
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((key) => {
        const matches = [...result.stdout.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
        expect(matches, key).toHaveLength(1);
        return [key, Number(matches[0][1])];
      }));
      expect(counts.tests).toBeGreaterThan(0); expect(counts.pass).toBe(counts.tests);
      for (const key of ['fail', 'cancelled', 'skipped', 'todo']) expect(counts[key], key).toBe(0);
      expect(hash(file)).toBe(before);
      console.info('NODE_TEST_RUNNER_EVIDENCE ' + JSON.stringify({ file, argv: [process.execPath, ...args],
        sourceSha256: before, exitCode: result.status, counts, tapSha256: createHash('sha256').update(result.stdout).digest('hex'),
        scope: 'SYNTHETIC_FILE_ONLY', actualDatabaseExecuted: false }));
    }, 70_000);
  }

  it('still refuses the server-only recovery module in an ordinary Node/client condition', () => {
    const result = run(['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '--eval',
      "await import('./src/server/exports/syntheticPgRecovery.ts')"]);
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
    expect(result.stderr).toContain('This module cannot be imported from a Client Component module.');
  });
});
