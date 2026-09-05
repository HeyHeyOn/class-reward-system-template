import { describe, expect, it } from 'vitest';
import {
  finalizeSheetsSnapshot, makeRedis, makeSheets, sha,
} from './__fixtures__/normalization';
import { createLegacyNormalizationManifest } from './manifest';
import { captureSheetsSnapshot, stableRowHash, type SheetsSnapshot } from './sheetsSnapshot';
import { captureRedisClaimSnapshot, type RedisClaimSnapshot } from './redisClaimSnapshot';

const tenantId = '10000000-0000-4000-8000-000000000001';
const migrationJobId = '20000000-0000-4000-8000-000000000001';
const input = (sheets: SheetsSnapshot, redis?: RedisClaimSnapshot) => ({
  tenantId, migrationJobId, sheets, ...(redis ? { redis } : {}),
});
const mutableSheets = () => structuredClone(makeSheets()) as SheetsSnapshot;
const mutableRedis = () => structuredClone(makeRedis()) as RedisClaimSnapshot;
const structuralError = 'Legacy migration input is structurally invalid.';

describe('manifest trust boundary', () => {
  it('builds genuinely signed fixtures after cell mutations without manual repair', () => {
    const original = makeSheets();
    const changed = makeSheets(3, (tabs) => { tabs.Students.rows[0].cells[1] = 'Bob'; });

    expect(changed.tabs.Students.rows[0].hash).not.toBe(original.tabs.Students.rows[0].hash);
    expect(changed.digest).not.toBe(original.digest);
    expect(() => createLegacyNormalizationManifest(input(changed, makeRedis({
      orphanedClaimDigests: ['b'.repeat(64)],
    })))).not.toThrow();
  });

  it('matches artifacts emitted by the Task14 capture functions byte-for-byte', async () => {
    const sheets = makeSheets();
    const capturedSheets = await captureSheetsSnapshot({
      spreadsheetId: sheets.spreadsheetId,
      capturedAt: sheets.capturedAt,
      reader: {
        listSheetNames: async () => Object.keys(sheets.tabs),
        getRows: async (name) => [sheets.tabs[name].headers, ...sheets.tabs[name].rows.map((row) => row.cells)],
        getRevision: async () => sheets.sourceRevision,
      },
    });
    expect(capturedSheets).toEqual(sheets);

    const redis = makeRedis();
    const operation = redis.operationBindings[0];
    const capturedRedis = await captureRedisClaimSnapshot({
      hscan: async () => ({ cursor: '0', entries: [
        [operation.claimField, operation.operationId],
        [`op:${operation.ownerDigest}`, JSON.stringify({ binding: operation.binding, claimField: operation.claimField })],
      ] }),
      scan: async () => ({ cursor: '0', keys: [] }),
      get: async () => null,
      getRevision: async () => redis.sourceRevision,
    }, { capturedAt: redis.capturedAt });
    expect(capturedRedis).toEqual(redis);
  });

  it('rejects forged Sheets artifacts before normalization', () => {
    const corruptions: Array<(sheets: SheetsSnapshot) => void> = [
      (sheets) => { (sheets.tabs.Students.rows[0].cells as string[])[1] = 'Mallory'; },
      (sheets) => { (sheets.tabs.Students.rows[0] as unknown as { hash: string }).hash = 'a'.repeat(64); },
      (sheets) => {
        const prototype = Object.create(Array.prototype) as Record<string, unknown>;
        prototype.hidden = 'secret-value';
        Object.setPrototypeOf(sheets.tabs.Students.rows[0].cells, prototype);
      },
      (sheets) => { (sheets as unknown as { digest: string }).digest = 'b'.repeat(64); },
      (sheets) => { delete (sheets.tabs as unknown as Record<string, unknown>).Students; },
      (sheets) => { (sheets.missingOptionalTabs as string[]).push('TaskAssignments'); },
    ];

    for (const corrupt of corruptions) {
      const sheets = mutableSheets();
      corrupt(sheets);
      expect(() => createLegacyNormalizationManifest(input(sheets))).toThrow(structuralError);
    }
  });

  it('rejects forged Redis artifacts and invalid Task14 Padlet identifiers', () => {
    const corruptions: Array<(redis: RedisClaimSnapshot) => void> = [
      (redis) => { (redis as unknown as { digest: string }).digest = 'a'.repeat(64); },
      (redis) => { (redis.v2Claims[0] as unknown as { tupleDigest: string }).tupleDigest = 'b'.repeat(64); },
      (redis) => { (redis.v2Claims[0] as unknown as { boardId: string }).boardId = 'BOARD-1'; },
      (redis) => { (redis.operationBindings[0].binding.evidence as unknown as { evidencePostId: string }).evidencePostId = 'x'; },
    ];
    for (const corrupt of corruptions) {
      const redis = mutableRedis();
      corrupt(redis);
      expect(() => createLegacyNormalizationManifest(input(makeSheets(), redis))).toThrow(structuralError);
    }
  });

  it('accepts only the exact supported credential hash object', () => {
    const validDraft = mutableSheets();
    const credentialHashes = Object.assign(Object.create(null), {
      adminPasswordHash: `scrypt$16384$8$1$${'a'.repeat(32)}$${'b'.repeat(64)}`,
      recoveryCodeHash: 'c'.repeat(64),
    });
    (validDraft as unknown as Record<string, unknown>).credentialHashes = credentialHashes;
    const adminRow = validDraft.tabs.Settings.rows.find((row) => row.cells[0] === 'adminPasswordHash')!;
    const recoveryRow = validDraft.tabs.Settings.rows.find((row) => row.cells[0] === 'recoveryCodeHash')!;
    (adminRow.cells as string[])[1] = credentialHashes.adminPasswordHash;
    (recoveryRow.cells as string[])[1] = credentialHashes.recoveryCodeHash;
    const valid = finalizeSheetsSnapshot(validDraft);
    expect(() => createLegacyNormalizationManifest(input(valid))).not.toThrow();

    for (const credentialHashes of [
      { password: 'plaintext-secret' },
      { adminPasswordHash: 'plaintext-secret' },
      { recoveryCodeHash: 'A'.repeat(64) },
    ]) {
      const sheets = mutableSheets() as unknown as Record<string, unknown>;
      sheets.credentialHashes = credentialHashes;
      expect(() => createLegacyNormalizationManifest(input(sheets as unknown as SheetsSnapshot))).toThrow(structuralError);
    }

    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'adminPasswordHash', { enumerable: true, get: () => 'do-not-read-this-secret' });
    const sheets = mutableSheets() as unknown as Record<string, unknown>;
    sheets.credentialHashes = accessor;
    expect(() => createLegacyNormalizationManifest(input(sheets as unknown as SheetsSnapshot))).toThrow(structuralError);
  });

  it('accepts an empty null-prototype credential hash object', () => {
    const draft = mutableSheets();
    (draft as unknown as Record<string, unknown>).credentialHashes = Object.create(null);
    (draft.tabs.Settings as unknown as { rows: typeof draft.tabs.Settings.rows }).rows = draft.tabs.Settings.rows
      .filter((row) => !['adminPasswordHash', 'recoveryCodeHash'].includes(row.cells[0]));
    const manifest = createLegacyNormalizationManifest(input(finalizeSheetsSnapshot(draft)));
    expect(manifest.sourceArtifacts.sheets.credentialHashes).toEqual({});
  });

  it('rejects recursively corrupted nested snapshots with one generic diagnostic', () => {
    const corruptions: Array<(sheets: SheetsSnapshot, redis: RedisClaimSnapshot) => void> = [
      (sheets) => { (sheets as unknown as Record<string, unknown>).capturedAt = 'not-an-instant'; },
      (sheets) => { (sheets as unknown as Record<string, unknown>).digest = 'A'.repeat(64); },
      (sheets) => { (sheets.tabs.Students.rows[0] as unknown as Record<string, unknown>).hash = 'bad-hash'; },
      (sheets) => { (sheets.tabs.Students.rows[0] as unknown as Record<string, unknown>).extra = true; },
      (sheets) => { Object.defineProperty(sheets.tabs.Students.rows[0], 'cells', { enumerable: true, get: () => ['secret'] }); },
      (sheets) => { (sheets.tabs.Students.rows[0].cells as string[]).length += 1; },
      (_sheets, redis) => { (redis.operationBindings[0] as unknown as Record<string, unknown>).payloadHash = sha('missing-prefix'); },
      (_sheets, redis) => { (redis.operationBindings[0].binding.evidence as unknown as Record<string, unknown>).evidenceProvider = 'OTHER'; },
      (_sheets, redis) => { (redis.v2Claims[0] as unknown as Record<string, unknown>).sourceProvenance = 'wrong'; },
      (_sheets, redis) => { (redis as unknown as Record<string, unknown>).unexpected = 'secret-value'; },
      (sheets) => { Object.defineProperty(sheets.tabs, Symbol('secret'), { value: 'secret-value' }); },
      (sheets) => {
        (sheets.tabs as unknown as Record<string, unknown>).Students = new Proxy(sheets.tabs.Students, {
          ownKeys: () => { throw new Error('secret-value'); },
        });
      },
    ];

    for (const corrupt of corruptions) {
      const sheets = mutableSheets();
      const redis = mutableRedis();
      corrupt(sheets, redis);
      let error: unknown;
      try { createLegacyNormalizationManifest(input(sheets, redis)); } catch (caught) { error = caught; }
      expect(error).toEqual(new Error(structuralError));
      expect(String(error)).not.toContain('secret-value');
    }
  });

  it('rejects cycles generically instead of overflowing', () => {
    const sheets = mutableSheets();
    (sheets.tabs.Students as unknown as Record<string, unknown>).cycle = sheets.tabs;
    expect(() => createLegacyNormalizationManifest(input(sheets))).toThrow(structuralError);
  });

  it.each([
    ['nulls', null],
    ['booleans', true],
    ['numbers', 1],
  ])('bounds dense hostile primitive arrays of %s before shape validation', (_label, primitive) => {
    const hostile = { ...input(makeSheets()), extra: Array(300_001).fill(primitive) };
    expect(() => createLegacyNormalizationManifest(hostile as never))
      .toThrow('Legacy migration input exceeds normalization bounds.');
  });

  it('accounts for property names and rejects descriptor hazards without exposing secrets', () => {
    const named: Record<string, unknown> = Object.create(null);
    for (let index = 0; index < 4_100; index += 1) named[`${String(index).padStart(4, '0')}-${'k'.repeat(1_000)}`] = null;
    expect(() => createLegacyNormalizationManifest({ ...input(makeSheets()), extra: named } as never))
      .toThrow('Legacy migration input exceeds normalization bounds.');

    for (const extra of [
      new Proxy(Object.create(null), { ownKeys: () => { throw new Error('proxy-secret'); } }),
      Object.defineProperty(Object.create(null), 'secret', { enumerable: true, get: () => 'accessor-secret' }),
    ]) {
      let error: unknown;
      try { createLegacyNormalizationManifest({ ...input(makeSheets()), extra } as never); } catch (caught) { error = caught; }
      expect(error).toEqual(new Error(structuralError));
      expect(String(error)).not.toMatch(/proxy-secret|accessor-secret/);
    }
  });

  it('rejects an authentically signed excessive header artifact generically before diagnostic expansion', () => {
    const sheets = mutableSheets();
    const extraHeaders = Array.from({ length: 257 }, (_, index) => `hostile-${index}`);
    (sheets.tabs.Students as unknown as { headers: string[] }).headers = extraHeaders;
    (sheets.tabs.Students.rows[0] as unknown as { cells: string[] }).cells = extraHeaders.map(() => 'x');
    const signed = finalizeSheetsSnapshot(sheets);

    let error: unknown;
    try { createLegacyNormalizationManifest(input(signed)); } catch (caught) { error = caught; }
    expect(error).toEqual(new Error(structuralError));
    expect(String(error)).not.toContain('UNKNOWN_HEADER');
    expect(JSON.stringify(error).length).toBeLessThan(200);
  });

  it('lets structurally valid malformed legacy cells reach normalization diagnostics', () => {
    const sheets = mutableSheets();
    (sheets.tabs.Adjustments.rows[0].cells as string[])[3] = '1.5';
    const manifest = createLegacyNormalizationManifest(input(finalizeSheetsSnapshot(sheets)));
    expect(manifest.blockingConflicts.map(({ code }) => code)).toContain('MALFORMED_REQUIRED_HISTORY');
  });

  it('deeply detaches normalized records and Redis evidence without freezing the caller', () => {
    const sheets = mutableSheets();
    const redis = mutableRedis();
    const callerBinding = redis.operationBindings[0].binding;
    const callerEvidence = callerBinding.evidence;
    const manifest = createLegacyNormalizationManifest(input(sheets, redis));
    const exportedBinding = manifest.records.legacy_operation_bindings[0].binding as {
      taskId: string; evidence: { evidenceAuthorFullName: string };
    };

    expect(Object.isFrozen(sheets)).toBe(false);
    expect(Object.isFrozen(redis)).toBe(false);
    expect(Object.isFrozen(callerBinding)).toBe(false);
    expect(Object.isFrozen(callerEvidence)).toBe(false);
    expect(exportedBinding).not.toBe(callerBinding);
    expect(exportedBinding.evidence).not.toBe(callerEvidence);
    (callerBinding as unknown as { taskId: string }).taskId = 'CHANGED';
    (callerEvidence as unknown as { evidenceAuthorFullName: string }).evidenceAuthorFullName = 'Changed';
    expect(exportedBinding.taskId).toBe('T1');
    expect(exportedBinding.evidence.evidenceAuthorFullName).toBe('Alice');
  });

  it('keeps physical artifact digests while fingerprinting semantic normalized output', () => {
    const make = (reverse: boolean) => makeSheets(3, (tabs) => {
      const first = tabs.Students.rows[0];
      const cells = ['S2', 'Bob', '0', 'INACTIVE'];
      const second = { rowNumber: 3, cells, hash: stableRowHash(cells) };
      tabs.Students.rows = reverse ? [second, first] : [first, second];
    });
    const leftSheets = make(false);
    const rightSheets = make(true);
    const left = createLegacyNormalizationManifest(input(leftSheets));
    const right = createLegacyNormalizationManifest(input(rightSheets));

    expect(left.sourceArtifacts.sheets.digest).toBe(leftSheets.digest);
    expect(right.sourceArtifacts.sheets.digest).toBe(rightSheets.digest);
    expect(leftSheets.digest).not.toBe(rightSheets.digest);
    expect(left.sourceFingerprint).toBe(right.sourceFingerprint);
  });
});
