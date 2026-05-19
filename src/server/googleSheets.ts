import { google } from 'googleapis';
import { getEnvSpreadsheetId } from '@/server/settings';
import type { SheetName, SheetsStore } from '@/server/sheetsRepository';

const SHEET_RANGES: Record<SheetName, string> = {
  Students: 'Students!A:Z',
  Products: 'Products!A:Z',
  Transactions: 'Transactions!A:Z',
  Adjustments: 'Adjustments!A:Z',
  Settings: 'Settings!A:Z',
};

export class GoogleSheetsStore implements SheetsStore {
  constructor(private readonly spreadsheetId: string) {}

  async getRows(sheetName: SheetName): Promise<string[][]> {
    const sheets = await createSheetsClient();
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
    const headers = (await this.getRows(sheetName))[0] ?? [];
    const columnIndex = headers.indexOf(columnName);

    if (columnIndex === -1) {
      throw new Error(`${sheetName} 시트에 ${columnName} 컬럼이 없습니다.`);
    }

    const sheets = await createSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!${columnIndexToLetter(columnIndex)}${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] },
    });
  }

  async appendRow(sheetName: SheetName, values: string[]): Promise<void> {
    const sheets = await createSheetsClient();
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

  private async createSheet(sheetName: SheetName): Promise<void> {
    const sheets = await createSheetsClient();
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
  }
}

export async function createConfiguredSheetsStore(): Promise<GoogleSheetsStore> {
  const spreadsheetId = getEnvSpreadsheetId();

  if (!spreadsheetId) {
    throw new Error('Google Sheets ID가 설정되지 않았습니다. GOOGLE_SHEET_ID 환경변수를 설정해 주세요.');
  }

  return new GoogleSheetsStore(spreadsheetId);
}

export async function verifySpreadsheetAccess(spreadsheetId: string): Promise<void> {
  try {
    const store = new GoogleSheetsStore(spreadsheetId);
    await Promise.all([store.getRows('Students'), store.getRows('Products')]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '알 수 없는 오류';
    throw new Error(`해당 Google Sheets에 접근하지 못했습니다. 서비스 계정 공유 권한과 Students/Products 시트 이름을 확인해 주세요. (${detail})`);
  }
}

export const createConfiguredSheetsReader = createConfiguredSheetsStore;

async function createSheetsClient() {
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
