/**
 * Logging a failure without the data around it. A failed Drizzle query puts the SQL and its bound values (a
 * student's name, number and balance) in `message` and `params` and keeps the driver's error as `cause`. So a
 * caught failure is logged as a fixed label with the error's class name and a code of a known shape (a Postgres
 * SQLSTATE such as 57P01, a Node code such as ECONNRESET), never its message, params or cause. The same rule as
 * the 딴쌤 hub's src/server/log.ts.
 */

const NAME = /^[A-Za-z]{1,40}$/;
const CODE = /^(?:[0-9A-Z]{5}|E[A-Z0-9_]{2,40})$/;

/** 'DrizzleQueryError 57P01', 'TypeError', 'Error'. */
export function errorTag(error: unknown): string {
  const named = error && typeof error === 'object' ? (error as { constructor?: { name?: unknown }; name?: unknown }) : null;
  const name = [named?.constructor?.name, named?.name].find((value): value is string => typeof value === 'string' && NAME.test(value) && value !== 'Object') ?? 'Error';
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && CODE.test(code)) return `${name} ${code}`;
    current = (current as { cause?: unknown }).cause;
  }
  return name;
}

export function logFailure(label: string, error: unknown): void {
  console.error(label, errorTag(error));
}
