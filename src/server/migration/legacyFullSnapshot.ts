import type { LegacyFinancialReview } from './legacyFinancialHistory';
import 'server-only';
import { readOfflineGoogleGrid } from './offlineGoogleGrid';
import { captureOfflineSheetsBaseline } from './sheetsSnapshot';
import { normalizeLegacySnapshots } from './normalize';
import { parseLegacyFinancialHistory } from './legacyFinancialHistory';
import { parseLegacyTaskHistory } from './legacyTaskHistory';
import { canonicalJson, sha256 } from './validators';

const historyTabs = new Set(['Transactions', 'TaskAssignments', 'TaskCompletions']);
const allTabs = ['Students', 'Products', 'Transactions', 'Adjustments', 'Settings', 'Tasks',
  'TaskAssignments', 'TaskCompletions', 'Promotions', 'PromotionProducts'];
type CurrentTable = 'students' | 'accounts' | 'products' | 'tasks' | 'task_allowed_students'
  | 'promotions' | 'promotion_products' | 'settings';

/** Complete Sheets projection for a private importer. Redis acquisition and
 * writer exclusion are deliberately not inferred from a historical grid.
 * The old manifest/diagnostics remain unchanged; typed historical parsers now
 * validate the source slices that its modern-operation contract did not admit.
 */
export async function parseLegacyFullSnapshot(input: {
  tenantId: string; migrationJobId: string; gridJson: string; capturedAt: string; financialReview?: LegacyFinancialReview;
}) {
  const grid = readOfflineGoogleGrid(input.gridJson);
  if (Object.keys(grid.tabs).sort().join('|') !== [...allTabs].sort().join('|')) throw new Error('Full snapshot requires the complete supported Sheets tab set.');
  if (grid.tabs.Adjustments.slice(1).some(row => row.some(Boolean))) {
    throw new Error('Standalone historical adjustment rows require an explicit correlation contract.');
  }
  const financial = parseLegacyFinancialHistory(input.gridJson, input.financialReview);
  const taskHistory = parseLegacyTaskHistory(input.gridJson, input.financialReview);
  // The bounded public bridge is a definition normalizer here, not a full
  // history transport. Dedicated parsers validate every historical row above;
  // the exact complete grid is archived and reconciled independently below.
  const definitionTabs = Object.fromEntries(Object.entries(grid.tabs).map(([tab, rows]) =>
    [tab, historyTabs.has(tab) ? rows.slice(0, 1) : rows.map(row => [...row])]));
  const duplicateStudentStatusRows: number[] = [];
  if (definitionTabs.Students[0].filter(Boolean).join('|') === 'studentId|name|balance|status') {
    for (const [i, row] of definitionTabs.Students.entries()) if (i > 0 && row[4]) {
      // The financial parser has already proved this is the exact duplicate.
      if (row[4] !== row[3] || !['ACTIVE', 'INACTIVE'].includes(row[3]) || row.slice(5).some(Boolean)) {
        throw new Error('Unsupported extra student cells.');
      }
      duplicateStudentStatusRows.push(i + 1); row[4] = '';
    }
  }
  const projectedRowSources: Record<string, number[]> = {};
  const canonicalizedInstants: { tab: string; rowNumber: number; column: string }[] = [];
  const archivedOrphanPromotionRows: number[] = [];
  const productIds = new Set(grid.tabs.Products.slice(1).filter(r => r.some(Boolean)).map(r => r[0]));
  const promotionIds = new Set(grid.tabs.Promotions.slice(1).filter(r => r.some(Boolean)).map(r => r[0]));
  for (const [tab, rows] of Object.entries(definitionTabs)) {
    const headers = rows[0]; projectedRowSources[tab] = [];
    definitionTabs[tab] = [headers, ...rows.slice(1).flatMap((row, i) => {
      if (!row.some(Boolean)) return [];
      const rowNumber = i + 2;
      if (tab === 'PromotionProducts' && !productIds.has(row[headers.indexOf('productId')])) {
        // A dangling target has no effect on Sheets checkout. Preserve the row
        // in the complete archive, not as a newly invented sellable product.
        if (!promotionIds.has(row[headers.indexOf('promotionId')]) || row[headers.indexOf('schemaVersion')] !== '3'
          || !row[0] || !row[headers.indexOf('productId')] || !Number.isFinite(Date.parse(row[headers.indexOf('createdAt')]))) {
          throw new Error('Malformed archived promotion link.');
        }
        archivedOrphanPromotionRows.push(rowNumber); return [];
      }
      for (const column of ['createdAt', 'updatedAt', 'availableFrom', 'dueAt', 'startsAt', 'endsAt']) {
        const index = headers.indexOf(column), value = row[index];
        if (index < 0 || !value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
          || !Number.isFinite(Date.parse(value))) continue;
        const canonical = new Date(value).toISOString();
        if (canonical !== value) { row[index] = canonical; canonicalizedInstants.push({ tab, rowNumber, column }); }
      }
      projectedRowSources[tab].push(rowNumber); return [row];
    })];
  }
  const defaultedTimeZone = !grid.tabs.Settings.slice(1).some(row => row[0] === 'classTimeZone');
  if (defaultedTimeZone) definitionTabs.Settings.push(['classTimeZone', 'Asia/Seoul']);
  const definitionSliceDigest = sha256(canonicalJson(definitionTabs));
  const snapshot = await captureOfflineSheetsBaseline({ spreadsheetId: grid.spreadsheetId,
    capturedAt: input.capturedAt, contentSha256: definitionSliceDigest, tabs: definitionTabs });
  const original = normalizeLegacySnapshots({ tenantId: input.tenantId, migrationJobId: input.migrationJobId, sheets: snapshot });
  const definitionErrors = original.blockingConflicts.filter(d => !historyTabs.has(d.path.split(/[.[]/, 1)[0]));
  const badDefinitions = original.sourceRecords.filter(row => row.source.kind === 'SHEET'
    && !historyTabs.has(row.source.tab) && row.mappingStatus === 'QUARANTINED');
  if (definitionErrors.length || badDefinitions.length) {
    const codes = [...new Set(definitionErrors.map(d => d.code))].sort().slice(0, 20);
    throw new Error(`Current definitions failed full-snapshot validation: ${codes.join(',')}.`);
  }
  const records: Record<CurrentTable, readonly Readonly<Record<string, unknown>>[]> = {
    students: original.records.students ?? [], accounts: original.records.accounts ?? [], products: original.records.products ?? [],
    tasks: original.records.tasks ?? [], task_allowed_students: original.records.task_allowed_students ?? [],
    promotions: original.records.promotions ?? [], promotion_products: original.records.promotion_products ?? [], settings: original.records.settings ?? [],
  };
  // Font preference is a safe user setting omitted by the former settings allowlist.
  const font = grid.tabs.Settings.slice(1).filter(row => row[0] === 'fontFamily');
  if (font.length > 1) throw new Error('Ambiguous font setting.');
  if (font.length && !records.settings.some(row => row.key === 'fontFamily')) {
    if (font[0][1].length > 200) throw new Error('Font setting exceeds supported bounds.');
    records.settings = [...records.settings, { key: 'fontFamily', value: font[0][1] }];
  }
  const sourceRows = Object.entries(grid.tabs).flatMap(([tab, rows]) => rows.map((cells, i) => ({
    tab, rowNumber: i + 1, cells, digest: sha256(canonicalJson({ tab, rowNumber: i + 1, cells })),
  })));
  const businessRows = sourceRows.filter(row => row.rowNumber > 1 && row.cells.some(Boolean));
  const counts = Object.fromEntries(allTabs.map(tab => [tab, businessRows.filter(row => row.tab === tab).length]));
  const result = { sourceDigest: grid.contentSha256, sourceIdentityDigest: sha256(grid.spreadsheetId),
    records, financial, taskHistory, sourceRows, counts, physicalRows: sourceRows.length, businessRows: businessRows.length,
    originalDiagnosticCodes: original.blockingConflicts.map(d => d.code),
    definitionProjection: { kind: 'CURRENT_DEFINITIONS_ONLY' as const, sourceDigest: grid.contentSha256,
      definitionSliceDigest, excludedHistoryTabs: [...historyTabs], duplicateStudentStatusRows,
      projectedRowSources, canonicalizedInstants, defaultedTimeZone, archivedOrphanPromotionRows },
    scope: 'SHEETS_PRIVATE_IMPORT' as const, writerFreezeProven: false as const, redisClaims: 'UNCONFIRMED' as const };
  return { ...result, digest: sha256(canonicalJson(result)) };
}
