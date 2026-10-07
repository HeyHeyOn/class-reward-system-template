import { describe, it, expect } from 'vitest';
import * as snapshots from './sheetsSnapshot';
const at = '2026-09-29T00:00:00.000Z';
const cell = (formattedValue: string) => ({ formattedValue });
function grid() {
  return { spreadsheetId: 'synthetic-sheet', sheets: [
    ...['Students', 'Products', 'Transactions', 'Adjustments', 'Tasks'].map(title => ({ properties: { title }, data: [{ rowData: [{ values: [cell('id'), cell(''), cell('custom')] }] }] })),
    { properties: { title: 'Settings' }, data: [{ rowData: [{ values: [cell('key'), cell('value')] }, { values: [cell('schemaVersion'), cell('4')] }] }] },
  ] };
}
describe('offline Google grid adapter', () => {
  it('uses displayed values and preserves offsets, empty rows, blank headers and extra columns', async () => {
    const source = grid();
    const data = source.sheets[0].data as Array<{ startRow?: number; startColumn?: number; rowData: Array<{ values: Array<{ formattedValue: string }> }> }>;
    data.push({ startRow: 3, startColumn: 2, rowData: [{ values: [cell('001.00'), cell('extra')] }] });
    const snapshot = await snapshots.captureOfflineGoogleGridBaseline({ gridJson: JSON.stringify(source), capturedAt: at });
    expect(snapshot.sourceRevision).toBe('');
    expect(snapshot.offlineBaseline?.kind).toBe('OFFLINE_GRID_REHEARSAL');
    expect(snapshot.tabs.Students.headers).toEqual(['id', '', 'custom', '']);
    expect(snapshot.tabs.Students.rows.map(row => [row.rowNumber, row.cells])).toEqual([
      [2, ['', '', '', '']], [3, ['', '', '', '']], [4, ['', '', '001.00', 'extra']],
    ]);
  });
  it('rejects nonempty cell objects without a display value rather than stringifying them', async () => {
    const source = grid();
    Object.assign(source.sheets[0].data[0].rowData[0].values[0], { formattedValue: undefined, effectiveValue: { numberValue: 7 } });
    await expect(snapshots.captureOfflineGoogleGridBaseline({ gridJson: JSON.stringify(source), capturedAt: at })).rejects.toThrow(/display/i);
  });
  it('rejects a credentials tab rather than examining its cells', async () => {
    const source = grid(); source.sheets[0].properties.title = 'Recovery';
    await expect(snapshots.captureOfflineGoogleGridBaseline({ gridJson: JSON.stringify(source), capturedAt: at })).rejects.toThrow(/credential/i);
  });
  it('bounds offsets before allocating sparse grid coordinates', async () => {
    const source = grid(); Object.assign(source.sheets[0].data[0], { startRow: 999999999 });
    await expect(snapshots.captureOfflineGoogleGridBaseline({ gridJson: JSON.stringify(source), capturedAt: at })).rejects.toThrow(/bounds/i);
  });
});
