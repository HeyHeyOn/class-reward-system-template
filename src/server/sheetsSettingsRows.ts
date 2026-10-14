import { createHeaderIndex, requireColumns } from '@/server/sheetsRows';

/** Pure Settings-row parser shared by legacy storage and offline migration validation. */
export function parseSheetSettingsRows(rows: string[][]): Record<string, string> {
  const [headers, ...dataRows] = rows;

  if (!headers) return {};

  const headerIndex = createHeaderIndex(headers);
  const required = requireColumns(headerIndex, ['key', 'value']);
  if (!required.ok) throw new Error(`Settings 시트에 필수 컬럼이 없어요: ${required.missingColumns.join(', ')}`);
  const keyIndex = headerIndex.get('key');
  const valueIndex = headerIndex.get('value');

  if (keyIndex === undefined || keyIndex < 0 || valueIndex === undefined || valueIndex < 0) {
    throw new Error('Settings 시트에 필수 컬럼이 없어요: key, value');
  }

  return Object.fromEntries(
    dataRows
      .map((row) => [String(row[keyIndex] ?? '').trim(), String(row[valueIndex] ?? '').trim()] as const)
      .filter(([key]) => Boolean(key)),
  );
}
