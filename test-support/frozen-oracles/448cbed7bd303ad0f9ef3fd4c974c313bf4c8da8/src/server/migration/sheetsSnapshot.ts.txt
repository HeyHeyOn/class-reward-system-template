import { createHash } from 'node:crypto';
import { parseSheetSettingsRows } from '@/server/sheetsRepository';
import {
  assertDenseWorkbookRow, deepFreeze, isSensitiveTabName, redactWorkbook, type CredentialHashes,
} from './sensitiveRedaction';

const REQUIRED_TABS = ['Students', 'Products', 'Transactions', 'Adjustments', 'Settings', 'Tasks'] as const;
const OPTIONAL_TABS = ['TaskAssignments', 'TaskCompletions', 'Promotions', 'PromotionProducts'] as const;
const MAX_TABS = 64;
const MAX_ROWS_PER_TAB = 250_000;
const MAX_CELLS = 2_000_000;
const MAX_CELL_LENGTH = 100_000;
// Leave headroom beneath the bridge's 1 MB plaintext limit for JSON structure and fixed manifest fields.
const MAX_AGGREGATE_UTF8_BYTES = 750_000;
const TAB_STRUCTURE_BYTES = 64;
const ROW_STRUCTURE_BYTES = 96;
const CELL_STRUCTURE_BYTES = 3;
const CREDENTIAL_HASH_RESERVE_BYTES = Buffer.byteLength(
  `adminPasswordHash${'scrypt$16384$8$1$'}${'a'.repeat(32)}$${'b'.repeat(64)}recoveryCodeHash${'c'.repeat(64)}`,
  'utf8',
);

export interface WorkbookSnapshotReader {
  listSheetNames(): Promise<readonly string[]>;
  getRows(name: string): Promise<readonly (readonly unknown[])[]>;
  getRevision(): Promise<string>;
}

export type SheetSnapshotRow = Readonly<{ rowNumber: number; cells: readonly string[]; hash: string }>;
export type SheetTabSnapshot = Readonly<{ headers: readonly string[]; rows: readonly SheetSnapshotRow[] }>;
export type SheetsSnapshot = Readonly<{
  snapshotVersion: 1;
  spreadsheetId: string;
  sourceRevision: string;
  capturedAt: string;
  schemaVersion: 1 | 2 | 3;
  missingOptionalTabs: readonly string[];
  tabs: Readonly<Record<string, SheetTabSnapshot>>;
  credentialHashes: CredentialHashes;
  digest: string;
}>;

export async function captureSheetsSnapshot(input: Readonly<{
  spreadsheetId: string;
  capturedAt: string;
  reader: WorkbookSnapshotReader;
}>): Promise<SheetsSnapshot> {
  assertBoundedText(input.spreadsheetId, 'spreadsheet id', 512);
  assertCanonicalInstant(input.capturedAt);
  const before = await input.reader.getRevision();
  assertBoundedText(before, 'source revision', 512);
  const budget = new AggregateUtf8Budget(MAX_AGGREGATE_UTF8_BYTES);
  budget.consumeText(input.spreadsheetId);
  budget.consumeText(input.capturedAt);
  budget.consumeText(before);
  budget.consumeBytes(CREDENTIAL_HASH_RESERVE_BYTES);
  const names: string[] = [];
  for (const name of await input.reader.listSheetNames()) {
    if (typeof name !== 'string' || !name || name.length > 200) {
      throw new Error('Workbook sheet metadata is invalid or oversized.');
    }
    budget.consumeBytes(TAB_STRUCTURE_BYTES);
    budget.consumeText(name);
    names.push(name);
  }
  if (names.length > MAX_TABS || new Set(names).size !== names.length) {
    throw new Error('Workbook sheet metadata is invalid or oversized.');
  }
  for (const required of REQUIRED_TABS) {
    if (!names.includes(required)) throw new Error(`Required workbook tab is missing: ${required}`);
  }

  const rawTabs = Object.create(null) as Record<string, string[][]>;
  let cells = 0;
  for (const name of names) {
    if (isSensitiveTabName(name)) continue; // Credential-bearing tabs are never read.
    const rawRows = await input.reader.getRows(name);
    if (!Array.isArray(rawRows) || rawRows.length > MAX_ROWS_PER_TAB) throw new Error('Workbook tab is invalid or oversized.');
    for (const row of rawRows) assertDenseWorkbookRow(row);
    rawTabs[name] = rawRows.map((row: readonly unknown[]) => {
      budget.consumeBytes(ROW_STRUCTURE_BYTES);
      cells += row.length;
      if (cells > MAX_CELLS) throw new Error('Workbook snapshot exceeds cell limit.');
      return row.map((cell) => {
        const text = String(cell ?? '');
        if (text.length > MAX_CELL_LENGTH) throw new Error('Workbook cell exceeds string limit.');
        budget.consumeBytes(CELL_STRUCTURE_BYTES);
        budget.consumeText(text);
        return text;
      });
    });
  }
  const after = await input.reader.getRevision();
  if (before !== after) throw new Error('Workbook source changed during snapshot capture.');

  const redacted = redactWorkbook(rawTabs);
  // Reuse the established pure Settings parser; snapshotting never invokes a writer or migrator.
  const settings = parseSheetSettingsRows((redacted.tabs.Settings ?? []).map((row) => [...row]));
  const parsedVersion = Number(settings.schemaVersion ?? 1);
  if (!Number.isSafeInteger(parsedVersion) || parsedVersion < 1 || parsedVersion > 3) {
    throw new Error('Workbook schema version is unsupported.');
  }

  const tabs = Object.create(null) as Record<string, SheetTabSnapshot>;
  for (const name of Object.keys(redacted.tabs).sort(compareCodeUnits)) {
    const [headers = [], ...rows] = redacted.tabs[name];
    tabs[name] = {
      headers: [...headers],
      rows: rows.map((row, index) => ({ rowNumber: index + 2, cells: [...row], hash: stableRowHash(row) })),
    };
  }
  const artifact = {
    snapshotVersion: 1 as const,
    spreadsheetId: input.spreadsheetId,
    sourceRevision: before,
    capturedAt: input.capturedAt,
    schemaVersion: parsedVersion as 1 | 2 | 3,
    missingOptionalTabs: OPTIONAL_TABS.filter((name) => !names.includes(name)),
    tabs,
    credentialHashes: redacted.credentialHashes,
  };
  return deepFreeze({ ...artifact, digest: sha256(canonicalJson(artifact)) });
}

export function stableRowHash(cells: readonly string[]): string {
  return sha256(canonicalJson([...cells]));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  throw new Error('Value cannot be canonically encoded.');
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertCanonicalInstant(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error('Capture time is invalid.');
}

function assertBoundedText(value: string, label: string, max: number): void {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`${label} is invalid.`);
}

class AggregateUtf8Budget {
  private used = 0;

  constructor(private readonly limit: number) {}

  consumeText(value: string): void {
    this.consumeBytes(Buffer.byteLength(value, 'utf8'));
  }

  consumeBytes(bytes: number): void {
    if (bytes > this.limit - this.used) throw new Error('Workbook snapshot exceeds aggregate UTF-8 byte limit.');
    this.used += bytes;
  }
}
