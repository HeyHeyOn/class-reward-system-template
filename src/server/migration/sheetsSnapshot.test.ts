import { describe, expect, it } from 'vitest';
import { captureSheetsSnapshot, stableRowHash, type WorkbookSnapshotReader } from './sheetsSnapshot';

const REVISION = 'revision-1';

function reader(tabs: Record<string, string[][]>): WorkbookSnapshotReader {
  return {
    listSheetNames: async () => Object.keys(tabs),
    getRows: async (name) => tabs[name] ?? [],
    getRevision: async () => REVISION,
  };
}

function workbook(version: 1 | 2 | 3): Record<string, string[][]> {
  return {
    Students: [['studentId', 'name', 'balance', 'status', '', 'custom'], ['S1', 'One', '1', 'ACTIVE', '', 'future']],
    Products: [['productId', 'name', 'price', 'stock', 'isActive'], ['P1', 'Pen', '1', '2', 'TRUE']],
    Transactions: [['transactionId'], ['T1']],
    Adjustments: [['adjustmentId'], ['A1']],
    Settings: [['key', 'value'], ['schemaVersion', String(version)], ['recoveryCodeHash', 'a'.repeat(64)], ['plainPassword', 'never-export']],
    Tasks: [['taskId'], ['TASK1']],
    Recovery: [['key', 'value'], ['recoveryCode', 'ABCD-EFGH']],
  };
}

describe('immutable Sheets snapshots', () => {
  it.each(['headers', 'data row'] as const)('rejects sparse %s before budget, copy, or hashing work', async (location) => {
    const source = workbook(3) as Record<string, unknown[][]>;
    let convertedCells = 0;
    const sparse = new Array<unknown>(1_999_900);
    sparse[0] = { toString: () => { convertedCells += 1; return location === 'headers' ? 'studentId' : 'S1'; } };
    sparse[sparse.length - 1] = 'defined-tail';
    if (location === 'headers') source.Students[0] = sparse;
    else {
      source.Students[0][0] = { toString: () => { convertedCells += 1; return 'studentId'; } };
      source.Students[1] = sparse;
    }
    const presentEntries = Object.entries(sparse);

    await expect(captureSheetsSnapshot({
      spreadsheetId: 'sheet-1', capturedAt: '2026-09-05T00:00:00.000Z', reader: reader(source as Record<string, string[][]>),
    })).rejects.toThrow(/workbook row is invalid/i);
    expect(convertedCells).toBe(0);
    expect(sparse).toHaveLength(1_999_900);
    expect(Object.entries(sparse)).toEqual(presentEntries);
    expect(Object.hasOwn(sparse, 1)).toBe(false);
  });

  it('rejects aggregate UTF-8 content before processing every individually valid cell', async () => {
    const source = workbook(3) as Record<string, unknown[][]>;
    let convertedCells = 0;
    const oversizedRows = Array.from({ length: 12 }, () => [{
      toString: () => {
        convertedCells += 1;
        return 'x'.repeat(95_000);
      },
    }]);
    source.LargeButIndividuallyValid = oversizedRows;

    await expect(captureSheetsSnapshot({
      spreadsheetId: 'sheet-1',
      capturedAt: '2026-09-05T00:00:00.000Z',
      reader: reader(source as Record<string, string[][]>),
    })).rejects.toThrow(/aggregate|byte|size/i);
    expect(convertedCells).toBeLessThan(oversizedRows.length);
  });

  it('counts aggregate content in UTF-8 bytes rather than UTF-16 code units', async () => {
    const ascii = workbook(3);
    ascii.Utf8Budget = Array.from({ length: 5 }, () => ['a'.repeat(70_000)]);
    await expect(captureSheetsSnapshot({
      spreadsheetId: 'sheet-1', capturedAt: '2026-09-05T00:00:00.000Z', reader: reader(ascii),
    })).resolves.toMatchObject({ spreadsheetId: 'sheet-1' });

    const multibyte = workbook(3);
    multibyte.Utf8Budget = Array.from({ length: 5 }, () => ['한'.repeat(70_000)]);
    await expect(captureSheetsSnapshot({
      spreadsheetId: 'sheet-1', capturedAt: '2026-09-05T00:00:00.000Z', reader: reader(multibyte),
    })).rejects.toThrow(/aggregate|byte|size/i);
  });

  it('preserves prototype-named tabs as own enumerable digest-covered data without pollution', async () => {
    const source = Object.assign(Object.create(null) as Record<string, string[][]>, workbook(3));
    source['__proto__'] = [['id'], ['proto-row']];
    source['constructor'] = [['id'], ['constructor-row']];
    source['prototype'] = [['id'], ['prototype-row']];

    const snapshot = await captureSheetsSnapshot({
      spreadsheetId: 'sheet-1', capturedAt: '2026-09-05T00:00:00.000Z', reader: reader(source),
    });
    expect(Object.getPrototypeOf(snapshot.tabs)).toBeNull();
    expect(Object.keys(snapshot.tabs)).toEqual(expect.arrayContaining(['__proto__', 'constructor', 'prototype']));
    expect(snapshot.tabs['__proto__'].rows[0]?.cells).toEqual(['proto-row']);
    expect(snapshot.tabs['constructor'].rows[0]?.cells).toEqual(['constructor-row']);
    expect(snapshot.tabs['prototype'].rows[0]?.cells).toEqual(['prototype-row']);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();

    source['__proto__'] = [['id'], ['changed-proto-row']];
    const changed = await captureSheetsSnapshot({
      spreadsheetId: 'sheet-1', capturedAt: '2026-09-05T00:00:00.000Z', reader: reader(source),
    });
    expect(changed.digest).not.toBe(snapshot.digest);
  });

  it.each([1, 2, 3] as const)('captures schema v%i with missing optional tabs and preserves blank/custom/trailing headers', async (schemaVersion) => {
    const source = workbook(schemaVersion);
    const snapshot = await captureSheetsSnapshot({
      spreadsheetId: 'sheet-1',
      capturedAt: '2026-09-05T00:00:00.000Z',
      reader: reader(source),
    });

    expect(snapshot.schemaVersion).toBe(schemaVersion);
    expect(snapshot.missingOptionalTabs).toContain('Promotions');
    expect(snapshot.tabs.Students?.headers).toEqual(['studentId', 'name', 'balance', 'status', '', 'custom']);
    expect(snapshot.tabs.Students?.rows[0]?.cells).toEqual(['S1', 'One', '1', 'ACTIVE', '', 'future']);
    expect(snapshot.tabs).not.toHaveProperty('Recovery');
    expect(JSON.stringify(snapshot)).not.toContain('ABCD-EFGH');
    expect(JSON.stringify(snapshot)).not.toContain('never-export');
    expect(snapshot.credentialHashes).toEqual({ recoveryCodeHash: 'a'.repeat(64) });
  });

  it('captures schema version from reordered, whitespace-padded Settings headers', async () => {
    const source = workbook(1);
    source.Settings = [
      ['note', ' value ', ' key '],
      ['public', '3', 'schemaVersion'],
      ['unsafe', 'hunter2', 'adminPassword'],
    ];

    const snapshot = await captureSheetsSnapshot({
      spreadsheetId: 'sheet-1',
      capturedAt: '2026-09-05T00:00:00.000Z',
      reader: reader(source),
    });

    expect(snapshot.schemaVersion).toBe(3);
    expect(snapshot.tabs.Settings?.headers).toEqual(['note', ' value ', ' key ']);
    expect(JSON.stringify(snapshot)).not.toContain('hunter2');
  });

  it('deep-detaches, freezes, and produces deterministic hashes with unambiguous cell encoding', async () => {
    const source = workbook(3);
    const snapshot = await captureSheetsSnapshot({ spreadsheetId: 'sheet-1', capturedAt: '2026-09-05T00:00:00.000Z', reader: reader(source) });
    source.Students[1][1] = 'mutated';

    expect(snapshot.tabs.Students?.rows[0]?.cells[1]).toBe('One');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tabs.Students?.rows[0]?.cells)).toBe(true);
    expect(stableRowHash(['a\u0000b', 'c'])).not.toBe(stableRowHash(['a', 'b\u0000c']));
    expect(stableRowHash(['one', 'two'])).toBe(stableRowHash(['one', 'two']));
  });

  it('canonicalizes snapshot ordering without locale-dependent comparison', async () => {
    const source = { ...workbook(3), äCustom: [['id'], ['2']], ZCustom: [['id'], ['1']] };
    const originalLocaleCompare = String.prototype.localeCompare;
    String.prototype.localeCompare = () => { throw new Error('localeCompare must not be used'); };
    try {
      const snapshot = await captureSheetsSnapshot({
        spreadsheetId: 'sheet-1',
        capturedAt: '2026-09-05T00:00:00.000Z',
        reader: reader(source),
      });
      expect(Object.keys(snapshot.tabs)).toEqual([
        'Adjustments', 'Products', 'Settings', 'Students', 'Tasks', 'Transactions', 'ZCustom', 'äCustom',
      ]);
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });

  it('uses an unambiguous canonical row encoding with a stable known digest', () => {
    expect(stableRowHash(['a', 'bc'])).not.toBe(stableRowHash(['ab', 'c']));
    expect(stableRowHash(['', '\u0000', '한글'])).toBe('1f112f965ca92c241cec2c6ca3ef45d87bd78c5a18e146dc3fdeef3d7afdb676');
  });

  it('fails closed when the source revision changes during capture', async () => {
    let reads = 0;
    const unstable: WorkbookSnapshotReader = {
      ...reader(workbook(1)),
      getRevision: async () => (++reads === 1 ? 'before' : 'after'),
    };
    await expect(captureSheetsSnapshot({ spreadsheetId: 'sheet-1', capturedAt: '2026-09-05T00:00:00.000Z', reader: unstable }))
      .rejects.toThrow(/changed/i);
  });
});
