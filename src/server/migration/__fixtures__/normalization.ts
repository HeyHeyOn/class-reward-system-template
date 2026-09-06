import { createHash } from 'node:crypto';
import { REQUIRED_SHEETS } from '@/generator/config/schema';
import { deepFreeze } from '../sensitiveRedaction';
import { stableRowHash, type SheetsSnapshot } from '../sheetsSnapshot';
import type { RedisClaimSnapshot } from '../redisClaimSnapshot';
import { canonicalJson } from '../validators';

const at = '2026-08-31T00:00:00.000Z';
const later = '2026-09-01T00:00:00.000Z';

export const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export const boardId = 'BOARD12345678901';
export const postId = 'POST-1';
export const tupleDigest = sha(`${boardId}\0${postId}`);
const evidence = { evidenceProvider: 'PADLET' as const, evidenceBoardId: boardId, evidencePostId: postId, evidenceCreatedAt: at, evidenceAuthorFullName: 'Alice' };
const binding = { taskId: 'T1', studentId: 'S1', cycleStartsAt: at, evidence };
export const payloadHash = `sha256:${sha(canonicalJson(binding))}`;

const rows: Record<string, string[][]> = {
  Students: [['S1', 'Alice', '100', 'ACTIVE']],
  Products: [['P1', 'Pencil', '20', '5', 'TRUE', '', 'school', '1']],
  Transactions: [
    ['TX1', at, 'S1', 'Alice', JSON.stringify([{ productId: 'P1', name: 'Pencil', price: 20, quantity: 1, subtotal: 20 }]), '20', '100', '80', 'COMPLETED', 'kiosk'],
    ['TX-ADJ1', at, 'S1', 'Alice', JSON.stringify([{ productId: 'ADMIN-ADD', name: '관리자 지급', price: -10, quantity: 1, subtotal: -10 }]), '-10', '80', '90', 'ADMIN_ADJUSTMENT', 'admin'],
  ],
  Adjustments: [['ADJ1', at, 'S1', '10', 'add', 'admin']],
  Settings: [
    ['schemaVersion', '3'], ['classTimeZone', 'Asia/Seoul'], ['themeColor', 'blue'],
    ['adminPasswordHash', sha('admin')], ['recoveryCodeHash', sha('recovery')],
  ],
  Tasks: [[
    'T1', 'Homework', 'Read', '10', 'TRUE', '1', at, later, 'S1',
    'TI1', '1', at, 'Asia/Seoul', 'NONE', '', '', '', 'FALSE', 'FALSE',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
  ]],
  TaskAssignments: [['AS1', 'T1', 'TI1', 'CYCLE1', at, later, '1', 'Asia/Seoul', 'S1', 'ASSIGNED', 'ADMIN', '', at, '2', 'seed']],
  TaskCompletions: [[
    'C1', at, 'T1', 'S1', 'Alice', '10', '80', '90', 'SUCCESS', 'done',
    'TI1', 'CYCLE1', at, later, '1', 'Asia/Seoul', 'BANK', 'AS1', '2', 'op-1', payloadHash,
    'PADLET', boardId, postId, at, 'Alice',
  ]],
  Promotions: [['PROMO1', 'Sale', 'discount', 'FIXED_DISCOUNT', '5', '', '', at, later, 'TRUE', '1', at, at, '3']],
  PromotionProducts: [['LINK1', 'PROMO1', 'P1', at, '3']],
};

const schemaHeaders = (schemaVersion: 1 | 2 | 3): Record<string, string[]> => {
  const result: Record<string, string[]> = {
    Students: [...REQUIRED_SHEETS.Students], Products: [...REQUIRED_SHEETS.Products],
    Transactions: [...REQUIRED_SHEETS.Transactions], Adjustments: [...REQUIRED_SHEETS.Adjustments],
    Settings: [...REQUIRED_SHEETS.Settings],
    Tasks: schemaVersion === 1 ? REQUIRED_SHEETS.Tasks.slice(0, 9) : schemaVersion === 2 ? REQUIRED_SHEETS.Tasks.slice(0, 29) : [...REQUIRED_SHEETS.Tasks],
  };
  if (schemaVersion >= 2) {
    result.TaskAssignments = [...REQUIRED_SHEETS.TaskAssignments];
    result.TaskCompletions = [...REQUIRED_SHEETS.TaskCompletions];
  }
  if (schemaVersion >= 3) {
    result.Promotions = [...REQUIRED_SHEETS.Promotions];
    result.PromotionProducts = [...REQUIRED_SHEETS.PromotionProducts];
  }
  return result;
};

export function makeSheets(schemaVersion: 1 | 2 | 3 = 3, mutate?: (tabs: Record<string, { headers: string[]; rows: Array<{ rowNumber: number; cells: string[]; hash: string }> }>) => void): SheetsSnapshot {
  const tabs: Record<string, { headers: string[]; rows: Array<{ rowNumber: number; cells: string[]; hash: string }> }> = Object.create(null);
  for (const [name, headers] of Object.entries(schemaHeaders(schemaVersion))) {
    const sourceRows = name === 'Settings'
      ? rows.Settings.map((row) => row[0] === 'schemaVersion' ? ['schemaVersion', String(schemaVersion)] : row)
      : rows[name] ?? [];
    tabs[name] = { headers, rows: sourceRows.map((cells, index) => ({ rowNumber: index + 2, cells: cells.slice(0, headers.length), hash: stableRowHash(cells.slice(0, headers.length)) })) };
  }
  if (schemaVersion === 3 && tabs.TaskCompletions) {
    tabs.TaskCompletions.headers.push('evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName');
    tabs.TaskCompletions.rows[0].cells = [...rows.TaskCompletions[0]];
    tabs.TaskCompletions.rows[0].hash = stableRowHash(tabs.TaskCompletions.rows[0].cells);
  }
  mutate?.(tabs);
  return finalizeSheetsSnapshot({
    snapshotVersion: 1, spreadsheetId: 'sheet-1', sourceRevision: 'rev-1', capturedAt: at,
    schemaVersion, missingOptionalTabs: [], tabs,
    credentialHashes: { adminPasswordHash: sha('admin'), recoveryCodeHash: sha('recovery') }, digest: '',
  });
}

export function makeRedis(overrides: Partial<RedisClaimSnapshot> = {}): RedisClaimSnapshot {
  return finalizeRedisSnapshot({ snapshotVersion: 1, capturedAt: at, sourceRevision: 'redis-rev-1',
    v2Claims: [{ tupleDigest, boardId, postId, ownerDigest: sha('op-1'), operationId: 'op-1', sourceProvenance: 'upstash:padlet:evidence-bindings:v2' }],
    operationBindings: [{ operationId: 'op-1', tupleDigest, ownerDigest: sha('op-1'), payloadHash, binding, claimField: `claim:${tupleDigest}`, sourceProvenance: 'upstash:padlet:evidence-bindings:v2' }],
    v1Tombstones: [], orphanedClaimDigests: [], digest: '', ...overrides });
}

export function finalizeSheetsSnapshot(snapshot: SheetsSnapshot): SheetsSnapshot {
  const sortedTabs = Object.create(null) as Record<string, { headers: string[]; rows: Array<{ rowNumber: number; cells: string[]; hash: string }> }>;
  for (const name of Object.keys(snapshot.tabs).sort(compareCodeUnits)) {
    const tab = snapshot.tabs[name];
    sortedTabs[name] = {
      headers: [...tab.headers],
      rows: tab.rows.map((row, index) => ({ rowNumber: index + 2, cells: [...row.cells], hash: stableRowHash(row.cells) })),
    };
  }
  const artifact = {
    snapshotVersion: 1 as const,
    spreadsheetId: snapshot.spreadsheetId,
    sourceRevision: snapshot.sourceRevision,
    capturedAt: snapshot.capturedAt,
    schemaVersion: snapshot.schemaVersion,
    missingOptionalTabs: ['TaskAssignments', 'TaskCompletions', 'Promotions', 'PromotionProducts']
      .filter((name) => !Object.hasOwn(sortedTabs, name)),
    tabs: sortedTabs,
    credentialHashes: { ...snapshot.credentialHashes },
  };
  return deepFreeze({ ...artifact, digest: sha(canonicalJson(artifact)) });
}

export function finalizeRedisSnapshot(snapshot: RedisClaimSnapshot): RedisClaimSnapshot {
  const operationBindings = snapshot.operationBindings.map((operation) => {
    const operationTupleDigest = sha(`${operation.binding.evidence.evidenceBoardId}\0${operation.binding.evidence.evidencePostId}`);
    return {
      ...operation,
      tupleDigest: operationTupleDigest,
      ownerDigest: sha(operation.operationId),
      payloadHash: `sha256:${sha(canonicalJson(operation.binding))}`,
      claimField: `claim:${operationTupleDigest}`,
      sourceProvenance: 'upstash:padlet:evidence-bindings:v2' as const,
    };
  }).sort((left, right) => compareCodeUnits(left.operationId, right.operationId));
  const v2Claims = operationBindings.map((operation) => ({
    tupleDigest: operation.tupleDigest,
    boardId: operation.binding.evidence.evidenceBoardId,
    postId: operation.binding.evidence.evidencePostId,
    ownerDigest: operation.ownerDigest,
    operationId: operation.operationId,
    sourceProvenance: 'upstash:padlet:evidence-bindings:v2' as const,
  })).sort((left, right) => compareCodeUnits(left.tupleDigest, right.tupleDigest));
  const artifact = {
    snapshotVersion: 1 as const,
    capturedAt: snapshot.capturedAt,
    sourceRevision: snapshot.sourceRevision,
    v2Claims,
    operationBindings,
    v1Tombstones: [...snapshot.v1Tombstones].sort((left, right) => compareCodeUnits(left.tupleDigest, right.tupleDigest)),
    orphanedClaimDigests: [...snapshot.orphanedClaimDigests].sort(compareCodeUnits),
  };
  return deepFreeze({ ...artifact, digest: sha(canonicalJson(artifact)) });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}