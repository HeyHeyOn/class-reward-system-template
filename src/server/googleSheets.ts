import { google } from 'googleapis';
import { getEnvSpreadsheetId } from '@/server/settings';
import { verifyRequiredOperationalSheetHeaders, type SheetsReader } from '@/server/sheetsRepository';
import { createDeploymentSheetsAuth, createUserSheetsAuth, isGoogleOAuthEnabled } from '@/server/googleOAuth';
import {
  MigrationConflictError,
  SheetProviderError,
  type AdditiveSchemaMigrationStore,
  type AtomicSheetMutation,
  type CrossSheetCellUpdate,
  type HeaderWritePrecondition,
  type OperationalSheetName,
  type RecurringSchemaMigrationStore,
  type SheetCellUpdate,
  type SheetLookupResult,
  type TabularStore,
} from '@/server/storage/tabularStore';

const SHEET_RANGES: Record<OperationalSheetName, string> = {
  Students: a1Range('Students', 'A:Z'),
  Products: a1Range('Products', 'A:Z'),
  Transactions: a1Range('Transactions', 'A:Z'),
  Adjustments: a1Range('Adjustments', 'A:Z'),
  Settings: a1Range('Settings', 'A:Z'),
  Tasks: a1Range('Tasks', 'A:A'),
  TaskAssignments: a1Range('TaskAssignments', 'A:A'),
  TaskCompletions: a1Range('TaskCompletions', 'A:A'),
  Promotions: a1Range('Promotions', 'A:Z'),
  PromotionProducts: a1Range('PromotionProducts', 'A:Z'),
};

export class GoogleSheetsStore implements TabularStore, AdditiveSchemaMigrationStore, RecurringSchemaMigrationStore {
  private readonly rows = new Map<OperationalSheetName, Promise<string[][]>>();
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxReadAttempts: number;
  private sheetsClient: ReturnType<typeof createSheetsClient> | undefined;

  constructor(
    private readonly spreadsheetId: string,
    private readonly request?: Request,
    options: { sleep?: (milliseconds: number) => Promise<void>; maxReadAttempts?: number } = {},
  ) {
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxReadAttempts = Math.max(1, Math.min(3, options.maxReadAttempts ?? 3));
  }

  private getSheetsClient(): ReturnType<typeof createSheetsClient> {
    const existing = this.sheetsClient;
    if (existing) return existing;
    const pending = createSheetsClient(this.request);
    this.sheetsClient = pending;
    pending.catch(() => {
      if (this.sheetsClient === pending) this.sheetsClient = undefined;
    });
    return pending;
  }

  async getRows(sheetName: OperationalSheetName): Promise<string[][]> {
    let pending = this.rows.get(sheetName);
    if (!pending) {
      pending = this.readRows(sheetName);
      this.rows.set(sheetName, pending);
      pending.catch(() => this.rows.delete(sheetName));
    }
    return cloneRows(await pending);
  }

  async getRowsFresh(sheetName: OperationalSheetName): Promise<string[][]> {
    const pending = this.readRows(sheetName);
    this.rows.set(sheetName, pending);
    pending.catch(() => {
      if (this.rows.get(sheetName) === pending) this.rows.delete(sheetName);
    });
    return cloneRows(await pending);
  }

  async primeRows(sheetNames: readonly OperationalSheetName[]): Promise<void> {
    const missingNames = Array.from(new Set(sheetNames)).filter((sheetName) => !this.rows.has(sheetName));
    if (missingNames.length === 0) return;

    await this.batchPrimeRows(missingNames);
  }

  async primeRowsFresh(sheetNames: readonly OperationalSheetName[]): Promise<void> {
    const names = Array.from(new Set(sheetNames));
    for (const sheetName of names) this.rows.delete(sheetName);
    if (names.length === 0) return;
    await this.batchPrimeRows(names);
  }

  private async batchPrimeRows(sheetNames: readonly OperationalSheetName[]): Promise<void> {
    const sheets = await this.getSheetsClient();
    const response = await this.readWithRetry(() => sheets.spreadsheets.values.batchGet({
      spreadsheetId: this.spreadsheetId,
      ranges: sheetNames.map((sheetName) => isRecurringSheet(sheetName) ? quoteSheetTitle(sheetName) : SHEET_RANGES[sheetName]),
    }));
    const valueRanges = response.data.valueRanges ?? [];
    if (valueRanges.length !== sheetNames.length) {
      throw new Error('Google Sheets batch read returned an incomplete snapshot.');
    }
    sheetNames.forEach((sheetName, index) => {
      this.rows.set(sheetName, Promise.resolve(normalizeRows(valueRanges[index].values ?? [])));
    });
  }

  private async readRows(sheetName: OperationalSheetName): Promise<string[][]> {
    const sheets = await this.getSheetsClient();
    try {
      const range = isRecurringSheet(sheetName) ? quoteSheetTitle(sheetName) : SHEET_RANGES[sheetName];
      const response = await this.readWithRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range }));
      return normalizeRows(response.data.values ?? []);
    } catch (error) {
      // Legacy optional sheets read as empty, but reads never create or migrate them.
      if (isLegacyOptionalReadableSheet(sheetName) && isMissingSheetError(error)) return [];
      throw error;
    }
  }

  async updateCell(sheetName: OperationalSheetName, rowNumber: number, columnName: string, value: string | number): Promise<void> {
    await this.updateCells(sheetName, [{ rowNumber, columnName, value }]);
  }

  async updateCells(sheetName: OperationalSheetName, updates: SheetCellUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    const headers = (await this.getRows(sheetName))[0] ?? [];
    const sheets = await this.getSheetsClient();
    const data = updates.map((update) => {
      const columnIndex = headers.indexOf(update.columnName);

      if (columnIndex === -1) {
        throw new Error(`${sheetName} 시트에 ${update.columnName} 컬럼이 없습니다.`);
      }

      return {
        range: a1Range(sheetName, `${columnIndexToLetter(columnIndex)}${update.rowNumber}`),
        values: [[update.value]],
      };
    });

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data,
      },
    });
    this.patchCachedCells(sheetName, updates, headers);
  }

  async updateCellsAtomicallyAcrossSheets(updates: CrossSheetCellUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    for (const update of updates) {
      if (!Number.isSafeInteger(update.rowNumber) || update.rowNumber < 1) {
        throw new RangeError(`Invalid one-based row number: ${update.rowNumber}`);
      }
      if (!Number.isSafeInteger(update.columnNumber) || update.columnNumber < 1) {
        throw new RangeError(`Invalid one-based column number: ${update.columnNumber}`);
      }
    }
    const sheets = await this.getSheetsClient();
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates.map((update) => ({
          range: a1Range(update.sheetName, `${columnIndexToLetter(update.columnNumber - 1)}${update.rowNumber}`),
          values: [[update.value]],
        })),
      },
    });
    for (const update of updates) {
      this.patchCachedCellByIndex(update.sheetName, update.rowNumber, update.columnNumber - 1, update.value);
    }
  }

  async applyAtomicMutation(mutation: AtomicSheetMutation): Promise<void> {
    const { updates, appends } = mutation;
    if (updates.length === 0 && appends.length === 0) return;
    for (const update of updates) {
      if (!Number.isSafeInteger(update.rowNumber) || update.rowNumber < 1) {
        throw new RangeError(`Invalid one-based row number: ${update.rowNumber}`);
      }
      if (!Number.isSafeInteger(update.columnNumber) || update.columnNumber < 1) {
        throw new RangeError(`Invalid one-based column number: ${update.columnNumber}`);
      }
    }
    if (appends.some((append) => append.values.length === 0)) {
      throw new RangeError('Atomic append rows must contain at least one cell');
    }

    const sheets = await this.getSheetsClient();
    const requiredNames = new Set<OperationalSheetName>([
      ...updates.map((update) => update.sheetName),
      ...appends.map((append) => append.sheetName),
    ]);
    const metadata = await this.readWithRetry(() => sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: 'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))',
    }));
    const sheetInfo = new Map<OperationalSheetName, { sheetId: number; rowCount: number; columnCount: number }>();
    for (const sheet of metadata.data.sheets ?? []) {
      const title = sheet.properties?.title as OperationalSheetName | undefined;
      const sheetId = sheet.properties?.sheetId;
      const rowCount = sheet.properties?.gridProperties?.rowCount;
      const columnCount = sheet.properties?.gridProperties?.columnCount;
      if (title && requiredNames.has(title) && sheetId !== undefined && sheetId !== null
        && Number.isSafeInteger(rowCount) && Number(rowCount) > 0
        && Number.isSafeInteger(columnCount) && Number(columnCount) > 0) {
        sheetInfo.set(title, { sheetId, rowCount: Number(rowCount), columnCount: Number(columnCount) });
      }
    }
    for (const sheetName of requiredNames) {
      if (!sheetInfo.has(sheetName)) throw new Error(`${sheetName} 시트를 찾을 수 없거나 grid 정보를 확인할 수 없습니다.`);
    }
    for (const update of updates) {
      const info = sheetInfo.get(update.sheetName)!;
      if (update.rowNumber > info.rowCount || update.columnNumber > info.columnCount) {
        throw new RangeError(`${update.sheetName} update coordinate is outside the sheet grid`);
      }
      if (typeof update.value === 'number' && !Number.isFinite(update.value)) {
        throw new RangeError('Atomic mutation numbers must be finite');
      }
    }
    for (const append of appends) {
      const info = sheetInfo.get(append.sheetName)!;
      if (append.values.length > info.columnCount) {
        throw new RangeError(`${append.sheetName} append row exceeds the sheet column grid`);
      }
      if (append.values.some((value) => typeof value === 'number' && !Number.isFinite(value))) {
        throw new RangeError('Atomic mutation numbers must be finite');
      }
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          ...updates.map((update) => ({
            updateCells: {
              range: {
                sheetId: sheetInfo.get(update.sheetName)!.sheetId,
                startRowIndex: update.rowNumber - 1,
                endRowIndex: update.rowNumber,
                startColumnIndex: update.columnNumber - 1,
                endColumnIndex: update.columnNumber,
              },
              rows: [{ values: [{ userEnteredValue: sheetCellValue(update.value) }] }],
              fields: 'userEnteredValue',
            },
          })),
          ...appends.map((append) => ({
            appendCells: {
              sheetId: sheetInfo.get(append.sheetName)!.sheetId,
              rows: [{ values: append.values.map((value) => ({ userEnteredValue: sheetCellValue(value) })) }],
              fields: 'userEnteredValue',
            },
          })),
        ],
      },
    });
    for (const sheetName of requiredNames) this.rows.delete(sheetName);
  }

  async updateHeaderRow(sheetName: OperationalSheetName, headers: string[]): Promise<void> {
    if (headers.length === 0) return;
    const sheets = await this.getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: a1Range(sheetName, `A1:${columnIndexToLetter(headers.length - 1)}1`),
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
    this.rows.delete(sheetName);
  }

  async appendRow(sheetName: OperationalSheetName, values: string[]): Promise<void> {
    await this.appendRows(sheetName, [values]);
  }

  async appendRows(sheetName: OperationalSheetName, rows: string[][]): Promise<void> {
    if (rows.length === 0) return;
    const sheets = await this.getSheetsClient();
    let range: string | null = null;
    try {
      range = await this.resolveLiveRange(sheets, sheetName);
      if (!range) throw new MissingSheetError(sheetName);
      await this.appendToRange(sheets, range, rows);
    } catch (error) {
      if (!isLegacyAutoCreatableSheet(sheetName)
        || (!(error instanceof MissingSheetError) && !isMissingSheetError(error))) throw error;
      await this.createLegacySheet(sheets, sheetName);
      await this.appendToRange(sheets, range ?? SHEET_RANGES[sheetName], rows);
    }
    this.patchCachedAppend(sheetName, rows);
  }

  async deleteRow(sheetName: OperationalSheetName, rowNumber: number): Promise<void> {
    await this.deleteRows(sheetName, [rowNumber]);
  }

  async deleteRows(sheetName: OperationalSheetName, rowNumbers: number[]): Promise<void> {
    const uniqueRows = Array.from(new Set(rowNumbers)).sort((a, b) => b - a);
    if (uniqueRows.some((rowNumber) => rowNumber <= 1)) throw new Error('헤더 행은 삭제할 수 없습니다.');
    if (uniqueRows.length === 0) return;

    const sheets = await this.getSheetsClient();
    const sheetId = await this.getSheetId(sheetName);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: uniqueRows.map((rowNumber) => ({
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowNumber - 1,
              endIndex: rowNumber,
            },
          },
        })),
      },
    });
    this.rows.delete(sheetName);
  }

  async lookupSheet(sheetName: OperationalSheetName): Promise<SheetLookupResult> {
    const sheets = await this.getSheetsClient();
    const response = await this.readWithRetry(() => sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: 'sheets.properties(sheetId,title,gridProperties.columnCount)',
    }));
    const sheet = response.data.sheets?.find((item) => item.properties?.title === sheetName);
    const sheetId = sheet?.properties?.sheetId;
    if (sheetId === undefined || sheetId === null) return { found: false, reason: 'SHEET_NOT_FOUND' };
    return { found: true, info: { sheetId, title: sheetName, columnCount: sheet?.properties?.gridProperties?.columnCount ?? 0 } };
  }

  async createSheetWithHeader(sheetName: OperationalSheetName, headers: readonly string[]): Promise<void> {
    if (headers.length === 0) throw new RangeError('header must contain at least one column');
    const sheets = await this.getSheetsClient();
    // Supplying the ID lets addSheet and updateCells share one atomic batch request.
    const sheetId = Math.floor(Math.random() * 2_000_000_000) + 1;
    try {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: {
        requests: [
          { addSheet: { properties: {
            sheetId, title: sheetName, gridProperties: { columnCount: headers.length },
          } } },
          { updateCells: {
            range: {
              sheetId, startRowIndex: 0, endRowIndex: 1,
              startColumnIndex: 0, endColumnIndex: headers.length,
            },
            rows: [{ values: headers.map((value) => ({ userEnteredValue: { stringValue: value } })) }],
            fields: 'userEnteredValue',
          } },
        ],
      } });
      this.rows.delete(sheetName);
    } catch (error) {
      try {
        const lookup = await this.lookupSheet(sheetName);
        if (lookup.found) {
          throw new SheetProviderError('SHEET_ALREADY_EXISTS', `${sheetName} exists after failed create batch`);
        }
      } catch (lookupError) {
        if (lookupError instanceof SheetProviderError) throw lookupError;
      }
      throw error;
    }
  }

  async ensureColumnCount(sheetName: OperationalSheetName, expectedColumnCount: number, requiredColumnCount: number): Promise<void> {
    if (requiredColumnCount <= expectedColumnCount) return;
    const lookup = await this.lookupSheet(sheetName);
    if (!lookup.found || lookup.info.columnCount !== expectedColumnCount) {
      throw new MigrationConflictError(sheetName, 'grid width changed before expansion');
    }
    const sheets = await this.getSheetsClient();
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests: [{
      appendDimension: { sheetId: lookup.info.sheetId, dimension: 'COLUMNS', length: requiredColumnCount - expectedColumnCount },
    }] } });
  }

  async writeHeaderCells(sheetName: OperationalSheetName, startColumn: number, headers: readonly string[]): Promise<void> {
    if (headers.length === 0) return;
    assertValidColumnIndex(startColumn);
    assertValidColumnIndex(startColumn + headers.length - 1);
    const sheets = await this.getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: a1Range(sheetName, `${columnIndexToLetter(startColumn)}1:${columnIndexToLetter(startColumn + headers.length - 1)}1`),
      valueInputOption: 'RAW', requestBody: { values: [[...headers]] },
    });
    this.rows.delete(sheetName);
  }

  async verifyHeaderCells(
    sheetName: OperationalSheetName,
    expected: HeaderWritePrecondition,
  ): Promise<void> {
    const lookup = await this.lookupSheet(sheetName);
    if (!lookup.found || lookup.info.sheetId !== expected.sheetId
      || lookup.info.columnCount !== expected.columnCount) {
      throw new MigrationConflictError(sheetName, 'sheet identity or grid width changed before expansion');
    }
    if (expected.header.length === 0) return;

    const sheets = await this.getSheetsClient();
    const response = await this.readWithRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: a1Range(sheetName, `A1:${columnIndexToLetter(expected.header.length - 1)}1`),
    }));
    const current = normalizeRows(response.data.values ?? [])[0] ?? [];
    if (current.length !== expected.header.length
      || !current.every((value, index) => value === expected.header[index])) {
      throw new MigrationConflictError(sheetName, 'expected header changed before expansion');
    }
  }

  async verifyAndWriteHeaderCells(
    sheetName: OperationalSheetName,
    expected: HeaderWritePrecondition,
    headers: string[],
  ): Promise<void> {
    if (headers.length === 0) return;
    const requiredColumnCount = expected.header.length + headers.length;
    const lookup = await this.lookupSheet(sheetName);
    if (!lookup.found || lookup.info.sheetId !== expected.sheetId
      || lookup.info.columnCount !== expected.columnCount
      || lookup.info.columnCount < requiredColumnCount) {
      throw new MigrationConflictError(sheetName, 'sheet identity or grid width changed before header update');
    }

    const sheets = await this.getSheetsClient();
    const response = await this.readWithRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: a1Range(sheetName, `A1:${columnIndexToLetter(requiredColumnCount - 1)}1`),
    }));
    const current = normalizeRows(response.data.values ?? [])[0] ?? [];
    if (current.length !== expected.header.length
      || !current.every((value, index) => value === expected.header[index])) {
      throw new MigrationConflictError(sheetName, 'expected header changed or destination cells are occupied');
    }

    // Sheets has no compare-and-set for values. Keep this verification directly
    // adjacent to the update so every detectable race fails before any write.
    await sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: a1Range(sheetName, `${columnIndexToLetter(expected.header.length)}1:${columnIndexToLetter(requiredColumnCount - 1)}1`),
      valueInputOption: 'RAW', requestBody: { values: [[...headers]] },
    });
    this.rows.delete(sheetName);
  }

  private async getSheetId(sheetName: OperationalSheetName): Promise<number> {
    const lookup = await this.lookupSheet(sheetName);
    if (!lookup.found) throw new Error(`${sheetName} 시트를 찾을 수 없습니다.`);
    return lookup.info.sheetId;
  }

  private async resolveLiveRange(sheets: Awaited<ReturnType<typeof createSheetsClient>>, sheetName: OperationalSheetName): Promise<string | null> {
    if (!isRecurringSheet(sheetName)) return SHEET_RANGES[sheetName];
    const cached = this.rows.get(sheetName);
    if (cached) {
      const header = (await cached)[0];
      if (header?.length) {
        return a1Range(sheetName, `A:${columnIndexToLetter(header.length - 1)}`);
      }
    }
    const lookup = await this.lookupSheet(sheetName);
    if (!lookup.found) return null;
    const header = await this.readWithRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: a1Range(sheetName, '1:1') }));
    const width = Math.max(1, header.data.values?.[0]?.length ?? 0);
    return a1Range(sheetName, `A:${columnIndexToLetter(width - 1)}`);
  }

  private async appendToRange(
    sheets: Awaited<ReturnType<typeof createSheetsClient>>,
    range: string,
    rows: string[][],
  ): Promise<void> {
    await sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });
  }

  private patchCachedCells(sheetName: OperationalSheetName, updates: SheetCellUpdate[], headers: string[]): void {
    for (const update of updates) {
      this.patchCachedCellByIndex(sheetName, update.rowNumber, headers.indexOf(update.columnName), update.value);
    }
  }

  private patchCachedCellByIndex(
    sheetName: OperationalSheetName,
    rowNumber: number,
    columnIndex: number,
    value: string | number,
  ): void {
    const cached = this.rows.get(sheetName);
    if (!cached || columnIndex < 0) return;
    this.rows.set(sheetName, cached.then((rows) => {
      const next = cloneRows(rows);
      while (next.length < rowNumber) next.push([]);
      while (next[rowNumber - 1].length <= columnIndex) next[rowNumber - 1].push('');
      next[rowNumber - 1][columnIndex] = String(value);
      return next;
    }));
  }

  private patchCachedAppend(sheetName: OperationalSheetName, appended: string[][]): void {
    const cached = this.rows.get(sheetName);
    if (!cached) return;
    this.rows.set(sheetName, cached.then((rows) => [...cloneRows(rows), ...cloneRows(appended)]));
  }

  private async readWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= this.maxReadAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isTransientReadError(error)) throw error;
        if (attempt === this.maxReadAttempts) {
          if (isQuotaError(error)) {
            throw new SheetProviderError(
              'QUOTA_EXCEEDED',
              'Google Sheets 읽기 할당량을 초과했습니다. 잠시 후 다시 시도해 주세요.',
            );
          }
          throw new SheetProviderError(
            'TRANSIENT_UNAVAILABLE',
            'Google Sheets 읽기가 일시적으로 실패했습니다. 잠시 후 다시 시도해 주세요.',
          );
        }
        await this.sleep(retryDelayMilliseconds(error, attempt));
      }
    }
    throw new Error('unreachable');
  }

  private async createLegacySheet(
    sheets: Awaited<ReturnType<typeof createSheetsClient>>,
    sheetName: OperationalSheetName,
  ): Promise<void> {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
  }
}

export async function createConfiguredSheetsStore(request?: Request): Promise<GoogleSheetsStore> {
  const spreadsheetId = getEnvSpreadsheetId();

  if (!spreadsheetId) {
    throw new Error('Google Sheets ID가 설정되지 않았습니다. GOOGLE_SHEET_ID 환경변수를 설정해 주세요.');
  }

  return new GoogleSheetsStore(spreadsheetId, request);
}

export async function verifySpreadsheetAccess(reader: SheetsReader): Promise<void> {
  try {
    await reader.primeRows?.(['Settings', 'Students', 'Products']);
    await verifyRequiredOperationalSheetHeaders(reader);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '알 수 없는 오류';
    throw new Error(`해당 Google Sheets에 접근하지 못했습니다. OAuth refresh token 또는 서비스 계정 권한, Students/Products 시트 이름을 확인해 주세요. (${detail})`);
  }
}

export const createConfiguredSheetsReader = createConfiguredSheetsStore;

async function createSheetsClient(request?: Request) {
  if (request && isGoogleOAuthEnabled()) {
    const origin = new URL(request.url).origin;
    const userAuth = createUserSheetsAuth(request, origin);
    if (userAuth) {
      return google.sheets({ version: 'v4', auth: userAuth.auth });
    }
  }

  const deploymentAuth = createDeploymentSheetsAuth();
  if (deploymentAuth) {
    return google.sheets({ version: 'v4', auth: deploymentAuth });
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.split(String.raw`\n`).join('\n');

  if (!email || !privateKey) {
    throw new Error('Google Sheets 인증 환경변수가 없습니다. OAuth 방식은 GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN을 설정하고, 서비스 계정 방식은 GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY를 설정해 주세요.');
  }

  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

function sheetCellValue(value: string | number): { stringValue: string } | { numberValue: number } {
  return typeof value === 'number' ? { numberValue: value } : { stringValue: value };
}

function normalizeRows(rows: unknown[][]): string[][] {
  return rows.map((row) => row.map((cell) => String(cell ?? '')));
}

function cloneRows(rows: string[][]): string[][] {
  return rows.map((row) => [...row]);
}

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const response = 'response' in error && error.response && typeof error.response === 'object'
    ? error.response as { status?: unknown; data?: { error?: { status?: unknown } } }
    : undefined;
  return response?.status === 429 || response?.data?.error?.status === 'RESOURCE_EXHAUSTED';
}

function isTransientReadError(error: unknown): boolean {
  if (isQuotaError(error)) return true;
  if (!error || typeof error !== 'object') return false;
  const response = 'response' in error && error.response && typeof error.response === 'object'
    ? error.response as { status?: unknown }
    : undefined;
  if ([408, 500, 502, 503, 504].includes(Number(response?.status))) return true;
  const code = 'code' in error ? String(error.code) : '';
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN'].includes(code);
}

function retryDelayMilliseconds(error: unknown, attempt: number): number {
  const response = error && typeof error === 'object' && 'response' in error
    ? error.response as { headers?: Record<string, unknown> }
    : undefined;
  const retryAfter = response?.headers?.['retry-after'];
  const seconds = typeof retryAfter === 'string' ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5_000, seconds * 1_000);
  return Math.min(2_000, 250 * (2 ** (attempt - 1)));
}

function isRecurringSheet(sheetName: OperationalSheetName): boolean {
  return sheetName === 'Tasks' || sheetName === 'TaskAssignments' || sheetName === 'TaskCompletions';
}

class MissingSheetError extends Error {
  constructor(sheetName: OperationalSheetName) {
    super(`${sheetName} sheet is missing`);
    this.name = 'MissingSheetError';
  }
}

function isMissingSheetError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Unable to parse range|not found|Requested entity was not found/i.test(error.message);
}

function isLegacyAutoCreatableSheet(sheetName: OperationalSheetName): boolean {
  return sheetName === 'Settings' || sheetName === 'Tasks' || sheetName === 'TaskCompletions';
}

function isLegacyOptionalReadableSheet(sheetName: OperationalSheetName): boolean {
  return isLegacyAutoCreatableSheet(sheetName)
    || sheetName === 'TaskAssignments'
    || sheetName === 'Promotions'
    || sheetName === 'PromotionProducts';
}

function assertValidColumnIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(`Invalid zero-based column index: ${index}`);
  }
}

/** Quotes an A1 sheet title and doubles embedded apostrophes per the Sheets grammar. */
function a1Range(sheetTitle: string, cells: string): string {
  return `${quoteSheetTitle(sheetTitle)}!${cells}`;
}

function quoteSheetTitle(sheetTitle: string): string {
  return `'${sheetTitle.split("'").join("''")}'`;
}

function columnIndexToLetter(index: number): string {
  assertValidColumnIndex(index);
  let dividend = index + 1;
  let columnName = '';

  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    columnName = String.fromCharCode(65 + modulo) + columnName;
    dividend = Math.floor((dividend - modulo) / 26);
  }

  return columnName;
}
