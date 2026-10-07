import { describe, expect, it } from 'vitest';
import * as snapshots from './sheetsSnapshot';
import { createLegacyNormalizationManifest } from './manifest';
import { makeSupportedSheets } from './__fixtures__/normalization';
import { normalizeLegacySnapshots } from './normalize';
import { canonicalJson } from './validators';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import { createBudgetContext } from '@/lib/boundedWork';

const workbook = (version: number) => Object.fromEntries(Object.entries(makeSupportedSheets().tabs)
  .map(([name, tab]) => [name, [tab.headers, ...tab.rows.map(row => name === 'Settings'
    && row.cells[0] === 'schemaVersion' ? ['schemaVersion', String(version)] : row.cells)]]));

describe('schema 4 and explicitly offline Sheets rehearsal', () => {
  it('supports version 4 unchanged at the live capture/normalizer boundary', async () => {
    const tabs = workbook(4);
    const sheets = await snapshots.captureSheetsSnapshot({ spreadsheetId: 'synthetic-sheet',
      capturedAt: '2026-09-29T00:00:00.000Z', reader: { listSheetNames: async () => Object.keys(tabs),
        getRows: async name => tabs[name], getRevision: async () => 'synthetic-revision' } });
    expect(sheets.schemaVersion).toBe(4);
    const manifest = createLegacyNormalizationManifest({ tenantId: '10000000-0000-4000-8000-000000000001', migrationJobId: '20000000-0000-4000-8000-000000000001', sheets });
    expect(manifest.metadata.sheetSchemaVersion).toBe(4);
    expect(manifest.status).toBe('READY_FOR_IMPORT');
  });
  it('provides an offline entry that never asks for a Google revision', () => {
    expect(snapshots).toHaveProperty('captureOfflineSheetsBaseline');
  });
  it('validates and normalizes offline v4 identically through the registered budget path', async () => {
    const sheets = await snapshots.captureOfflineSheetsBaseline({ spreadsheetId: 'synthetic-sheet',
      capturedAt: '2026-09-29T00:00:00.000Z', contentSha256: 'a'.repeat(64), tabs: workbook(4) });
    const input = { tenantId: '10000000-0000-4000-8000-000000000001', migrationJobId: '20000000-0000-4000-8000-000000000001', sheets };
    const budget = createBudgetContext({ now: () => 0 });
    const registered = parseRegisteredBoundedJson(JSON.stringify(input), budget) as Parameters<typeof normalizeLegacySnapshots>[0];
    expect(canonicalJson(normalizeLegacySnapshots(registered, budget))).toBe(canonicalJson(normalizeLegacySnapshots(input)));
  });
  it('rejects invented Google revision and freeze authority on an offline snapshot', async () => {
    const sheets = await snapshots.captureOfflineSheetsBaseline({ spreadsheetId: 'synthetic-sheet',
      capturedAt: '2026-09-29T00:00:00.000Z', contentSha256: 'a'.repeat(64), tabs: workbook(4) });
    const input = { tenantId: '10000000-0000-4000-8000-000000000001', migrationJobId: '20000000-0000-4000-8000-000000000001', sheets };
    for (const patch of [{ googleDriveVersion: 'invented' }, { writerFreezeProven: true }, { redisClaims: 'COMPLETE' }]) {
      const draft = JSON.parse(JSON.stringify(input));
      Object.assign(draft.sheets.offlineBaseline, patch);
      expect(() => createLegacyNormalizationManifest(draft)).toThrow(/structurally invalid/);
    }
  });
  it.each([0, 5, 999])('continues to reject unsupported schema %s', async version => {
    const tabs = workbook(version);
    await expect(snapshots.captureSheetsSnapshot({ spreadsheetId: 'synthetic-sheet',
      capturedAt: '2026-09-29T00:00:00.000Z', reader: { listSheetNames: async () => Object.keys(tabs),
        getRows: async name => tabs[name], getRevision: async () => 'synthetic-revision' } })).rejects.toThrow(/schema version/i);
  });
});
