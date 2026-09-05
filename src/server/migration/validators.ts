import { createHash } from 'node:crypto';
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

export function assertNormalizationInput(value: unknown): void {
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

export function assertManifestInputShape(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['tenantId', 'migrationJobId', 'sheets'], ['redis'])) invalid();
  if (!isCanonicalUuid(value.tenantId) || !isCanonicalUuid(value.migrationJobId)) invalid();
  assertSheetsSnapshot(value.sheets);
  if (Object.hasOwn(value, 'redis')) assertRedisSnapshot(value.redis);
}

function assertSheetsSnapshot(value: unknown): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'snapshotVersion', 'spreadsheetId', 'sourceRevision', 'capturedAt', 'schemaVersion',
    'missingOptionalTabs', 'tabs', 'credentialHashes', 'digest',
  ])) invalid();
  if (value.snapshotVersion !== 1 || !Number.isSafeInteger(value.schemaVersion)
    || ![1, 2, 3].includes(value.schemaVersion as number)
    || !isText(value.spreadsheetId, 1, 512) || !isText(value.sourceRevision, 1, 512)
    || !isCanonicalInstant(value.capturedAt) || !isHexDigest(value.digest)) invalid();
  const credentialHashes = value.credentialHashes;
  assertCredentialHashes(credentialHashes);
  const tabs = value.tabs;
  if (!isPlainRecord(tabs)) invalid();
  const tabNames = Object.keys(tabs);
  if (tabNames.length > MAX_TABS) invalid();
  if (REQUIRED_TABS.some((name) => !Object.hasOwn(tabs, name))) invalid();
  const expectedMissing = OPTIONAL_TABS.filter((name) => !Object.hasOwn(tabs, name));
  if (!Array.isArray(value.missingOptionalTabs)
    || value.missingOptionalTabs.length !== expectedMissing.length
    || value.missingOptionalTabs.some((name, index) => name !== expectedMissing[index])) invalid();
  let cells = 0;
  let minimumCaptureBytes = CREDENTIAL_HASH_RESERVE_BYTES
    + Buffer.byteLength(value.spreadsheetId, 'utf8')
    + Buffer.byteLength(value.sourceRevision, 'utf8')
    + Buffer.byteLength(value.capturedAt, 'utf8');
  for (const name of tabNames) {
    if (!isText(name, 1, 200) || isSensitiveTabName(name)) invalid();
    minimumCaptureBytes += TAB_STRUCTURE_BYTES + Buffer.byteLength(name, 'utf8');
    const tab = tabs[name];
    if (!isPlainRecord(tab) || !hasExactKeys(tab, ['headers', 'rows'])
      || !isDenseStringArray(tab.headers, MAX_HEADERS_PER_TAB, MAX_CELL_LENGTH)
      || tab.headers.some(isSensitiveTabName)
      || !Array.isArray(tab.rows) || tab.rows.length > MAX_ROWS_PER_TAB) invalid();
    cells += tab.headers.length;
    if (tab.headers.length > 0 || tab.rows.length > 0) minimumCaptureBytes += ROW_STRUCTURE_BYTES;
    for (const header of tab.headers) minimumCaptureBytes += CELL_STRUCTURE_BYTES + Buffer.byteLength(header, 'utf8');
    for (let index = 0; index < tab.rows.length; index += 1) {
      const row = tab.rows[index];
      if (!isPlainRecord(row) || !hasExactKeys(row, ['rowNumber', 'cells', 'hash'])
        || row.rowNumber !== index + 2 || !isHexDigest(row.hash)
        || !isDenseStringArray(row.cells, MAX_CELLS, MAX_CELL_LENGTH)
        || row.cells.length !== tab.headers.length
        || row.hash !== stableRowHash(row.cells)) invalid();
      cells += row.cells.length;
      if (cells > MAX_CELLS) invalid();
      minimumCaptureBytes += ROW_STRUCTURE_BYTES;
      for (const cell of row.cells) minimumCaptureBytes += CELL_STRUCTURE_BYTES + Buffer.byteLength(cell, 'utf8');
    }
  }
  if (cells > MAX_CELLS || minimumCaptureBytes > MAX_SHEETS_ARTIFACT_BYTES) invalid();
  assertTask14SettingsRedaction(tabs.Settings, credentialHashes);
  const artifact = {
    snapshotVersion: value.snapshotVersion,
    spreadsheetId: value.spreadsheetId,
    sourceRevision: value.sourceRevision,
    capturedAt: value.capturedAt,
    schemaVersion: value.schemaVersion,
    missingOptionalTabs: value.missingOptionalTabs,
    tabs,
    credentialHashes,
  };
  if (value.digest !== sha256(canonicalJson(artifact))) invalid();
}

function assertTask14SettingsRedaction(tab: unknown, credentialHashes: Record<string, unknown>): void {
  if (!isPlainRecord(tab) || !isDenseStringArray(tab.headers, MAX_CELLS, MAX_CELL_LENGTH)
    || !Array.isArray(tab.rows)) invalid();
  const keyIndexes = tab.headers.map((header, index) => ({ header: header.trim(), index }))
    .filter(({ header }) => header === 'key');
  const valueIndexes = tab.headers.map((header, index) => ({ header: header.trim(), index }))
    .filter(({ header }) => header === 'value');
  if (keyIndexes.length !== 1 || valueIndexes.length !== 1) invalid();
  const extracted: Record<string, string> = Object.create(null);
  for (const row of tab.rows) {
    if (!isPlainRecord(row) || !isDenseStringArray(row.cells, MAX_CELLS, MAX_CELL_LENGTH)) invalid();
    const key = row.cells[keyIndexes[0].index]?.trim() ?? '';
    const cellValue = row.cells[valueIndexes[0].index]?.trim() ?? '';
    if (!isSensitiveTabName(key)) continue;
    if (key === 'adminPasswordHash' && (SHA256.test(cellValue) || SCRYPT.test(cellValue))) extracted[key] = cellValue;
    else if (key === 'recoveryCodeHash' && SHA256.test(cellValue)) extracted[key] = cellValue;
    else invalid();
  }
  if (canonicalJson(extracted) !== canonicalJson(credentialHashes)) invalid();
}

function assertCredentialHashes(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value) || !hasExactKeys(value, [], ['adminPasswordHash', 'recoveryCodeHash'])) invalid();
  if (Object.hasOwn(value, 'adminPasswordHash')
    && (typeof value.adminPasswordHash !== 'string' || (!SHA256.test(value.adminPasswordHash) && !SCRYPT.test(value.adminPasswordHash)))) invalid();
  if (Object.hasOwn(value, 'recoveryCodeHash')
    && (typeof value.recoveryCodeHash !== 'string' || !SHA256.test(value.recoveryCodeHash))) invalid();
}

function assertRedisSnapshot(value: unknown): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'snapshotVersion', 'capturedAt', 'sourceRevision', 'v2Claims', 'operationBindings',
    'v1Tombstones', 'orphanedClaimDigests', 'digest',
  ])) invalid();
  if (value.snapshotVersion !== 1 || !isCanonicalInstant(value.capturedAt)
    || !isText(value.sourceRevision, 1, MAX_REDIS_STRING) || !isHexDigest(value.digest)
    || !Array.isArray(value.v2Claims) || !Array.isArray(value.operationBindings)
    || !Array.isArray(value.v1Tombstones) || !Array.isArray(value.orphanedClaimDigests)
    || value.v2Claims.length + value.operationBindings.length + value.v1Tombstones.length
      + value.orphanedClaimDigests.length > MAX_NORMALIZATION_RECORDS) invalid();
  const claims = new Map<string, Record<string, unknown>>();
  const operations = new Map<string, Record<string, unknown>>();
  let prior = '';
  for (const claim of value.v2Claims) {
    assertV2Claim(claim);
    if (prior && compareCodeUnits(prior, claim.tupleDigest as string) >= 0) invalid();
    prior = claim.tupleDigest as string;
    claims.set(claim.tupleDigest as string, claim);
  }
  prior = '';
  for (const operation of value.operationBindings) {
    assertOperationBinding(operation);
    if (prior && compareCodeUnits(prior, operation.operationId as string) >= 0) invalid();
    prior = operation.operationId as string;
    operations.set(operation.operationId as string, operation);
  }
  if (claims.size !== operations.size) invalid();
  for (const claim of claims.values()) {
    const operation = operations.get(claim.operationId as string);
    if (!operation || operation.tupleDigest !== claim.tupleDigest || operation.ownerDigest !== claim.ownerDigest) invalid();
    const evidence = (operation.binding as Record<string, unknown>).evidence as Record<string, unknown>;
    if (claim.boardId !== evidence.evidenceBoardId || claim.postId !== evidence.evidencePostId) invalid();
  }
  const occupiedTupleDigests = new Set(claims.keys());
  prior = '';
  for (const tombstone of value.v1Tombstones) {
    if (!isPlainRecord(tombstone) || !hasExactKeys(tombstone, ['tupleDigest', 'ownerDigest', 'sourceProvenance'])
      || !isHexDigest(tombstone.tupleDigest) || !isHexDigest(tombstone.ownerDigest)
      || tombstone.sourceProvenance !== 'upstash:padlet:evidence-claim:v1') invalid();
    if (prior && compareCodeUnits(prior, tombstone.tupleDigest) >= 0) invalid();
    if (occupiedTupleDigests.has(tombstone.tupleDigest)) invalid();
    prior = tombstone.tupleDigest;
    occupiedTupleDigests.add(tombstone.tupleDigest);
  }
  prior = '';
  for (const orphan of value.orphanedClaimDigests) {
    if (!isHexDigest(orphan) || (prior && compareCodeUnits(prior, orphan) >= 0)
      || occupiedTupleDigests.has(orphan)) invalid();
    prior = orphan;
    occupiedTupleDigests.add(orphan);
  }
  const artifact = {
    snapshotVersion: value.snapshotVersion,
    capturedAt: value.capturedAt,
    sourceRevision: value.sourceRevision,
    v2Claims: value.v2Claims,
    operationBindings: value.operationBindings,
    v1Tombstones: value.v1Tombstones,
    orphanedClaimDigests: value.orphanedClaimDigests,
  };
  if (value.digest !== sha256(canonicalJson(artifact))) invalid();
}

function assertV2Claim(value: unknown): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'tupleDigest', 'boardId', 'postId', 'ownerDigest', 'operationId', 'sourceProvenance',
  ]) || !isHexDigest(value.tupleDigest) || typeof value.boardId !== 'string'
    || !/^[A-Za-z0-9]{16,22}$/.test(value.boardId) || typeof value.postId !== 'string'
    || !isCanonicalPadletPostId(value.postId) || !isHexDigest(value.ownerDigest)
    || !isCanonicalInternalId(value.operationId, 128) || value.sourceProvenance !== V2_PROVENANCE
    || value.tupleDigest !== tupleHash(value.boardId, value.postId)
    || value.ownerDigest !== sha256(value.operationId)) invalid();
}

function assertOperationBinding(value: unknown): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'operationId', 'tupleDigest', 'ownerDigest', 'payloadHash', 'binding', 'claimField', 'sourceProvenance',
  ]) || !isCanonicalInternalId(value.operationId, 128) || !isHexDigest(value.tupleDigest)
    || !isHexDigest(value.ownerDigest) || typeof value.payloadHash !== 'string' || !SHA256_TAGGED.test(value.payloadHash)
    || typeof value.claimField !== 'string' || !/^claim:[a-f0-9]{64}$/.test(value.claimField)
    || value.sourceProvenance !== V2_PROVENANCE
    || value.ownerDigest !== sha256(value.operationId)
    || value.claimField !== `claim:${value.tupleDigest}`) invalid();
  const binding = value.binding;
  if (!isPlainRecord(binding) || !hasExactKeys(binding, ['taskId', 'studentId', 'cycleStartsAt', 'evidence'])
    || !isCanonicalInternalId(binding.taskId, 128) || !isCanonicalInternalId(binding.studentId, 128)
    || !isCanonicalInstant(binding.cycleStartsAt)) invalid();
  const evidence = binding.evidence;
  if (!isPlainRecord(evidence) || !hasExactKeys(evidence, [
    'evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName',
  ]) || evidence.evidenceProvider !== 'PADLET' || typeof evidence.evidenceBoardId !== 'string'
    || !/^[A-Za-z0-9]{16,22}$/.test(evidence.evidenceBoardId) || typeof evidence.evidencePostId !== 'string'
    || !isCanonicalPadletPostId(evidence.evidencePostId) || !isCanonicalInstant(evidence.evidenceCreatedAt)
    || !isCanonicalInternalId(evidence.evidenceAuthorFullName, 200)
    || value.tupleDigest !== tupleHash(evidence.evidenceBoardId, evidence.evidencePostId)
    || value.payloadHash !== `sha256:${sha256(canonicalJson(binding))}`) invalid();
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort(compareCodeUnits).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('Legacy migration manifest is structurally invalid.');
}

export function clonePlainData<T>(value: T): T {
  if (Array.isArray(value)) return value.map((child) => clonePlainData(child)) as T;
  if (isPlainRecord(value)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) result[key] = clonePlainData(value[key]);
    return result as T;
  }
  return value;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function tupleHash(boardId: string, postId: string): string {
  return createHash('sha256').update(boardId, 'utf8').update('\0').update(postId, 'utf8').digest('hex');
}

function isCanonicalPadletPostId(value: string): boolean {
  return value.length >= 3 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

export function deterministicId(...parts: readonly string[]): string {
  const encoded = parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
  const hex = sha256(encoded);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalId(value: string | undefined): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && value === value.trim() ? value : null;
}

export function safeInteger(value: string | undefined, options: { min?: number; max?: number } = {}): number | null {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function finiteNumber(value: string | undefined, min: number, max: number): number | null {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function strictBoolean(value: string | undefined): boolean | null {
  return value === 'TRUE' ? true : value === 'FALSE' ? false : null;
}

export function canonicalInstant(value: string | undefined): string | null {
  return isCanonicalInstant(value) ? value : null;
}

export function isHexDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function isDenseStringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems
    && value.every((item) => typeof item === 'string' && item.length <= maxLength);
}

function isText(value: unknown, min = 1, max = 512): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isCanonicalInternalId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && value === value.trim();
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function boundsExceeded(): never {
  throw new Error('Legacy migration input exceeds normalization bounds.');
}

function invalid(): never {
  throw new Error('Legacy migration input is structurally invalid.');
}
