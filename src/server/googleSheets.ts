import { google } from 'googleapis';
import { getAppSettings } from '@/server/settings';
import type { SheetName, SheetsReader } from '@/server/sheetsRepository';

const SHEET_RANGES: Record<SheetName, string> = {
  Students: 'Students!A:Z',
  Products: 'Products!A:Z',
  Transactions: 'Transactions!A:Z',
  Adjustments: 'Adjustments!A:Z',
};

export class GoogleSheetsReader implements SheetsReader {
  constructor(private readonly spreadsheetId: string) {}

  async getRows(sheetName: SheetName): Promise<string[][]> {
    const sheets = await createSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: SHEET_RANGES[sheetName],
    });

    return normalizeRows(response.data.values ?? []);
  }
}

export async function createConfiguredSheetsReader(): Promise<GoogleSheetsReader> {
  const settings = await getAppSettings();

  if (!settings.spreadsheetId) {
    throw new Error('Google Sheets ID가 설정되지 않았습니다. /admin/settings에서 시트 주소를 먼저 저장해 주세요.');
  }

  return new GoogleSheetsReader(settings.spreadsheetId);
}

async function createSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

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
