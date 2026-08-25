import { google } from 'googleapis';
import { getEnvSpreadsheetId } from '@/server/settings';
import { createDeploymentSheetsAuth, createUserSheetsAuth, isGoogleOAuthEnabled } from '@/server/googleOAuth';
import {
  MigrationConflictError,
  SheetProviderError,
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
};

export class GoogleSheetsStore implements TabularStore, RecurringSchemaMigrationStore {
  constructor(private readonly spreadsheetId: string, private readonly request?: Request) {}

  async getRows(sheetName: OperationalSheetName): Promise<string[][]> {
    const sheets = await createSheetsClient(this.request);
    try {
      const range = await this.resolveLiveRange(sheets, sheetName);
      if (!range) return [];
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range });
      return normalizeRows(response.data.values ?? []);
    } catch (error) {
      // Legacy optional sheets read as empty, but reads never create or migrate them.
      if (isLegacyAutoCreatableSheet(sheetName) && isMissingSheetError(error)) return [];
      throw error;
    }
  }

  async updateCell(sheetName: OperationalSheetName, rowNumber: number, columnName: string, value: string | number): Promise<void> {
    await this.updateCells(sheetName, [{ rowNumber, columnName, value }]);
  }

  async updateCells(sheetName: OperationalSheetName, updates: SheetCellUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    const headers = (await this.getRows(sheetName))[0] ?? [];
    const sheets = await createSheetsClient(this.request);
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
    const sheets = await createSheetsClient(this.request);
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
  }

  async updateHeaderRow(sheetName: OperationalSheetName, headers: string[]): Promise<void> {
    if (headers.length === 0) return;
    const sheets = await createSheetsClient(this.request);
    await sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: a1Range(sheetName, `A1:${columnIndexToLetter(headers.length - 1)}1`),
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }

  async appendRow(sheetName: OperationalSheetName, values: string[]): Promise<void> {
    const sheets = await createSheetsClient(this.request);
    let range: string | null = null;
    try {
      range = await this.resolveLiveRange(sheets, sheetName);
      if (!range) throw new MissingSheetError(sheetName);
      await this.appendToRange(sheets, range, values);
    } catch (error) {
      if (!isLegacyAutoCreatableSheet(sheetName)
        || (!(error instanceof MissingSheetError) && !isMissingSheetError(error))) throw error;
      await this.createLegacySheet(sheets, sheetName);
      await this.appendToRange(sheets, range ?? SHEET_RANGES[sheetName], values);
    }
  }

  async deleteRow(sheetName: OperationalSheetName, rowNumber: number): Promise<void> {
    await this.deleteRows(sheetName, [rowNumber]);
  }

  async deleteRows(sheetName: OperationalSheetName, rowNumbers: number[]): Promise<void> {
    const uniqueRows = Array.from(new Set(rowNumbers)).sort((a, b) => b - a);
    if (uniqueRows.some((rowNumber) => rowNumber <= 1)) throw new Error('헤더 행은 삭제할 수 없습니다.');
    if (uniqueRows.length === 0) return;

    const sheets = await createSheetsClient(this.request);
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
  }

  async lookupSheet(sheetName: OperationalSheetName): Promise<SheetLookupResult> {
    const sheets = await createSheetsClient(this.request);
    const response = await sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: 'sheets.properties(sheetId,title,gridProperties.columnCount)',
    });
    const sheet = response.data.sheets?.find((item) => item.properties?.title === sheetName);
    const sheetId = sheet?.properties?.sheetId;
    if (sheetId === undefined || sheetId === null) return { found: false, reason: 'SHEET_NOT_FOUND' };
    return { found: true, info: { sheetId, title: sheetName, columnCount: sheet?.properties?.gridProperties?.columnCount ?? 0 } };
  }

  async createSheetWithHeader(sheetName: OperationalSheetName, headers: readonly string[]): Promise<void> {
    if (headers.length === 0) throw new RangeError('header must contain at least one column');
    const sheets = await createSheetsClient(this.request);
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
    const sheets = await createSheetsClient(this.request);
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests: [{
      appendDimension: { sheetId: lookup.info.sheetId, dimension: 'COLUMNS', length: requiredColumnCount - expectedColumnCount },
    }] } });
  }

  async writeHeaderCells(sheetName: OperationalSheetName, startColumn: number, headers: readonly string[]): Promise<void> {
    if (headers.length === 0) return;
    assertValidColumnIndex(startColumn);
    assertValidColumnIndex(startColumn + headers.length - 1);
    const sheets = await createSheetsClient(this.request);
    await sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: a1Range(sheetName, `${columnIndexToLetter(startColumn)}1:${columnIndexToLetter(startColumn + headers.length - 1)}1`),
      valueInputOption: 'RAW', requestBody: { values: [[...headers]] },
    });
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

    const sheets = await createSheetsClient(this.request);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: a1Range(sheetName, `A1:${columnIndexToLetter(expected.header.length - 1)}1`),
    });
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

    const sheets = await createSheetsClient(this.request);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: a1Range(sheetName, `A1:${columnIndexToLetter(requiredColumnCount - 1)}1`),
    });
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
  }

  private async getSheetId(sheetName: OperationalSheetName): Promise<number> {
    const lookup = await this.lookupSheet(sheetName);
    if (!lookup.found) throw new Error(`${sheetName} 시트를 찾을 수 없습니다.`);
    return lookup.info.sheetId;
  }

  private async resolveLiveRange(sheets: Awaited<ReturnType<typeof createSheetsClient>>, sheetName: OperationalSheetName): Promise<string | null> {
    if (!isRecurringSheet(sheetName)) return SHEET_RANGES[sheetName];
    const lookup = await this.lookupSheet(sheetName);
    if (!lookup.found) return null;
    const header = await sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: a1Range(sheetName, '1:1') });
    const width = Math.max(1, header.data.values?.[0]?.length ?? 0);
    return a1Range(sheetName, `A:${columnIndexToLetter(width - 1)}`);
  }

  private async appendToRange(
    sheets: Awaited<ReturnType<typeof createSheetsClient>>,
    range: string,
    values: string[],
  ): Promise<void> {
    await sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });
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

export async function verifySpreadsheetAccess(spreadsheetId: string, request?: Request): Promise<void> {
  try {
    const store = new GoogleSheetsStore(spreadsheetId, request);
    await Promise.all([store.getRows('Students'), store.getRows('Products')]);
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

function normalizeRows(rows: unknown[][]): string[][] {
  return rows.map((row) => row.map((cell) => String(cell ?? '')));
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

function assertValidColumnIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(`Invalid zero-based column index: ${index}`);
  }
}

/** Quotes an A1 sheet title and doubles embedded apostrophes per the Sheets grammar. */
function a1Range(sheetTitle: string, cells: string): string {
  return `'${sheetTitle.split("'").join("''")}'!${cells}`;
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
