import { google } from 'googleapis';
import { getEnvSpreadsheetId } from '@/server/settings';
import { createUserSheetsAuth, isGoogleOAuthEnabled } from '@/server/googleOAuth';
import type { SheetName, SheetsStore } from '@/server/sheetsRepository';

const SHEET_RANGES: Record<SheetName, string> = {
  Students: 'Students!A:Z',
  Products: 'Products!A:Z',
  Transactions: 'Transactions!A:Z',
  Adjustments: 'Adjustments!A:Z',
  Settings: 'Settings!A:Z',
};

export class GoogleSheetsStore implements SheetsStore {
  constructor(private readonly spreadsheetId: string, private readonly request?: Request) {}

  async getRows(sheetName: SheetName): Promise<string[][]> {
    const sheets = await createSheetsClient(this.request);
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: SHEET_RANGES[sheetName],
      });

      return normalizeRows(response.data.values ?? []);
    } catch (error) {
      if (sheetName === 'Settings' && isMissingSheetError(error)) return [];
      throw error;
    }
  }

  async updateCell(sheetName: SheetName, rowNumber: number, columnName: string, value: string | number): Promise<void> {
    await this.updateCells(sheetName, [{ rowNumber, columnName, value }]);
  }

  async updateCells(sheetName: SheetName, updates: Array<{ rowNumber: number; columnName: string; value: string | number }>): Promise<void> {
    if (updates.length === 0) return;
    const headers = (await this.getRows(sheetName))[0] ?? [];
    const sheets = await createSheetsClient(this.request);
    const data = updates.map((update) => {
      const columnIndex = headers.indexOf(update.columnName);

      if (columnIndex === -1) {
        throw new Error(`${sheetName} 시트에 ${update.columnName} 컬럼이 없습니다.`);
      }

      return {
        range: `${sheetName}!${columnIndexToLetter(columnIndex)}${update.rowNumber}`,
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

  async appendRow(sheetName: SheetName, values: string[]): Promise<void> {
    const sheets = await createSheetsClient(this.request);
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A:Z`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] },
      });
    } catch (error) {
      if (sheetName !== 'Settings' || !isMissingSheetError(error)) throw error;
      await this.createSheet(sheetName);
      await sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A:Z`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] },
      });
    }
  }

  async deleteRow(sheetName: SheetName, rowNumber: number): Promise<void> {
    await this.deleteRows(sheetName, [rowNumber]);
  }

  async deleteRows(sheetName: SheetName, rowNumbers: number[]): Promise<void> {
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

  private async getSheetId(sheetName: SheetName): Promise<number> {
    const sheets = await createSheetsClient(this.request);
    const response = await sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: 'sheets.properties(sheetId,title)',
    });
    const sheet = response.data.sheets?.find((item) => item.properties?.title === sheetName);
    const sheetId = sheet?.properties?.sheetId;
    if (sheetId === undefined || sheetId === null) throw new Error(`${sheetName} 시트를 찾을 수 없습니다.`);
    return sheetId;
  }

  private async createSheet(sheetName: SheetName): Promise<void> {
    const sheets = await createSheetsClient(this.request);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
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
    throw new Error(`해당 Google Sheets에 접근하지 못했습니다. 서비스 계정 공유 권한과 Students/Products 시트 이름을 확인해 주세요. (${detail})`);
  }
}

export const createConfiguredSheetsReader = createConfiguredSheetsStore;

async function createSheetsClient(request?: Request) {
  if (request && isGoogleOAuthEnabled()) {
    const origin = new URL(request.url).origin;
    const userAuth = createUserSheetsAuth(request, origin);
    if (!userAuth) {
      throw new Error('Google 계정 로그인이 필요합니다. 관리자 로그인 화면에서 Google로 로그인해 주세요.');
    }
    return google.sheets({ version: 'v4', auth: userAuth.auth });
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.split(String.raw`\n`).join('\n');

  if (!email || !privateKey) {
    throw new Error('Google 서비스 계정 환경변수가 없습니다. GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY를 설정해 주세요.');
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

function isMissingSheetError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Unable to parse range|not found|Requested entity was not found/i.test(error.message);
}

function columnIndexToLetter(index: number): string {
  let dividend = index + 1;
  let columnName = '';

  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    columnName = String.fromCharCode(65 + modulo) + columnName;
    dividend = Math.floor((dividend - modulo) / 26);
  }

  return columnName;
}
