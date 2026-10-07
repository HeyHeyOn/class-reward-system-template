// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyLocalFullCategoryDeltaCoverage } from './localFullCategoryDeltaCoverage';

// Only the Next.js environment marker is replaced, never the checker or its results.
vi.mock('server-only', () => ({}));

// GAP-R1: plain, synthetic normalized-shaped rows only; not domain/FK rows,
// source captures, DB evidence, or permission to activate a migration.
// Runtime imports intentionally exclude manifests, writers and database harnesses.
// This leaf import boundary does not certify the shared test runner's isolation.
type Arguments = Parameters<typeof verifyLocalFullCategoryDeltaCoverage>;
type Change = Arguments[2]['changes'][number];
type Fixture = { original: Arguments[0]; candidate: Arguments[1]; plan: Arguments[2] };
type AllowedRow = { taskInstanceId: string; studentId: string; probe: string };
type Counts = { originalCount: number; candidateCount: number; addedCount: number };

function row(taskInstanceId: string, studentId: string, probe = 'retained'): AllowedRow {
  return { taskInstanceId, studentId, probe };
}

// Callers pin both tuple bytes and sorted whole-row bytes independently of the
// checker/catalog. No candidate output or production canonicalizer supplies them.
function added(identity: string, canonicalRow: string): Change {
  return {
    table: 'task_allowed_students',
    identity,
    kind: 'ADDED',
    beforeDigest: null,
    afterDigest: createHash('sha256').update(canonicalRow, 'utf8').digest('hex'),
  };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function fixture(original: AllowedRow[], candidate: AllowedRow[], changes: Change[] = []): Fixture {
  return freeze({
    original: { task_allowed_students: original.map((value) => ({ ...value })) },
    candidate: { task_allowed_students: candidate.map((value) => ({ ...value })) },
    plan: { status: 'DIFF_VALIDATED', changes: changes.map((change) => ({ ...change })), blockers: [] },
  });
}

function verifyPreservingInputs(input: Fixture) {
  const before = JSON.stringify(input);
  try {
    return verifyLocalFullCategoryDeltaCoverage(input.original, input.candidate, input.plan);
  } finally {
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(input)).toBe(true);
    for (const records of [input.original, input.candidate]) {
      expect(Object.isFrozen(records)).toBe(true);
      expect(Object.isFrozen(records.task_allowed_students)).toBe(true);
      expect(records.task_allowed_students.every(Object.isFrozen)).toBe(true);
    }
    expect(Object.isFrozen(input.plan)).toBe(true);
    expect(Object.isFrozen(input.plan.changes)).toBe(true);
    expect(input.plan.changes.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(input.plan.blockers)).toBe(true);
  }
}

function expectAccepted(input: Fixture, counts: Counts) {
  const result = verifyPreservingInputs(input);
  const { coverage, ...boundary } = result;
  expect(boundary).toStrictEqual({
    status: 'COVERED_LOCAL_INPUTS',
    scope: 'LOCAL_NORMALIZED_ADDED_DELTA_COVERAGE_ONLY',
    authority: 'NONAUTHORITY',
    exclusion: 'NOT_PROVEN',
    complete: false,
    activationAllowed: false,
    sourceReconciliation: 'NOT_PERFORMED',
    targetReconciliation: 'NOT_PERFORMED',
  });
  expect(coverage.find((entry) => entry.table === 'task_allowed_students')).toStrictEqual({
    table: 'task_allowed_students', ...counts,
  });
  for (const entry of coverage.filter((entry) => entry.table !== 'task_allowed_students')) {
    expect(entry).toStrictEqual({ table: entry.table, originalCount: 0, candidateCount: 0, addedCount: 0 });
  }
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(coverage)).toBe(true);
  expect(coverage.every(Object.isFrozen)).toBe(true);
}

function expectRefused(input: Fixture) {
  let caught: unknown;
  try {
    verifyPreservingInputs(input);
  } catch (error) {
    caught = error;
  }
  // A generic throw, TypeError, or freeze/assertion failure is not this refusal.
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ name: 'Error', message: 'Local delta coverage refused.' });
}

describe('synthetic NONAUTHORITY composite retained rows (GAP-R1)', () => {
  it('accepts an independently cloned unchanged retained tuple without a change', () => {
    const input = fixture([row('T-A', 'S-A')], [row('T-A', 'S-A')]);
    expect(input.candidate.task_allowed_students[0]).not.toBe(input.original.task_allowed_students[0]);
    expect(input.candidate.task_allowed_students[0]).toStrictEqual(input.original.task_allowed_students[0]);
    expect(input.plan.changes).toStrictEqual([]);
    expectAccepted(input, { originalCount: 1, candidateCount: 1, addedCount: 0 });
  });

  it('accepts an exact ADDED tuple while retaining the original row in a different position', () => {
    const change = added('["T-C","S-C"]', '{"probe":"added","studentId":"S-C","taskInstanceId":"T-C"}');
    const input = fixture(
      [row('T-A', 'S-A')],
      [row('T-C', 'S-C', 'added'), row('T-A', 'S-A')],
      [change],
    );
    expect(input.candidate.task_allowed_students[1]).not.toBe(input.original.task_allowed_students[0]);
    expect(input.candidate.task_allowed_students[1]).toStrictEqual(input.original.task_allowed_students[0]);
    expect(input.plan.changes).toHaveLength(1);
    expectAccepted(input, { originalCount: 1, candidateCount: 2, addedCount: 1 });
  });

  it('rejects count-preserving taskInstanceId replacement despite its exact ADDED plan', () => {
    const original = row('T-A', 'S-A');
    const replacement = row('T-B', 'S-A');
    const change = added('["T-B","S-A"]', '{"probe":"retained","studentId":"S-A","taskInstanceId":"T-B"}');
    expect(replacement).toStrictEqual({ ...original, taskInstanceId: 'T-B' });
    expect(replacement.taskInstanceId).not.toBe(original.taskInstanceId);
    expect(replacement.studentId).toBe(original.studentId);

    // Paired admission control: these exact row/plan bytes are valid ADDED input.
    // Refusal below must not be an incorrect digest, tuple or plan-cardinality test.
    expectAccepted(fixture([], [replacement], [change]), { originalCount: 0, candidateCount: 1, addedCount: 1 });
    const input = fixture([original], [replacement], [change]);
    expect(input.original.task_allowed_students).toHaveLength(1);
    expect(input.candidate.task_allowed_students).toHaveLength(1);
    expect(input.plan.changes).toHaveLength(1);
    expectRefused(input);
  });

  it('rejects count-preserving studentId replacement despite its exact ADDED plan', () => {
    const original = row('T-A', 'S-A');
    const replacement = row('T-A', 'S-B');
    const change = added('["T-A","S-B"]', '{"probe":"retained","studentId":"S-B","taskInstanceId":"T-A"}');
    expect(replacement).toStrictEqual({ ...original, studentId: 'S-B' });
    expect(replacement.studentId).not.toBe(original.studentId);
    expect(replacement.taskInstanceId).toBe(original.taskInstanceId);

    expectAccepted(fixture([], [replacement], [change]), { originalCount: 0, candidateCount: 1, addedCount: 1 });
    const input = fixture([original], [replacement], [change]);
    expect(input.original.task_allowed_students).toHaveLength(1);
    expect(input.candidate.task_allowed_students).toHaveLength(1);
    expect(input.plan.changes).toHaveLength(1);
    expectRefused(input);
  });

  it('rejects a retained non-key mutation even with a separate exact ADDED row', () => {
    const original = row('T-A', 'S-A');
    const mutated = row('T-A', 'S-A', 'changed');
    const extra = row('T-C', 'S-C', 'added');
    const change = added('["T-C","S-C"]', '{"probe":"added","studentId":"S-C","taskInstanceId":"T-C"}');
    expect(mutated).toStrictEqual({ ...original, probe: 'changed' });
    expect(mutated.taskInstanceId).toBe(original.taskInstanceId);
    expect(mutated.studentId).toBe(original.studentId);
    expect(mutated.probe).not.toBe(original.probe);

    expectAccepted(fixture([original], [row('T-A', 'S-A'), extra], [change]), {
      originalCount: 1, candidateCount: 2, addedCount: 1,
    });
    const input = fixture([original], [mutated, extra], [change]);
    expect(input.plan.changes).toHaveLength(1);
    expectRefused(input);
  });

  it('rejects removal of a retained tuple with an otherwise exact empty ADDED plan', () => {
    // Empty candidate/plan is admissible absent a retained-row obligation.
    // This control is not proof that a real source is empty.
    expectAccepted(fixture([], []), { originalCount: 0, candidateCount: 0, addedCount: 0 });
    const input = fixture([row('T-A', 'S-A')], []);
    expect(input.original.task_allowed_students).toHaveLength(1);
    expect(input.candidate.task_allowed_students).toHaveLength(0);
    expect(input.plan.changes).toStrictEqual([]);
    expectRefused(input);
  });
});
