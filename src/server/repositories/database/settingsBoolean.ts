/** Sheets saves this setting as TRUE/FALSE text; modern commands save JSON
 * booleans. Read both representations without rewriting the imported evidence.
 */
export function storedQrManualInputEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'TRUE') return true;
  if (value === 'FALSE') return false;
  throw new Error('Tenant setting qrManualInputEnabled must be a boolean or canonical Sheets boolean.');
}
