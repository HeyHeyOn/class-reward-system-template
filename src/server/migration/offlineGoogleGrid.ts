import { createHash } from 'node:crypto';
import { isSensitiveTabName } from './sensitiveRedaction';

/** Coordinate-preserving adapter for a private includeGridData capture, not an acquisition. */
export function readOfflineGoogleGrid(gridJson: string): {
  spreadsheetId: string; contentSha256: string; tabs: Record<string, string[][]>;
} {
  if (typeof gridJson !== 'string' || Buffer.byteLength(gridJson, 'utf8') > 32_000_000) fail('bounds');
  let grid: unknown;
  try { grid = JSON.parse(gridJson); } catch { fail('JSON'); }
  if (!record(grid) || typeof grid.spreadsheetId !== 'string' || !Array.isArray(grid.sheets)
    || grid.sheets.length > 64) fail('shape');
  const tabs: Record<string, string[][]> = Object.create(null);
  let totalCells = 0;
  for (const sheet of grid.sheets) {
    if (!record(sheet) || !record(sheet.properties) || typeof sheet.properties.title !== 'string') fail('sheet');
    const name = sheet.properties.title;
    if (isSensitiveTabName(name)) fail('credential tab');
    if (!name || name.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(name) || Object.hasOwn(tabs, name)) fail('sheet name');
    const blocks = sheet.data ?? [];
    if (!Array.isArray(blocks) || blocks.length > 256) fail('bounds');
    let height = 0, width = 0;
    const admitted: Array<{ r: number; c: number; rows: unknown[][] }> = [];
    for (const block of blocks) {
      if (!record(block)) fail('block');
      const r = coordinate(block.startRow), c = coordinate(block.startColumn);
      const rows = block.rowData ?? [];
      if (!Array.isArray(rows) || r + rows.length > 250_000 || c > 256) fail('bounds');
      height = Math.max(height, r + rows.length);
      const admittedRows: unknown[][] = [];
      for (const row of rows) {
        if (!record(row)) fail('row');
        const values = row.values ?? [];
        if (!Array.isArray(values) || c + values.length > 256) fail('bounds');
        width = Math.max(width, c + values.length);
        admittedRows.push(values);
      }
      admitted.push({ r, c, rows: admittedRows });
    }
    totalCells += height * Math.max(width, 1);
    if (totalCells > 2_000_000) fail('bounds');
    const rows = Array.from({ length: height }, () => Array<string>(width).fill(''));
    const occupied = new Set<number>();
    for (const { r, c, rows: inputRows } of admitted) {
      for (const [offset, values] of inputRows.entries()) {
        for (const [column, cell] of values.entries()) {
          const key = (r + offset) * Math.max(width, 1) + c + column;
          if (occupied.has(key)) fail('overlapping cells');
          occupied.add(key);
          if (!record(cell)) fail('cell');
          if (cell.formattedValue !== undefined && typeof cell.formattedValue !== 'string') fail('display value');
          if (cell.formattedValue === undefined && (cell.effectiveValue !== undefined || cell.userEnteredValue !== undefined)) fail('missing display value');
          rows[r + offset][c + column] = cell.formattedValue ?? '';
        }
      }
    }
    tabs[name] = rows;
  }
  return { spreadsheetId: grid.spreadsheetId, contentSha256: createHash('sha256').update(gridJson, 'utf8').digest('hex'), tabs };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function coordinate(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 250_000) fail('bounds');
  return value;
}
function fail(reason: string): never { throw new Error(`Offline grid ${reason} is invalid.`); }
