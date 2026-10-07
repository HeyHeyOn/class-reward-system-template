import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBudgetContext } from '@/lib/boundedWork';
import { parseBoundedJson } from '@/lib/boundedJson';
import oracle from './__fixtures__/normalization-budget-golden.json';
import { createLegacyNormalizationManifest } from './manifest';
import { canonicalJson } from './validators';

type Input = Parameters<typeof createLegacyNormalizationManifest>[0];

// Captured before production edits by p0-oracle.test.ts in a byte-exact frozen
// HEAD tree. Never regenerate this fixture by invoking the changed implementation.
// These are already-GREEN no-budget/decoder parity tests, NOT evidence that the
// normalizer has optional budget guards (that integration remains unimplemented).
describe('frozen HEAD normalization parity — unbounded normalizer', () => {
  it('pins the pre-edit oracle bytes independently of the current implementation', () => {
    expect(oracle.head).toBe('448cbed7bd303ad0f9ef3fd4c974c313bf4c8da8');
    const bytes = readFileSync(resolve('src/server/migration/__fixtures__/normalization-budget-golden.json'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('4e1d3373da7297819c2b20850b37d36c67b33d3ef981519d0a0a89c7e54d2487');
  });
  it.each(oracle.results)('preserves bytes, fingerprints, and all embedded item/claim IDs: $name', (fixture) => {
    const result = createLegacyNormalizationManifest(fixture.input as unknown as Input);
    expect(canonicalJson(result)).toBe(fixture.bytes);
    expect(result.manifestDigest).toBe(fixture.manifestDigest);
    expect(result.sourceFingerprint).toBe(fixture.sourceFingerprint);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sourceRecords)).toBe(true);
  });
  it.each(oracle.results)('preserves input meaning through lexical admission: $name', (fixture) => {
    const budget = createBudgetContext({ now: () => 0 });
    const input = parseBoundedJson(JSON.stringify(fixture.input), budget) as Input;
    // Explicitly no budget argument: this proves decoder parity only.
    const result = createLegacyNormalizationManifest(input);
    expect(canonicalJson(result)).toBe(fixture.bytes);
    expect(budget.usage().nodes).toBeGreaterThan(130);
    expect(result.sourceArtifacts.sheets.credentialHashes).not.toBe(input.sheets.credentialHashes);
  });
});
