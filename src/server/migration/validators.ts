import { createHash } from 'node:crypto';
import { type BudgetContext, BudgetExceededError, BudgetUnavailableError, utf8ByteLength, setBudgetMap, addBudgetSet } from '@/lib/boundedWork';
import { assertRegisteredBoundedJson, canonicalBoundedJson, cloneMutableBoundedJson, createBoundedProjection, registeredBoundedKeys } from '@/lib/boundedJson';
import { isSensitiveTabName } from './sensitiveRedaction';
import { stableRowHash } from './sheetsSnapshot';

export const MAX_NORMALIZATION_RECORDS = 10_000;
export const MAX_NORMALIZATION_BYTES = 4_000_000;
export const MAX_VISITED_NODES = 300_000;
export const MAX_ID_LENGTH = 512;
const CONTAINER_STRUCTURE_BYTES = 16;
const PROPERTY_STRUCTURE_BYTES = 4;
const ARRAY_ELEMENT_STRUCTURE_BYTES = 4;
const PRIMITIVE_STRUCTURE_BYTES = 4;
const MAX_TABS = 64;
const MAX_HEADERS_PER_TAB = 256;
const MAX_ROWS_PER_TAB = 249_999;
const MAX_CELLS = 2_000_000;
const MAX_CELL_LENGTH = 100_000;
const MAX_REDIS_STRING = 2_048;
const MAX_SHEETS_ARTIFACT_BYTES = 750_000;
const TAB_STRUCTURE_BYTES = 64;
const ROW_STRUCTURE_BYTES = 96;
const CELL_STRUCTURE_BYTES = 3;
const CREDENTIAL_HASH_RESERVE_BYTES = Buffer.byteLength(
  `adminPasswordHash${'scrypt$16384$8$1$'}${'a'.repeat(32)}$${'b'.repeat(64)}recoveryCodeHash${'c'.repeat(64)}`,
  'utf8',
);
const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const REQUIRED_TABS = ['Students', 'Products', 'Transactions', 'Adjustments', 'Settings', 'Tasks'] as const;
const OPTIONAL_TABS = ['TaskAssignments', 'TaskCompletions', 'Promotions', 'PromotionProducts'] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_TAGGED = /^sha256:[a-f0-9]{64}$/;
const SCRYPT = /^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/;
const V2_PROVENANCE = 'upstash:padlet:evidence-bindings:v2';

export function assertNormalizationInput(value: unknown, budget?: BudgetContext): void {
  if (budget !== undefined) return assertRegisteredBoundedJson(value, budget);
  let records = 0;
  let contentBytes = 0;
  let structuralBytes = 0;
  let visitedNodes = 0;
  const seen = new WeakSet<object>();
  const stack: unknown[] = [];
  const reserveContentBytes = (amount: number): void => {
    contentBytes += amount;
    if (contentBytes > MAX_NORMALIZATION_BYTES) boundsExceeded();
  };
  const reserveStructuralBytes = (amount: number): void => {
    structuralBytes += amount;
    if (structuralBytes > MAX_NORMALIZATION_BYTES) boundsExceeded();
  };
  const enqueue = (child: unknown): void => {
    visitedNodes += 1;
    if (visitedNodes > MAX_VISITED_NODES) boundsExceeded();
    if (child === null || typeof child === 'boolean' || typeof child === 'number') {
      reserveStructuralBytes(PRIMITIVE_STRUCTURE_BYTES);
    } else if (typeof child === 'string') {
      reserveStructuralBytes(PRIMITIVE_STRUCTURE_BYTES);
      reserveContentBytes(Buffer.byteLength(child, 'utf8'));
    } else if (child && typeof child === 'object') {
      if (seen.has(child)) invalid();
      seen.add(child);
      reserveStructuralBytes(CONTAINER_STRUCTURE_BYTES);
    }
    stack.push(child);
  };

  enqueue(value);
  while (stack.length) {
    const child = stack.pop();
    if (child === null || typeof child === 'boolean' || typeof child === 'string') continue;
    if (typeof child === 'number') {
      if (!Number.isFinite(child)) invalid();
      continue;
    }
    if (!child || typeof child !== 'object') invalid();
    if (Array.isArray(child)) {
      if (Object.getPrototypeOf(child) !== Array.prototype) invalid();
      const lengthDescriptor = Object.getOwnPropertyDescriptor(child, 'length');
      if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0 || visitedNodes + lengthDescriptor.value > MAX_VISITED_NODES) boundsExceeded();
      reserveStructuralBytes(lengthDescriptor.value * ARRAY_ELEMENT_STRUCTURE_BYTES);
      const keys = Reflect.ownKeys(child).filter((key) => key !== 'length');
      if (keys.length !== lengthDescriptor.value) invalid();
      for (let index = lengthDescriptor.value - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(child, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
        enqueue(descriptor.value);
      }
      continue;
    }
    if (!isPlainRecord(child)) invalid();
    const keys = Reflect.ownKeys(child);
    if (visitedNodes + keys.length > MAX_VISITED_NODES) boundsExceeded();
    for (const key of keys) {
      if (typeof key !== 'string' || POISON_KEYS.has(key)) invalid();
      reserveStructuralBytes(PROPERTY_STRUCTURE_BYTES + Buffer.byteLength(key, 'utf8'));
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index] as string;
      const descriptor = Object.getOwnPropertyDescriptor(child, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
      if (key === 'rowNumber') {
        records += 1;
        if (records > MAX_NORMALIZATION_RECORDS) boundsExceeded();
      }
      enqueue(descriptor.value);
    }
  }
}

export function assertManifestInputShape(value: unknown, budget?: BudgetContext): asserts value is Record<string, unknown> {
  if (budget !== undefined) assertRegisteredBoundedJson(value, budget);
  if (!isBudgetRecord(value, budget) || !hasExactKeys(value, ['tenantId', 'migrationJobId', 'sheets'], ['redis'], budget)) invalid();
  if (!isCanonicalUuid(value.tenantId, budget) || !isCanonicalUuid(value.migrationJobId, budget)) invalid();
  assertSheetsSnapshot(value.sheets, budget);
  if (Object.hasOwn(value, 'redis')) assertRedisSnapshot(value.redis, budget);
}

function assertSheetsSnapshot(value: unknown, budget?: BudgetContext): void {
  if (!isBudgetRecord(value, budget) || !hasExactKeys(value, [
    'snapshotVersion', 'spreadsheetId', 'sourceRevision', 'capturedAt', 'schemaVersion',
    'missingOptionalTabs', 'tabs', 'credentialHashes', 'digest',
  ], ['offlineBaseline'], budget)) invalid();
  const offline = Object.hasOwn(value, 'offlineBaseline');
  if (offline) assertOfflineBaselineEvidence(value.offlineBaseline, budget);
  if (value.snapshotVersion !== 1 || !Number.isSafeInteger(value.schemaVersion)
    || ![1, 2, 3, 4].includes(value.schemaVersion as number)
    || !isText(value.spreadsheetId, 1, 512) || !isText(value.sourceRevision, offline ? 0 : 1, 512)
    || (offline && value.sourceRevision !== '')
    || !isCanonicalInstant(value.capturedAt, budget) || !isHexDigest(value.digest, budget)) invalid();
  const credentialHashes = value.credentialHashes;
  assertCredentialHashes(credentialHashes, budget);
  const tabs = value.tabs;
  if (!isBudgetRecord(tabs, budget)) invalid();
  const tabNames = budget ? registeredBoundedKeys(tabs, budget) : Object.keys(tabs);
  if (tabNames.length > MAX_TABS) invalid();
  if (REQUIRED_TABS.some((name) => { budget?.spend(2); return !Object.hasOwn(tabs, name); })) invalid();
  budget?.reserve({ nodes: 1, slots: OPTIONAL_TABS.length, structuralBytes: 16 + 4 * OPTIONAL_TABS.length });
  const expectedMissing = OPTIONAL_TABS.filter((name) => { budget?.spend(2); return !Object.hasOwn(tabs, name); });
  if (!Array.isArray(value.missingOptionalTabs)
    || value.missingOptionalTabs.length !== expectedMissing.length
    || value.missingOptionalTabs.some((name, index) => { budget?.spend(); return name !== expectedMissing[index]; })) invalid();
  let cells = 0;
  let minimumCaptureBytes = CREDENTIAL_HASH_RESERVE_BYTES
    + byteLength(value.spreadsheetId, budget)
    + byteLength(value.sourceRevision, budget)
    + byteLength(value.capturedAt, budget);
  for (const name of tabNames) {
    budget?.spend();
    if (!isText(name, 1, 200) || isSensitiveTabName(name, budget)) invalid();
    minimumCaptureBytes += TAB_STRUCTURE_BYTES + byteLength(name, budget);
    const tab = tabs[name];
    if (!isBudgetRecord(tab, budget) || !hasExactKeys(tab, ['headers', 'rows'], [], budget)
      || !isDenseStringArray(tab.headers, MAX_HEADERS_PER_TAB, MAX_CELL_LENGTH, budget)
      || tab.headers.some((header) => { budget?.spend(); return isSensitiveTabName(header, budget); })
      || !Array.isArray(tab.rows) || tab.rows.length > MAX_ROWS_PER_TAB) invalid();
    cells += tab.headers.length;
    if (tab.headers.length > 0 || tab.rows.length > 0) minimumCaptureBytes += ROW_STRUCTURE_BYTES;
    for (const header of tab.headers) { budget?.spend(); minimumCaptureBytes += CELL_STRUCTURE_BYTES + byteLength(header, budget); }
    for (let index = 0; index < tab.rows.length; index += 1) {
      budget?.spend();
      const row = tab.rows[index];
      if (!isBudgetRecord(row, budget) || !hasExactKeys(row, ['rowNumber', 'cells', 'hash'], [], budget)
        || row.rowNumber !== index + 2 || !isHexDigest(row.hash, budget)
        || !isDenseStringArray(row.cells, MAX_CELLS, MAX_CELL_LENGTH, budget)
        || row.cells.length !== tab.headers.length
        || row.hash !== stableRowHash(row.cells, budget)) invalid();
      cells += row.cells.length;
      if (cells > MAX_CELLS) invalid();
      minimumCaptureBytes += ROW_STRUCTURE_BYTES;
      for (const cell of row.cells) { budget?.spend(); minimumCaptureBytes += CELL_STRUCTURE_BYTES + byteLength(cell, budget); }
    }
  }
  if (cells > MAX_CELLS || minimumCaptureBytes > MAX_SHEETS_ARTIFACT_BYTES) invalid();
  assertTask14SettingsRedaction(tabs.Settings, credentialHashes, budget);
  const artifact = budget ? createBoundedProjection(offline ? 'offlineSheetsArtifact' : 'sheetsArtifact', () => value, budget) : {
    snapshotVersion: value.snapshotVersion,
    spreadsheetId: value.spreadsheetId,
    sourceRevision: value.sourceRevision,
    capturedAt: value.capturedAt,
    schemaVersion: value.schemaVersion,
    missingOptionalTabs: value.missingOptionalTabs,
    tabs,
    credentialHashes,
    ...(offline ? { offlineBaseline: value.offlineBaseline } : {}),
  };
  if (value.digest !== sha256(canonicalJson(artifact, budget), budget)) invalid();
}

export function assertOfflineBaselineEvidence(value: unknown, budget?: BudgetContext): void {
  if (!isBudgetRecord(value, budget) || !hasExactKeys(value,
    ['kind', 'contentSha256', 'googleDriveVersion', 'writerFreezeProven', 'redisClaims'], [], budget)
    || value.kind !== 'OFFLINE_GRID_REHEARSAL' || !isHexDigest(value.contentSha256, budget)
    || value.googleDriveVersion !== null || value.writerFreezeProven !== false || value.redisClaims !== 'UNCONFIRMED') invalid();
}

function assertTask14SettingsRedaction(tab: unknown, credentialHashes: Record<string, unknown>, budget?: BudgetContext): void {
  if (budget !== undefined) return assertBoundedSettingsRedaction(tab, credentialHashes, budget);
  if (!isBudgetRecord(tab, budget) || !isDenseStringArray(tab.headers, MAX_CELLS, MAX_CELL_LENGTH, budget)
    || !Array.isArray(tab.rows)) invalid();
  const keyIndexes = tab.headers.map((header, index) => ({ header: header.trim(), index }))
    .filter(({ header }) => header === 'key');
  const valueIndexes = tab.headers.map((header, index) => ({ header: header.trim(), index }))
    .filter(({ header }) => header === 'value');
  if (keyIndexes.length !== 1 || valueIndexes.length !== 1) invalid();
  const extracted: Record<string, string> = Object.create(null);
  for (const row of tab.rows) {
    if (!isBudgetRecord(row, budget) || !isDenseStringArray(row.cells, MAX_CELLS, MAX_CELL_LENGTH, budget)) invalid();
    const key = row.cells[keyIndexes[0].index]?.trim() ?? '';
    const cellValue = row.cells[valueIndexes[0].index]?.trim() ?? '';
    if (!isSensitiveTabName(key, budget)) continue;
    if (key === 'adminPasswordHash' && (matches(SHA256, cellValue, budget) || matches(SCRYPT, cellValue, budget))) extracted[key] = cellValue;
    else if (key === 'recoveryCodeHash' && matches(SHA256, cellValue, budget)) extracted[key] = cellValue;
    else invalid();
  }
  if (canonicalJson(extracted, budget) !== canonicalJson(credentialHashes, budget)) invalid();
}

function assertCredentialHashes(value: unknown, budget?: BudgetContext): asserts value is Record<string, unknown> {
  if (!isBudgetRecord(value, budget) || !hasExactKeys(value, [], ['adminPasswordHash', 'recoveryCodeHash'], budget)) invalid();
  if (Object.hasOwn(value, 'adminPasswordHash')
    && (typeof value.adminPasswordHash !== 'string' || (!matches(SHA256, value.adminPasswordHash, budget) && !matches(SCRYPT, value.adminPasswordHash, budget)))) invalid();
  if (Object.hasOwn(value, 'recoveryCodeHash')
    && (typeof value.recoveryCodeHash !== 'string' || !matches(SHA256, value.recoveryCodeHash, budget))) invalid();
}

export function assertRedisSnapshot(value: unknown, budget?: BudgetContext): void {
  if (!isBudgetRecord(value, budget) || !hasExactKeys(value, [
    'snapshotVersion', 'capturedAt', 'sourceRevision', 'v2Claims', 'operationBindings',
    'v1Tombstones', 'orphanedClaimDigests', 'digest',
  ], [], budget)) invalid();
  if (value.snapshotVersion !== 1 || !isCanonicalInstant(value.capturedAt, budget)
    || !isText(value.sourceRevision, 1, MAX_REDIS_STRING) || !isHexDigest(value.digest, budget)
    || !Array.isArray(value.v2Claims) || !Array.isArray(value.operationBindings)
    || !Array.isArray(value.v1Tombstones) || !Array.isArray(value.orphanedClaimDigests)
    || value.v2Claims.length + value.operationBindings.length + value.v1Tombstones.length
      + value.orphanedClaimDigests.length > MAX_NORMALIZATION_RECORDS) invalid();
  budget?.reserve({ nodes: 2, structuralBytes: 32 });
  const claims = new Map<string, Record<string, unknown>>();
  const operations = new Map<string, Record<string, unknown>>();
  let prior = '';
  for (const claim of value.v2Claims) {
    budget?.spend();
    assertV2Claim(claim, budget);
    if (prior && compareCodeUnits(prior, claim.tupleDigest as string, budget) >= 0) invalid();
    prior = claim.tupleDigest as string;
    setBudgetMap(claims, claim.tupleDigest as string, () => claim, budget);
  }
  prior = '';
  for (const operation of value.operationBindings) {
    budget?.spend();
    assertOperationBinding(operation, budget);
    if (prior && compareCodeUnits(prior, operation.operationId as string, budget) >= 0) invalid();
    prior = operation.operationId as string;
    setBudgetMap(operations, operation.operationId as string, () => operation, budget);
  }
  if (claims.size !== operations.size) invalid();
  budget?.reserve({ nodes: 1, structuralBytes: 16 }); budget?.spend();
  for (const claim of claims.values()) {
    budget?.spend(2);
    const operation = operations.get(claim.operationId as string);
    if (!operation || operation.tupleDigest !== claim.tupleDigest || operation.ownerDigest !== claim.ownerDigest) invalid();
    const evidence = (operation.binding as Record<string, unknown>).evidence as Record<string, unknown>;
    if (claim.boardId !== evidence.evidenceBoardId || claim.postId !== evidence.evidencePostId) invalid();
  }
  // Set plus explicit Map.keys iterator; each native iteration and insertion.
  budget?.reserve({ nodes: 2, slots: claims.size, structuralBytes: 32 + 4 * claims.size });
  budget?.spend(1 + 2 * claims.size);
  const occupiedTupleDigests = new Set(claims.keys());
  prior = '';
  for (const tombstone of value.v1Tombstones) {
    budget?.spend();
    if (!isBudgetRecord(tombstone, budget) || !hasExactKeys(tombstone, ['tupleDigest', 'ownerDigest', 'sourceProvenance'], [], budget)
      || !isHexDigest(tombstone.tupleDigest, budget) || !isHexDigest(tombstone.ownerDigest, budget)
      || tombstone.sourceProvenance !== 'upstash:padlet:evidence-claim:v1') invalid();
    if (prior && compareCodeUnits(prior, tombstone.tupleDigest, budget) >= 0) invalid();
    if (hasSet(occupiedTupleDigests, tombstone.tupleDigest, budget)) invalid();
    prior = tombstone.tupleDigest;
    addBudgetSet(occupiedTupleDigests, tombstone.tupleDigest, budget);
  }
  prior = '';
  for (const orphan of value.orphanedClaimDigests) {
    budget?.spend();
    if (!isHexDigest(orphan, budget) || (prior && compareCodeUnits(prior, orphan, budget) >= 0)
      || hasSet(occupiedTupleDigests, orphan, budget)) invalid();
    prior = orphan;
    addBudgetSet(occupiedTupleDigests, orphan, budget);
  }
  const artifact = budget ? createBoundedProjection('redisArtifact', () => value, budget) : {
    snapshotVersion: value.snapshotVersion,
    capturedAt: value.capturedAt,
    sourceRevision: value.sourceRevision,
    v2Claims: value.v2Claims,
    operationBindings: value.operationBindings,
    v1Tombstones: value.v1Tombstones,
    orphanedClaimDigests: value.orphanedClaimDigests,
  };
  if (value.digest !== sha256(canonicalJson(artifact, budget), budget)) invalid();
}

function assertV2Claim(value: unknown, budget?: BudgetContext): void {
  if (!isBudgetRecord(value, budget) || !hasExactKeys(value, [
    'tupleDigest', 'boardId', 'postId', 'ownerDigest', 'operationId', 'sourceProvenance',
  ], [], budget) || !isHexDigest(value.tupleDigest, budget) || typeof value.boardId !== 'string'
    || !matches(/^[A-Za-z0-9]{16,22}$/, value.boardId, budget) || typeof value.postId !== 'string'
    || !isCanonicalPadletPostId(value.postId, budget) || !isHexDigest(value.ownerDigest, budget)
    || !isCanonicalInternalId(value.operationId, 128, budget) || value.sourceProvenance !== V2_PROVENANCE
    || value.tupleDigest !== tupleHash(value.boardId, value.postId, budget)
    || value.ownerDigest !== sha256(value.operationId, budget)) invalid();
}

function assertOperationBinding(value: unknown, budget?: BudgetContext): void {
  if (!isBudgetRecord(value, budget) || !hasExactKeys(value, [
    'operationId', 'tupleDigest', 'ownerDigest', 'payloadHash', 'binding', 'claimField', 'sourceProvenance',
  ], [], budget) || !isCanonicalInternalId(value.operationId, 128, budget) || !isHexDigest(value.tupleDigest, budget)
    || !isHexDigest(value.ownerDigest, budget) || typeof value.payloadHash !== 'string' || !matches(SHA256_TAGGED, value.payloadHash, budget)
    || typeof value.claimField !== 'string' || !matches(/^claim:[a-f0-9]{64}$/, value.claimField, budget)
    || value.sourceProvenance !== V2_PROVENANCE
    || value.ownerDigest !== sha256(value.operationId, budget)
    || value.claimField !== tagged('claim:', value.tupleDigest, budget)) invalid();
  const binding = value.binding;
  if (!isBudgetRecord(binding, budget) || !hasExactKeys(binding, ['taskId', 'studentId', 'cycleStartsAt', 'evidence'], [], budget)
    || !isCanonicalInternalId(binding.taskId, 128, budget) || !isCanonicalInternalId(binding.studentId, 128, budget)
    || !isCanonicalInstant(binding.cycleStartsAt, budget)) invalid();
  const evidence = binding.evidence;
  if (!isBudgetRecord(evidence, budget) || !hasExactKeys(evidence, [
    'evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName',
  ], [], budget) || evidence.evidenceProvider !== 'PADLET' || typeof evidence.evidenceBoardId !== 'string'
    || !matches(/^[A-Za-z0-9]{16,22}$/, evidence.evidenceBoardId, budget) || typeof evidence.evidencePostId !== 'string'
    || !isCanonicalPadletPostId(evidence.evidencePostId, budget) || !isCanonicalInstant(evidence.evidenceCreatedAt, budget)
    || !isCanonicalInternalId(evidence.evidenceAuthorFullName, 200, budget)
    || value.tupleDigest !== tupleHash(evidence.evidenceBoardId, evidence.evidencePostId, budget)
    || value.payloadHash !== tagged('sha256:', sha256(canonicalJson(binding, budget), budget), budget)) invalid();
}

export function canonicalJson(value: unknown, budget?: BudgetContext): string {
  if (budget !== undefined) return canonicalBoundedJson(value, budget);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((child) => canonicalJson(child)).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort(compareCodeUnits).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('Legacy migration manifest is structurally invalid.');
}

export function clonePlainData<T>(value: T, budget?: BudgetContext): T {
  if (budget !== undefined) return cloneMutableBoundedJson(value, budget);
  if (Array.isArray(value)) return value.map((child) => clonePlainData(child)) as T;
  if (isPlainRecord(value)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) result[key] = clonePlainData(value[key]);
    return result as T;
  }
  return value;
}

export function sha256(value: string, budget?: BudgetContext): string {
  if (budget !== undefined) {
    const bytes = utf8ByteLength(value, budget);
    budget.spend(1 + Math.ceil(bytes / 256));
    budget.reserveString(64);
    try {
      const hash = createHash('sha256'); budget.check();
      const updated = hash.update(value, 'utf8'); budget.check();
      const result = updated.digest('hex'); budget.check();
      return result;
    } catch (error) {
      if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
      budget.check(); throw error;
    }
  }
  const result = createHash('sha256').update(value, 'utf8').digest('hex');
  return result;
}

function tupleHash(boardId: string, postId: string, budget?: BudgetContext): string {
  if (budget !== undefined) {
    const bytes = utf8ByteLength(boardId, budget) + 1 + utf8ByteLength(postId, budget);
    budget.spend(3 + Math.ceil(bytes / 256)); budget.reserveString(64);
  }
  const result = createHash('sha256').update(boardId, 'utf8').update('\0').update(postId, 'utf8').digest('hex');
  budget?.check(); return result;
}

function isCanonicalPadletPostId(value: string, budget?: BudgetContext): boolean {
  return value.length >= 3 && value.length <= 128 && matches(/^[A-Za-z0-9_-]+$/, value, budget);
}

export function deterministicIdWithBudget(budget: BudgetContext, ...parts: readonly string[]): string {
  // Stream the SAME byte-length-prefixed framing, without allocating a full
  // joined input string. The rest parameter remains separate from legacy parts.
  budget.spend(); budget.reserveString(64);
  const hash = createHash('sha256');
  for (let index = 0; index < parts.length; index++) {
    budget.spend();
    const part = parts[index];
    const bytes = utf8ByteLength(part, budget);
    budget.reserveString(32); budget.spend(1 + Math.ceil(bytes / 256));
    const prefix = `${bytes}:`;
    if (index) hash.update('|');
    hash.update(prefix, 'utf8').update(part, 'utf8'); budget.check();
  }
  const hex = hash.digest('hex'); budget.check();
  // Five substring payloads and the complete UUID are all newly allocated.
  budget.reserveString(36);
  budget.reserve({ nodes: 5, contentBytes: 30, structuralBytes: 20 }); budget.spend(6);
  const result = formatDeterministicId(hex); budget.check(); return result;
}

export function deterministicId(...parts: readonly string[]): string {
  const encoded = parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
  const hex = sha256(encoded);
  return formatDeterministicId(hex);
}

function formatDeterministicId(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function compareCodeUnits(left: string, right: string, budget?: BudgetContext): number {
  budget?.spend(1 + Math.ceil((left.length + right.length) / 256));
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalId(value: string | undefined, budget?: BudgetContext): string | null {
  budget?.spend(3);
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) return null;
  budget?.spend(1 + 2 * Math.ceil(value.length / 256));
  return value === trim(value, budget) ? value : null;
}

export function safeInteger(value: string | undefined, options: { min?: number; max?: number } = {}, budget?: BudgetContext): number | null {
  try {
    budget?.spend();
    if (typeof value !== 'string' || !matches(/^-?(0|[1-9][0-9]*)$/, value, budget)) return null;
    budget?.spend(1 + Math.ceil(value.length / 256)); budget?.reserve({ nodes: 1, structuralBytes: 4 });
    const parsed = Number(value); budget?.check();
    const min = options.min ?? Number.MIN_SAFE_INTEGER;
    const max = options.max ?? Number.MAX_SAFE_INTEGER;
    budget?.spend(3);
    const result = Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
    budget?.check(); return result;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget?.check();
    throw error;
  }
}

export function finiteNumber(value: string | undefined, min: number, max: number, budget?: BudgetContext): number | null {
  try {
    if (typeof value !== 'string' || !matches(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/, value, budget)) return null;
    budget?.spend(1 + Math.ceil(value.length / 256)); budget?.reserve({ nodes: 1, structuralBytes: 4 });
    const parsed = Number(value); budget?.check();
    const result = Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
    budget?.check(); return result;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget?.check();
    throw error;
  }
}

export function strictBoolean(value: string | undefined, budget?: BudgetContext): boolean | null {
  // Both comparisons, including both fixed operands and rejected long input.
  budget?.spend(4 + 2 * Math.ceil((typeof value === 'string' ? value.length : 0) / 256));
  return value === 'TRUE' ? true : value === 'FALSE' ? false : null;
}

export function canonicalInstant(value: string | undefined, budget?: BudgetContext): string | null {
  return isCanonicalInstant(value, budget) ? value : null;
}

export function isHexDigest(value: unknown, budget?: BudgetContext): value is string {
  return typeof value === 'string' && matches(SHA256, value, budget);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = [], budget?: BudgetContext): boolean {
  if (budget !== undefined) {
    const keys = registeredBoundedKeys(value, budget);
    for (const key of required) { budget.spend(2); if (!Object.hasOwn(value, key)) return false; }
    for (const key of keys) {
      budget.spend();
      if (!required.some((allowed) => compareCodeUnits(key, allowed, budget) === 0)
        && !optional.some((allowed) => compareCodeUnits(key, allowed, budget) === 0)) return false;
    }
    return true;
  }
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function isDenseStringArray(value: unknown, maxItems: number, maxLength: number, budget?: BudgetContext): value is string[] {
  return Array.isArray(value) && value.length <= maxItems
    && value.every((item) => { budget?.spend(); return typeof item === 'string' && item.length <= maxLength; });
}

function isText(value: unknown, min = 1, max = 512): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isCanonicalInternalId(value: unknown, max: number, budget?: BudgetContext): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && value === trim(value, budget);
}

function isCanonicalInstant(value: unknown, budget?: BudgetContext): value is string {
  try {
    budget?.spend();
    if (typeof value !== 'string' || !matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, value, budget)) return false;
    budget?.spend(1 + Math.ceil(value.length / 256)); budget?.reserve({ nodes: 1, structuralBytes: 4 });
    const parsed = Date.parse(value); budget?.check();
    budget?.spend();
    const finite = Number.isFinite(parsed); budget?.check();
    if (!finite) return false;
    budget?.reserve({ nodes: 1, structuralBytes: 16 }); budget?.reserveString(24); budget?.spend(6);
    const result = new Date(parsed).toISOString() === value; budget?.check(); return result;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget?.check();
    throw error;
  }
}

function isCanonicalUuid(value: unknown, budget?: BudgetContext): value is string {
  return typeof value === 'string' && matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, value, budget);
}

function isBudgetRecord(value: unknown, budget?: BudgetContext): value is Record<string, unknown> {
  budget?.spend();
  return isPlainRecord(value);
}

function byteLength(value: string, budget?: BudgetContext): number {
  return budget ? utf8ByteLength(value, budget) : Buffer.byteLength(value, 'utf8');
}

function trim(value: string, budget?: BudgetContext): string {
  try {
    if (budget) { budget.spend(1 + Math.ceil(value.length / 256)); budget.reserveString(utf8ByteLength(value, budget)); }
    const result = value.trim(); budget?.check(); return result;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget?.check();
    throw error;
  }
}

function matches(pattern: RegExp, value: string, budget?: BudgetContext): boolean {
  try {
    budget?.spend(1 + Math.ceil(value.length / 256));
    const result = pattern.test(value); budget?.check(); return result;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget?.check();
    throw error;
  }
}

function tagged(prefix: string, value: string, budget?: BudgetContext): string {
  if (budget) { budget.reserveString(utf8ByteLength(prefix, budget) + utf8ByteLength(value, budget)); budget.spend(); }
  return `${prefix}${value}`;
}

function hasSet(set: Set<string>, value: string, budget?: BudgetContext): boolean {
  budget?.spend(1 + Math.ceil(value.length / 256)); return set.has(value);
}

function assertBoundedSettingsRedaction(tab: unknown, credentialHashes: Record<string, unknown>, budget: BudgetContext): void {
  if (!isPlainRecord(tab) || !isDenseStringArray(tab.headers, MAX_CELLS, MAX_CELL_LENGTH, budget)
    || !Array.isArray(tab.rows)) invalid();
  let keyIndex = -1, valueIndex = -1, keyCount = 0, valueCount = 0;
  for (let index = 0; index < tab.headers.length; index++) {
    budget.spend(); const header = trim(tab.headers[index], budget);
    if (header === 'key') { keyCount++; keyIndex = index; }
    if (header === 'value') { valueCount++; valueIndex = index; }
  }
  if (keyCount !== 1 || valueCount !== 1) invalid();
  // Exactly the original last-key-wins extraction, without a dynamic object.
  let admin: string | undefined, recovery: string | undefined;
  for (const row of tab.rows) {
    budget.spend();
    if (!isPlainRecord(row) || !isDenseStringArray(row.cells, MAX_CELLS, MAX_CELL_LENGTH, budget)) invalid();
    const key = trim(row.cells[keyIndex] ?? '', budget);
    const value = trim(row.cells[valueIndex] ?? '', budget);
    if (!isSensitiveTabName(key, budget)) continue;
    if (key === 'adminPasswordHash' && (matches(SHA256, value, budget) || matches(SCRYPT, value, budget))) admin = value;
    else if (key === 'recoveryCodeHash' && matches(SHA256, value, budget)) recovery = value;
    else invalid();
  }
  budget.spend(2);
  if (admin !== credentialHashes.adminPasswordHash || recovery !== credentialHashes.recoveryCodeHash) invalid();
}

function boundsExceeded(): never {
  throw new Error('Legacy migration input exceeds normalization bounds.');
}

function invalid(): never {
  throw new Error('Legacy migration input is structurally invalid.');
}
