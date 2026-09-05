const SENSITIVE_WORDS = new Set([
  'recovery', 'recoveries', 'password', 'passwords', 'secret', 'secrets',
  'token', 'tokens', 'credential', 'credentials',
]);
const ENDPOINT_LOCATOR_WORDS = new Set(['url', 'uri', 'endpoint', 'host']);
const ALLOWED_HASH_KEYS = new Set(['adminPasswordHash', 'recoveryCodeHash']);
const SHA256 = /^[a-f0-9]{64}$/;
const SCRYPT = /^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/;

export type CredentialHashes = Readonly<{
  adminPasswordHash?: string;
  recoveryCodeHash?: string;
}>;

export type RedactedWorkbook = Readonly<{
  tabs: Readonly<Record<string, readonly (readonly string[])[]>>;
  credentialHashes: CredentialHashes;
}>;

export function redactWorkbook(input: Readonly<Record<string, readonly (readonly unknown[])[]>>): RedactedWorkbook {
  const tabs = Object.create(null) as Record<string, string[][]>;
  const credentialHashes: { adminPasswordHash?: string; recoveryCodeHash?: string } = {};
  for (const [name, inputRows] of Object.entries(input)) {
    if (isSensitiveTabName(name)) continue;
    for (const row of inputRows) assertDenseWorkbookRow(row);
    const rows = inputRows.map((row) => row.map((cell) => String(cell ?? '')));
    if (name.trim().toLowerCase() === 'settings') {
      const [headers = [], ...data] = rows;
      const keyIndex = uniqueSettingsHeaderIndex(headers, 'key');
      const valueIndex = uniqueSettingsHeaderIndex(headers, 'value');
      const keepIndexes = headers.map((header, index) => ({ header, index }))
        .filter(({ header }) => !isSensitiveName(header)).map(({ index }) => index);
      const safeRows = data.filter((row) => {
        const key = String(row[keyIndex] ?? '').trim();
        const value = String(row[valueIndex] ?? '').trim();
        if (key === 'adminPasswordHash' && isSupportedAdminHash(value)) {
          credentialHashes.adminPasswordHash = value;
          return true;
        }
        if (key === 'recoveryCodeHash' && SHA256.test(value)) {
          credentialHashes.recoveryCodeHash = value;
          return true;
        }
        return !isSensitiveName(key);
      });
      tabs[name] = [headers.filter((_, index) => keepIndexes.includes(index)),
        ...safeRows.map((row) => keepIndexes.map((index) => row[index] ?? ''))];
      continue;
    }
    const [headers = [], ...data] = rows;
    const keepIndexes = headers.map((header, index) => ({ header, index }))
      .filter(({ header }) => !isSensitiveName(header)).map(({ index }) => index);
    tabs[name] = [headers.filter((_, index) => keepIndexes.includes(index)),
      ...data.map((row) => keepIndexes.map((index) => row[index] ?? ''))];
  }
  return deepFreeze({ tabs, credentialHashes });
}

export function assertDenseWorkbookRow(row: unknown): asserts row is readonly unknown[] {
  if (!Array.isArray(row)) throw new Error('Workbook row is invalid.');
  for (let index = 0; index < row.length; index += 1) {
    if (!Object.hasOwn(row, index)) throw new Error('Workbook row is invalid.');
  }
}

export function redactForExport<T>(input: T): T {
  return redactValue(input, '') as T;
}

export function assertNoSensitiveData(input: unknown): void {
  visit(input, '');
}

function visit(value: unknown, key: string): void {
  if (key === 'credentialHashes') {
    if (!isCredentialHashes(value)) throw new Error('Sensitive data is not permitted in migration artifacts.');
    return;
  }
  if (isSensitiveName(key) && value !== '[REDACTED]' && !isAllowedHash(key, value)) {
    throw new Error('Sensitive data is not permitted in migration artifacts.');
  }
  if (Array.isArray(value)) {
    const rowKey = typeof value[0] === 'string' ? value[0] : '';
    if (isSensitiveName(rowKey)) {
      for (const child of value.slice(1)) {
        if (child !== '[REDACTED]' && !isAllowedHash(rowKey, child)) {
          throw new Error('Sensitive data is not permitted in migration artifacts.');
        }
      }
      return;
    }
    for (const item of value) visit(item, '');
  } else if (isRecord(value)) {
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  }
}

function redactValue(value: unknown, key: string): unknown {
  if (key === 'credentialHashes') return isCredentialHashes(value) ? value : '[REDACTED]';
  if (isSensitiveName(key) && !isAllowedHash(key, value)) return '[REDACTED]';
  if (Array.isArray(value)) {
    const rowKey = typeof value[0] === 'string' ? value[0] : '';
    if (isSensitiveName(rowKey)) {
      return value.map((item, index) => index === 0 || item === '[REDACTED]' || isAllowedHash(rowKey, item)
        ? item : '[REDACTED]');
    }
    return value.map((item) => redactValue(item, ''));
  }
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey)]));
  return value;
}

function isAllowedHash(key: string, value: unknown): boolean {
  return ALLOWED_HASH_KEYS.has(key) && typeof value === 'string'
    && (key === 'recoveryCodeHash' ? SHA256.test(value) : isSupportedAdminHash(value));
}

function isCredentialHashes(value: unknown): value is CredentialHashes {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string' || !ALLOWED_HASH_KEYS.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
      && isAllowedHash(key, descriptor.value);
  });
}

function isSupportedAdminHash(value: string): boolean {
  return SHA256.test(value) || SCRYPT.test(value);
}

function isSensitiveName(value: string): boolean {
  const words = identifierWords(value);
  const wordSet = new Set(words);
  return words.some((word) => SENSITIVE_WORDS.has(word))
    || words.some((word, index) => word === 'api' && words[index + 1] === 'key')
    || words.some((word, index) => word === 'private' && words[index + 1] === 'key')
    || (wordSet.has('redis') && words.some((word) => ENDPOINT_LOCATOR_WORDS.has(word)));
}

export function isSensitiveTabName(value: string): boolean {
  return isSensitiveName(value);
}

function identifierWords(value: string): string[] {
  return value.trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function uniqueSettingsHeaderIndex(headers: readonly string[], required: 'key' | 'value'): number {
  const matches = headers.map((header, index) => ({ header: header.trim(), index }))
    .filter(({ header }) => header === required);
  if (matches.length !== 1) throw new Error(`Settings ${required} header is missing or duplicated.`);
  return matches[0].index;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
