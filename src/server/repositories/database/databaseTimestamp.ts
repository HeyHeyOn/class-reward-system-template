/** Drizzle raw execute returns UTC timestamptz text; PGlite returns Date.
 * Keep the full microsecond identity for readback, and a Date only for ordering.
 * Match the existing task-admin evidence grammar, without broad string coercion.
 */
export function databaseTimestamp(value: unknown, failure = 'Invalid timestamp evidence.'): string {
  if (value instanceof Date && Object.getPrototypeOf(value) === Date.prototype
    && Reflect.ownKeys(value).length === 0 && Number.isFinite(Date.prototype.getTime.call(value))) return value.toISOString();
  if (typeof value !== 'string') throw new Error(failure);
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?\+00$/.exec(value);
  if (!match) throw new Error(failure);
  const fraction = (match[3] ?? '').padEnd(3, '0');
  const milliseconds = `${match[1]}T${match[2]}.${fraction.slice(0, 3)}Z`;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== milliseconds) throw new Error(failure);
  return `${match[1]}T${match[2]}.${fraction}Z`;
}
export function databaseTimestampDate(value: unknown, failure = 'Invalid timestamp evidence.'): Date {
  return new Date(databaseTimestamp(value, failure));
}
