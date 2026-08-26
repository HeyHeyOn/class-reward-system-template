import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleSheetsStore, verifySpreadsheetAccess } from '@/server/googleSheets';
import { TASK_ASSIGNMENT_HEADERS } from '@/server/repositories/sheets/recurringSchemaMigrator';
import { saveSheetSetting } from '@/server/sheetsRepository';
import { saveAppSettings } from '@/server/settings';
import { MigrationConflictError } from '@/server/storage/tabularStore';

const googleMocks = vi.hoisted(() => {
  const oauth2SetCredentials = vi.fn();
  const oauth2Instances: Array<{ setCredentials: typeof oauth2SetCredentials }> = [];
  const sheetsValuesGet = vi.fn();
  const sheetsValuesBatchGet = vi.fn();
  const sheetsApi = {
    spreadsheets: {
      values: {
        get: sheetsValuesGet,
        batchGet: sheetsValuesBatchGet,
        batchUpdate: vi.fn(),
        append: vi.fn(),
        update: vi.fn(),
      },
      batchUpdate: vi.fn(),
      get: vi.fn(),
    },
  };

  return {
    oauth2SetCredentials,
    oauth2Instances,
    sheetsValuesGet,
    sheetsValuesBatchGet,
    sheetsApi,
    OAuth2: vi.fn(function OAuth2(this: { setCredentials: typeof oauth2SetCredentials }) {
      this.setCredentials = oauth2SetCredentials;
      oauth2Instances.push(this);
    }),
    JWT: vi.fn(),
    sheets: vi.fn(() => sheetsApi),
  };
});

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: googleMocks.OAuth2,
      JWT: googleMocks.JWT,
    },
    sheets: googleMocks.sheets,
  },
}));

const taskHeader = Array.from({ length: 29 }, (_, index) => index === 28 ? 'legacyCustom' : `column${index + 1}`);

function mockSheetMetadata(columnCount = 29) {
  googleMocks.sheetsApi.spreadsheets.get.mockResolvedValue({
    data: { sheets: [
      { properties: { sheetId: 7, title: 'Tasks', gridProperties: { columnCount } } },
      { properties: { sheetId: 8, title: 'TaskCompletions', gridProperties: { columnCount: 19 } } },
      { properties: { sheetId: 9, title: 'TaskAssignments', gridProperties: { columnCount: 15 } } },
    ] },
  });
}

describe('GoogleSheetsStore auth and recurring ranges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    googleMocks.oauth2Instances.length = 0;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_PRIVATE_KEY;
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    process.env.GOOGLE_REFRESH_TOKEN = 'refresh-token';
    googleMocks.sheetsValuesGet.mockResolvedValue({ data: { values: [['studentId'], ['S001']] } });
    googleMocks.sheetsApi.spreadsheets.values.append.mockResolvedValue({});
    googleMocks.sheetsApi.spreadsheets.values.update.mockResolvedValue({});
    mockSheetMetadata();
  });

  it('updates an existing setting through the adapter when its value header has surrounding whitespace', async () => {
    googleMocks.sheetsValuesGet.mockResolvedValue({
      data: { values: [['key', ' value '], ['currencyUnit', '원']] },
    });
    const store = new GoogleSheetsStore('sheet-123');

    await saveSheetSetting(store, { key: 'currencyUnit', value: '별' });

    expect(googleMocks.sheetsApi.spreadsheets.values.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-123',
      requestBody: {
        valueInputOption: 'RAW',
        data: [{ range: "'Settings'!B2", values: [['별']] }],
      },
    });
  });

  it('saves a one-value Settings diff with one external read and one batch write', async () => {
    googleMocks.sheetsValuesGet.mockResolvedValue({ data: { values: [
      ['key', 'value'], ['currencyUnit', '원'], ['appTitle', '학급 매점'], ['bankTitle', '학급 은행'],
      ['themeColor', 'white'], ['fontFamily', 'default'], ['qrManualInputEnabled', 'FALSE'],
      ['classTimeZone', 'Asia/Seoul'], ['schemaVersion', '1'],
      ['systemVersion', '0.1.0'], ['systemName', '학급 보상 시스템'],
    ] } });
    const store = new GoogleSheetsStore('env-sheet-id');

    await saveAppSettings({
      settingsStore: store, spreadsheetIdOrUrl: 'env-sheet-id', appTitle: '변경된 제목',
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
    });

    expect(googleMocks.sheetsValuesGet).toHaveBeenCalledTimes(1);
    expect(googleMocks.sheetsApi.spreadsheets.values.batchUpdate).toHaveBeenCalledTimes(1);
    expect(googleMocks.sheetsApi.spreadsheets.values.append).not.toHaveBeenCalled();
  });

  it('primes Settings and validates required operational headers in one batch read before saving', async () => {
    const settingsRows = [
      ['key', 'value'], ['currencyUnit', '원'], ['appTitle', '학급 매점'], ['bankTitle', '학급 은행'],
      ['themeColor', 'white'], ['fontFamily', 'default'], ['qrManualInputEnabled', 'FALSE'],
      ['classTimeZone', 'Asia/Seoul'], ['schemaVersion', '1'],
      ['systemVersion', '0.1.0'], ['systemName', '학급 보상 시스템'],
    ];
    googleMocks.sheetsValuesBatchGet.mockResolvedValue({ data: { valueRanges: [
      { range: "'Settings'!A1:Z11", values: settingsRows },
      { range: "'Students'!A1:Z1", values: [['studentId', 'name', 'balance', 'status']] },
      { range: "'Products'!A1:Z1", values: [['productId', 'name', 'price', 'stock', 'isActive']] },
    ] } });
    const store = new GoogleSheetsStore('env-sheet-id');

    await verifySpreadsheetAccess(store);
    await saveAppSettings({
      settingsStore: store, spreadsheetIdOrUrl: 'env-sheet-id', appTitle: '변경된 제목',
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
    });

    expect(googleMocks.sheetsValuesBatchGet).toHaveBeenCalledTimes(1);
    expect(googleMocks.sheetsValuesBatchGet).toHaveBeenCalledWith({
      spreadsheetId: 'env-sheet-id',
      ranges: ["'Settings'!A:Z", "'Students'!A:Z", "'Products'!A:Z"],
    });
    expect(googleMocks.sheetsValuesGet).not.toHaveBeenCalled();
    expect(googleMocks.sheetsApi.spreadsheets.values.batchUpdate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Students', [['studentId', 'name', 'status']], [['productId', 'name', 'price', 'stock', 'isActive']]],
    ['Products', [['studentId', 'name', 'balance', 'status']], [['productId', 'name', 'stock', 'isActive']]],
  ] as const)('fails operational validation when %s headers are malformed', async (_sheet, studentRows, productRows) => {
    googleMocks.sheetsValuesBatchGet.mockResolvedValue({ data: { valueRanges: [
      { values: [['key', 'value']] }, { values: studentRows }, { values: productRows },
    ] } });

    await expect(verifySpreadsheetAccess(new GoogleSheetsStore('env-sheet-id'))).rejects.toThrow(/필수 컬럼/);
    expect(googleMocks.sheetsValuesBatchGet).toHaveBeenCalledTimes(1);
    expect(googleMocks.sheetsValuesGet).not.toHaveBeenCalled();
  });

  it.each([
    ['Students', [], [['productId', 'name', 'price', 'stock', 'isActive']]],
    ['Products', [['studentId', 'name', 'balance', 'status']], []],
  ] as const)('fails operational validation when %s is completely empty', async (_sheet, studentRows, productRows) => {
    googleMocks.sheetsValuesBatchGet.mockResolvedValue({ data: { valueRanges: [
      { values: [['key', 'value']] }, { values: studentRows }, { values: productRows },
    ] } });

    await expect(verifySpreadsheetAccess(new GoogleSheetsStore('env-sheet-id'))).rejects.toThrow(/필수 컬럼/);
    expect(googleMocks.sheetsValuesBatchGet).toHaveBeenCalledTimes(1);
    expect(googleMocks.sheetsValuesGet).not.toHaveBeenCalled();
  });

  it('accepts canonical header-only Students and Products as valid empty datasets', async () => {
    googleMocks.sheetsValuesBatchGet.mockResolvedValue({ data: { valueRanges: [
      { values: [['key', 'value']] },
      { values: [['studentId', 'name', 'balance', 'status']] },
      { values: [['productId', 'name', 'price', 'stock', 'isActive']] },
    ] } });

    await expect(verifySpreadsheetAccess(new GoogleSheetsStore('env-sheet-id'))).resolves.toBeUndefined();
    expect(googleMocks.sheetsValuesBatchGet).toHaveBeenCalledTimes(1);
    expect(googleMocks.sheetsValuesGet).not.toHaveBeenCalled();
  });

  it('fails safely when the provider rejects a batch because a required sheet is missing', async () => {
    googleMocks.sheetsValuesBatchGet.mockRejectedValue(new Error('Unable to parse range: Products!1:1'));

    await expect(verifySpreadsheetAccess(new GoogleSheetsStore('env-sheet-id'))).rejects.toThrow(/접근하지 못했습니다/);
    expect(googleMocks.sheetsValuesBatchGet).toHaveBeenCalledTimes(1);
    expect(googleMocks.sheetsValuesGet).not.toHaveBeenCalled();
  });

  it('uses a deployment refresh token for public sheet access without service account credentials', async () => {
    const store = new GoogleSheetsStore('sheet-123');

    await expect(store.getRows('Students')).resolves.toEqual([['studentId'], ['S001']]);

    expect(googleMocks.OAuth2).toHaveBeenCalledWith('client-id', 'client-secret');
    expect(googleMocks.oauth2SetCredentials).toHaveBeenCalledWith({ refresh_token: 'refresh-token' });
    expect(googleMocks.JWT).not.toHaveBeenCalled();
    expect(googleMocks.sheets).toHaveBeenCalledWith({ version: 'v4', auth: googleMocks.oauth2Instances[0] });
    expect(googleMocks.sheetsValuesGet).toHaveBeenCalledWith({ spreadsheetId: 'sheet-123', range: "'Students'!A:Z" });
  });

  it('deduplicates concurrent and repeated reads per store while returning clone-safe rows', async () => {
    let resolveRead!: (value: unknown) => void;
    googleMocks.sheetsValuesGet.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    const store = new GoogleSheetsStore('sheet-123');

    const firstPromise = store.getRows('Students');
    const secondPromise = store.getRows('Students');
    await Promise.resolve();
    resolveRead({ data: { values: [['studentId'], ['S001']] } });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    first[1][0] = 'mutated';

    await expect(store.getRows('Students')).resolves.toEqual([['studentId'], ['S001']]);
    expect(second).toEqual([['studentId'], ['S001']]);
    expect(googleMocks.sheetsValuesGet).toHaveBeenCalledTimes(1);
  });

  it('does not share cached rows with a newly constructed store', async () => {
    googleMocks.sheetsValuesGet
      .mockResolvedValueOnce({ data: { values: [['studentId'], ['S001']] } })
      .mockResolvedValueOnce({ data: { values: [['studentId'], ['S002']] } });

    await expect(new GoogleSheetsStore('sheet-123').getRows('Students')).resolves.toEqual([['studentId'], ['S001']]);
    await expect(new GoogleSheetsStore('sheet-123').getRows('Students')).resolves.toEqual([['studentId'], ['S002']]);
    expect(googleMocks.sheetsValuesGet).toHaveBeenCalledTimes(2);
  });

  it('keeps the request-scoped snapshot coherent after update and append writes', async () => {
    googleMocks.sheetsValuesGet.mockResolvedValueOnce({ data: { values: [['key', 'value'], ['currencyUnit', '원']] } });
    const store = new GoogleSheetsStore('sheet-123');
    await store.getRows('Settings');

    await store.updateCell('Settings', 2, 'value', '별');
    await store.appendRows('Settings', [['appTitle', '햇살반 매점'], ['themeColor', 'green']]);

    await expect(store.getRows('Settings')).resolves.toEqual([
      ['key', 'value'], ['currencyUnit', '별'], ['appTitle', '햇살반 매점'], ['themeColor', 'green'],
    ]);
    expect(googleMocks.sheetsValuesGet).toHaveBeenCalledTimes(1);
    expect(googleMocks.sheetsApi.spreadsheets.values.append).toHaveBeenCalledTimes(1);
  });

  it.each(['Tasks', 'TaskAssignments', 'TaskCompletions'] as const)(
    'reads present recurring %s used range with one values.get',
    async (sheetName) => {
      const rows = [['id', 'legacyTail'], ['1', 'preserved']];
      googleMocks.sheetsValuesGet.mockResolvedValueOnce({ data: { values: rows } });

      await expect(new GoogleSheetsStore('sheet-123').getRows(sheetName)).resolves.toEqual(rows);

      expect(googleMocks.sheetsValuesGet).toHaveBeenCalledTimes(1);
      expect(googleMocks.sheetsValuesGet).toHaveBeenCalledWith({ spreadsheetId: 'sheet-123', range: `'${sheetName}'` });
      expect(googleMocks.sheetsApi.spreadsheets.get).not.toHaveBeenCalled();
    },
  );

  it('retries quota-limited reads with injected delay and sanitizes the final provider error', async () => {
    const quotaError = {
      response: { status: 429, headers: { 'retry-after': '1' }, data: { error: { status: 'RESOURCE_EXHAUSTED', message: 'project_number:123 secret' } } },
    };
    googleMocks.sheetsValuesGet.mockRejectedValue(quotaError);
    const sleep = vi.fn(async () => undefined);
    const store = new GoogleSheetsStore('sheet-123', undefined, { sleep, maxReadAttempts: 2 });

    await expect(store.getRows('Students')).rejects.toMatchObject({
      name: 'SheetProviderError', reason: 'QUOTA_EXCEEDED', message: 'Google Sheets 읽기 할당량을 초과했습니다. 잠시 후 다시 시도해 주세요.',
    });
    expect(googleMocks.sheetsValuesGet).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('never retries a quota-limited write', async () => {
    googleMocks.sheetsApi.spreadsheets.values.batchUpdate.mockRejectedValueOnce({ response: { status: 429 } });
    const sleep = vi.fn(async () => undefined);
    const store = new GoogleSheetsStore('sheet-123', undefined, { sleep, maxReadAttempts: 3 });

    await expect(store.updateCellsAtomicallyAcrossSheets([
      { sheetName: 'Settings', rowNumber: 2, columnNumber: 2, value: '별' },
    ])).rejects.toBeTruthy();
    expect(googleMocks.sheetsApi.spreadsheets.values.batchUpdate).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not auto-create or append when structured lookup says TaskAssignments is missing', async () => {
    googleMocks.sheetsApi.spreadsheets.get.mockResolvedValue({ data: { sheets: [] } });
    const store = new GoogleSheetsStore('sheet-123');

    await expect(store.appendRow('TaskAssignments', ['A-1'])).rejects.toThrow('TaskAssignments sheet is missing');
    expect(googleMocks.sheetsApi.spreadsheets.values.append).not.toHaveBeenCalled();
    expect(googleMocks.sheetsApi.spreadsheets.batchUpdate).not.toHaveBeenCalled();
    await expect(store.lookupSheet('TaskAssignments')).resolves.toEqual({ found: false, reason: 'SHEET_NOT_FOUND' });
  });

  it.each(['Settings', 'Tasks', 'TaskAssignments', 'TaskCompletions'] as const)(
    'preserves missing %s reads as write-free empty results',
    async (sheetName) => {
      googleMocks.sheetsValuesGet.mockRejectedValueOnce(new Error('Unable to parse range'));
      const store = new GoogleSheetsStore('sheet-123');

      await expect(store.getRows(sheetName)).resolves.toEqual([]);
      expect(googleMocks.sheetsApi.spreadsheets.batchUpdate).not.toHaveBeenCalled();
      expect(googleMocks.sheetsApi.spreadsheets.values.append).not.toHaveBeenCalled();
    },
  );

  it.each(['Promotions', 'PromotionProducts'] as const)(
    'preserves missing %s reads as write-free empty results',
    async (sheetName) => {
      googleMocks.sheetsValuesGet.mockRejectedValueOnce(new Error('Unable to parse range'));
      const store = new GoogleSheetsStore('sheet-123');

      await expect(store.getRows(sheetName)).resolves.toEqual([]);
      expect(googleMocks.sheetsApi.spreadsheets.batchUpdate).not.toHaveBeenCalled();
      expect(googleMocks.sheetsApi.spreadsheets.values.append).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['Promotions', "'Promotions'!A:Z"],
    ['PromotionProducts', "'PromotionProducts'!A:Z"],
  ] as const)('reads present %s rows from its operational range', async (sheetName, range) => {
    const store = new GoogleSheetsStore('sheet-123');

    await expect(store.getRows(sheetName)).resolves.toEqual([['studentId'], ['S001']]);
    expect(googleMocks.sheetsValuesGet).toHaveBeenCalledWith({ spreadsheetId: 'sheet-123', range });
  });

  it.each(['Promotions', 'PromotionProducts'] as const)(
    'does not auto-create missing %s during append',
    async (sheetName) => {
      googleMocks.sheetsApi.spreadsheets.values.append.mockRejectedValueOnce(new Error('Unable to parse range'));
      const store = new GoogleSheetsStore('sheet-123');

      await expect(store.appendRow(sheetName, ['P-1'])).rejects.toThrow('Unable to parse range');
      expect(googleMocks.sheetsApi.spreadsheets.batchUpdate).not.toHaveBeenCalled();
      expect(googleMocks.sheetsApi.spreadsheets.values.append).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['Settings', 'Tasks', 'TaskCompletions'] as const)(
    'preserves missing %s append creation and retries the append',
    async (sheetName) => {
      googleMocks.sheetsApi.spreadsheets.values.append
        .mockRejectedValueOnce(new Error('Unable to parse range'))
        .mockResolvedValueOnce({});
      const store = new GoogleSheetsStore('sheet-123');

      await store.appendRow(sheetName, ['legacy-compatible']);

      expect(googleMocks.sheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-123',
        requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
      });
      expect(googleMocks.sheetsApi.spreadsheets.values.append).toHaveBeenCalledTimes(2);
    },
  );

  it('uses live A:AC width for >26-column Tasks read, append, and update without dropping a legacy tail', async () => {
    const rows = [taskHeader, [...taskHeader.map((_, index) => `value${index + 1}`)]];
    googleMocks.sheetsValuesGet.mockImplementation(async ({ range }: { range: string }) => {
      if (range === "'Tasks'") return { data: { values: rows } };
      if (range === "'Tasks'!1:1") return { data: { values: [taskHeader] } };
      throw new Error(`unexpected range ${range}`);
    });
    const store = new GoogleSheetsStore('sheet-123');

    await expect(store.getRows('Tasks')).resolves.toEqual(rows);
    await store.appendRow('Tasks', Array.from({ length: 29 }, (_, index) => `new${index + 1}`));
    await store.updateCell('Tasks', 2, 'legacyCustom', 'preserved');

    expect(googleMocks.sheetsApi.spreadsheets.values.append).toHaveBeenCalledWith(expect.objectContaining({
      spreadsheetId: 'sheet-123', range: "'Tasks'!A:AC",
    }));
    expect(googleMocks.sheetsApi.spreadsheets.values.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-123',
      requestBody: { valueInputOption: 'RAW', data: [{ range: "'Tasks'!AC2", values: [['preserved']] }] },
    });
    expect(googleMocks.sheetsApi.spreadsheets.values.update).not.toHaveBeenCalled();
    expect(googleMocks.sheetsApi.spreadsheets.batchUpdate).not.toHaveBeenCalled();
  });

  it('updates cells across Settings and Tasks in exactly one RAW values.batchUpdate request', async () => {
    const store = new GoogleSheetsStore('sheet-123');

    await store.updateCellsAtomicallyAcrossSheets([
      { sheetName: 'Settings', rowNumber: 4, columnNumber: 2, value: 'America/New_York' },
      { sheetName: 'Tasks', rowNumber: 2, columnNumber: 13, value: 'America/New_York' },
      { sheetName: 'Tasks', rowNumber: 2, columnNumber: 20, value: 3 },
    ]);

    expect(googleMocks.sheetsApi.spreadsheets.values.batchUpdate).toHaveBeenCalledTimes(1);
    expect(googleMocks.sheetsApi.spreadsheets.values.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-123',
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: "'Settings'!B4", values: [['America/New_York']] },
          { range: "'Tasks'!M2", values: [['America/New_York']] },
          { range: "'Tasks'!T2", values: [[3]] },
        ],
      },
    });
    expect(googleMocks.sheetsValuesGet).not.toHaveBeenCalled();
  });

  it('creates a new assignment sheet and exact A1:O1 header in one atomic batch request', async () => {
    const store = new GoogleSheetsStore('sheet-123');
    await store.createSheetWithHeader('TaskAssignments', TASK_ASSIGNMENT_HEADERS);

    const call = googleMocks.sheetsApi.spreadsheets.batchUpdate.mock.calls[0][0];
    const requests = call.requestBody.requests;
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ addSheet: { properties: {
      title: 'TaskAssignments', gridProperties: { columnCount: 15 },
    } } });
    expect(requests[1]).toEqual({ updateCells: {
      range: {
        sheetId: requests[0].addSheet.properties.sheetId,
        startRowIndex: 0,
        endRowIndex: 1,
        startColumnIndex: 0,
        endColumnIndex: 15,
      },
      rows: [{ values: TASK_ASSIGNMENT_HEADERS.map((value) => ({ userEnteredValue: { stringValue: value } })) }],
      fields: 'userEnteredValue',
    } });
    expect(googleMocks.sheetsApi.spreadsheets.values.update).not.toHaveBeenCalled();
  });

  it('authoritatively maps any failed create batch to already-exists when title lookup finds the sheet', async () => {
    googleMocks.sheetsApi.spreadsheets.batchUpdate.mockRejectedValue({
      response: { status: 400, data: { error: { status: 'INVALID_ARGUMENT', message: 'bad request' } } },
    });
    mockSheetMetadata(29);
    const store = new GoogleSheetsStore('sheet-123');

    await expect(store.createSheetWithHeader('TaskAssignments', TASK_ASSIGNMENT_HEADERS)).rejects.toMatchObject({
      name: 'SheetProviderError', reason: 'SHEET_ALREADY_EXISTS',
    });
  });

  it('rethrows the original failed create error when authoritative lookup confirms the title is absent', async () => {
    const original = { response: { status: 400, data: { error: { status: 'INVALID_ARGUMENT' } } } };
    googleMocks.sheetsApi.spreadsheets.batchUpdate.mockRejectedValue(original);
    googleMocks.sheetsApi.spreadsheets.get.mockResolvedValue({ data: { sheets: [] } });
    const store = new GoogleSheetsStore('sheet-123');

    await expect(store.createSheetWithHeader('TaskAssignments', TASK_ASSIGNMENT_HEADERS)).rejects.toBe(original);
  });

  it('verifies the exact current and target header range immediately before an extension update', async () => {
    const store = new GoogleSheetsStore('sheet-123');
    const expected = ['taskId', 'title'];
    googleMocks.sheetsValuesGet.mockResolvedValue({ data: { values: [expected] } });

    await store.verifyAndWriteHeaderCells(
      'Tasks', { sheetId: 7, columnCount: 29, header: expected }, ['newHeader'],
    );

    expect(googleMocks.sheetsValuesGet).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-123', range: "'Tasks'!A1:C1",
    });
    expect(googleMocks.sheetsApi.spreadsheets.values.update).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-123', range: "'Tasks'!C1:C1", valueInputOption: 'RAW',
      requestBody: { values: [['newHeader']] },
    });
  });

  it('re-reads metadata and the current header and refuses a mismatched prefix before extension write', async () => {
    const store = new GoogleSheetsStore('sheet-123');
    const expected = ['taskId', 'title'];
    googleMocks.sheetsValuesGet.mockResolvedValue({ data: { values: [['taskId', 'racedTitle']] } });

    await expect(store.verifyAndWriteHeaderCells(
      'Tasks', { sheetId: 7, columnCount: 29, header: expected }, ['newHeader'],
    ))
      .rejects.toMatchObject({ name: 'MigrationConflictError', sheetName: 'Tasks', retryable: true });
    expect(googleMocks.sheetsApi.spreadsheets.values.update).not.toHaveBeenCalled();
  });

  it('refuses occupied right-side target cells before extension write', async () => {
    const store = new GoogleSheetsStore('sheet-123');
    const expected = ['taskId', 'title'];
    googleMocks.sheetsValuesGet.mockResolvedValue({ data: { values: [['taskId', 'title', 'concurrentOwner']] } });

    await expect(store.verifyAndWriteHeaderCells(
      'Tasks', { sheetId: 7, columnCount: 29, header: expected }, ['newHeader'],
    ))
      .rejects.toBeInstanceOf(MigrationConflictError);
    expect(googleMocks.sheetsApi.spreadsheets.values.update).not.toHaveBeenCalled();
  });

  it.each([
    [25, 'Z'], [26, 'AA'], [51, 'AZ'], [52, 'BA'],
  ])('converts zero-based column %i to A1 column %s', async (startColumn, letter) => {
    const store = new GoogleSheetsStore('sheet-123');
    await store.writeHeaderCells('Tasks', startColumn, ['header']);
    expect(googleMocks.sheetsApi.spreadsheets.values.update).toHaveBeenCalledWith(expect.objectContaining({
      range: `'Tasks'!${letter}1:${letter}1`,
    }));
  });

  it.each([-1, -26, 1.5])('rejects invalid zero-based column index %s', async (startColumn) => {
    const store = new GoogleSheetsStore('sheet-123');
    await expect(store.writeHeaderCells('Tasks', startColumn, ['header'])).rejects.toThrow('column index');
    expect(googleMocks.sheetsApi.spreadsheets.values.update).not.toHaveBeenCalled();
  });

  it('reports a retryable migration conflict if grid width changes before expansion', async () => {
    const store = new GoogleSheetsStore('sheet-123');
    await expect(store.ensureColumnCount('Tasks', 26, 28)).rejects.toBeInstanceOf(MigrationConflictError);
    expect(googleMocks.sheetsApi.spreadsheets.batchUpdate).not.toHaveBeenCalled();
  });
});
