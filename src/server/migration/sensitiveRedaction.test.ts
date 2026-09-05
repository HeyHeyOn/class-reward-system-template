import { describe, expect, it } from 'vitest';
import { assertNoSensitiveData, redactForExport, redactWorkbook } from './sensitiveRedaction';

describe('migration sensitive-data redaction', () => {
  it.each(['headers', 'data row'] as const)('fails closed on sparse workbook %s without changing the source', (location) => {
    let convertedCells = 0;
    const sparse = new Array<unknown>(1_999_900);
    sparse[0] = { toString: () => { convertedCells += 1; return location === 'headers' ? 'studentId' : 'S1'; } };
    sparse[sparse.length - 1] = 'defined-tail';
    const source = { Students: location === 'headers' ? [sparse, ['S1']] : [['studentId'], sparse] };
    const presentEntries = Object.entries(sparse);

    expect(() => redactWorkbook(source)).toThrow(/workbook row is invalid/i);
    expect(convertedCells).toBe(0);
    expect(sparse).toHaveLength(1_999_900);
    expect(Object.entries(sparse)).toEqual(presentEntries);
    expect(Object.hasOwn(sparse, 1)).toBe(false);
  });

  it('preserves prototype-named non-sensitive tabs as own enumerable frozen data without pollution', () => {
    const source = Object.create(null) as Record<string, string[][]>;
    source['__proto__'] = [['id'], ['proto-row']];
    source['constructor'] = [['id'], ['constructor-row']];
    source['prototype'] = [['id'], ['prototype-row']];

    const redacted = redactWorkbook(source);

    expect(Object.getPrototypeOf(redacted.tabs)).toBeNull();
    expect(Object.keys(redacted.tabs)).toEqual(['__proto__', 'constructor', 'prototype']);
    expect(redacted.tabs['__proto__']).toEqual([['id'], ['proto-row']]);
    expect(redacted.tabs['constructor']).toEqual([['id'], ['constructor-row']]);
    expect(redacted.tabs['prototype']).toEqual([['id'], ['prototype-row']]);
    expect(Object.isFrozen(redacted.tabs['__proto__'])).toBe(true);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('omits Recovery and credential columns while retaining only supported trusted Settings hashes', () => {
    const adminHash = `scrypt$16384$8$1$${'a'.repeat(32)}$${'b'.repeat(64)}`;
    const redacted = redactWorkbook({
      Recovery: [['key', 'value'], ['recoveryCode', 'ABCD-EFGH']],
      Settings: [['key', 'value', 'password'], ['adminPasswordHash', adminHash, 'plain'], ['recoveryCodeHash', 'c'.repeat(64)], ['apiToken', 'token']],
      Students: [['studentId', 'name', 'secretNote'], ['S1', 'One', 'do not export']],
    });

    expect(redacted.tabs).not.toHaveProperty('Recovery');
    expect(redacted.tabs.Settings).toEqual([['key', 'value'], ['adminPasswordHash', adminHash], ['recoveryCodeHash', 'c'.repeat(64)]]);
    expect(redacted.tabs.Students).toEqual([['studentId', 'name'], ['S1', 'One']]);
    expect(redacted.credentialHashes).toEqual({ adminPasswordHash: adminHash, recoveryCodeHash: 'c'.repeat(64) });
    expect(JSON.stringify(redacted)).not.toMatch(/ABCD-EFGH|plain|token|do not export/);
  });

  it('redacts nested report/export fields and rejects leaked secrets', () => {
    expect(redactForExport({ ok: 1, nested: { accessToken: 'secret', diagnostics: [{ password: 'pw', row: 2 }] } }))
      .toEqual({ ok: 1, nested: { accessToken: '[REDACTED]', diagnostics: [{ password: '[REDACTED]', row: 2 }] } });
    expect(() => assertNoSensitiveData({ Recovery: 'secret' })).toThrow(/sensitive/i);
    expect(() => assertNoSensitiveData(redactForExport({ Recovery: 'secret' }))).not.toThrow();
  });

  it('omits Redis locator names with intervening provider or protocol words from workbook settings and headers', () => {
    const redisLocatorNames = [
      'upstashRedisRestUrl',
      'UPSTASH_REDIS_REST_URL',
      'redisRestEndpoint',
      'RedisTlsConnectionUri',
      'redis-provider-http-host',
      'redis cloud tls endpoint',
    ];
    const redacted = redactWorkbook({
      Settings: [
        ['key', 'value'],
        ...redisLocatorNames.map((name, index) => [name, `redis-location-${index}`]),
        ['schemaVersion', '3'],
      ],
      Diagnostics: [
        ['status', ...redisLocatorNames],
        ['ok', ...redisLocatorNames.map((_, index) => `redis-header-location-${index}`)],
      ],
    });

    expect(redacted.tabs.Settings).toEqual([['key', 'value'], ['schemaVersion', '3']]);
    expect(redacted.tabs.Diagnostics).toEqual([['status'], ['ok']]);
    expect(JSON.stringify(redacted)).not.toMatch(/redis-(?:location|header-location)-/);
  });

  it.each([
    'upstashRedisRestUrl',
    'UPSTASH_REDIS_REST_URL',
    'redisRestEndpoint',
    'RedisTlsConnectionUri',
    'redis-provider-http-host',
    'redis cloud tls endpoint',
  ])('redacts and rejects Redis locator object properties and row-array names: %s', (name) => {
    const artifact = { report: { [name]: 'deployment-local-redis' }, rows: [[name, 'deployment-local-row-redis']] };
    const redacted = redactForExport(artifact);

    expect(redacted).toEqual({ report: { [name]: '[REDACTED]' }, rows: [[name, '[REDACTED]']] });
    expect(() => assertNoSensitiveData(artifact)).toThrow(/sensitive/i);
    expect(() => assertNoSensitiveData(redacted)).not.toThrow();
  });

  it.each(['redistributionUrl', 'creditRedistributionHost', 'RedisplayEndpoint', 'redistributable_uri'])
    ('preserves ordinary business names containing redis-like substrings: %s', (name) => {
      const artifact = { [name]: 'ordinary-business-value', rows: [[name, 'ordinary-row-value']] };

      expect(redactForExport(artifact)).toEqual(artifact);
      expect(() => assertNoSensitiveData(artifact)).not.toThrow();
    });

  it('resolves reordered, whitespace-padded Settings headers before redacting credentials', () => {
    const adminHash = `scrypt$16384$8$1$${'a'.repeat(32)}$${'b'.repeat(64)}`;
    const redacted = redactWorkbook({
      Settings: [
        ['note', ' value ', ' key '],
        ['public', '3', 'schemaVersion'],
        ['trusted', adminHash, 'adminPasswordHash'],
        ['unsafe', 'hunter2', 'adminPassword'],
        ['unsafe', 'ABCD-EFGH', 'recoveryCode'],
      ],
    });

    expect(redacted.tabs.Settings).toEqual([
      ['note', ' value ', ' key '],
      ['public', '3', 'schemaVersion'],
      ['trusted', adminHash, 'adminPasswordHash'],
    ]);
    expect(redacted.credentialHashes).toEqual({ adminPasswordHash: adminHash });
    expect(JSON.stringify(redacted)).not.toMatch(/hunter2|ABCD-EFGH/);
  });

  it.each([
    { rows: [['key'], ['schemaVersion']] },
    { rows: [['value'], ['3']] },
    { rows: [['key', ' key ', 'value'], ['schemaVersion', 'ignored', '3']] },
    { rows: [['key', 'value', ' value '], ['schemaVersion', '3', 'ignored']] },
    { rows: [['', 'value'], ['schemaVersion', '3']] },
  ])('fails closed for malformed Settings headers %#', ({ rows }) => {
    expect(() => redactWorkbook({ Settings: rows })).toThrow(/settings.*header/i);
  });

  it('omits conservative credential-bearing tab aliases without dropping ordinary business tabs', () => {
    const redacted = redactWorkbook({
      ' Recovery Codes ': [['code'], ['ABCD-EFGH']],
      Credentials: [['name', 'value'], ['admin', 'hunter2']],
      'API Tokens': [['token'], ['secret-token']],
      PasswordResetAudit: [['event'], ['reset']],
      RawMaterials: [['sku'], ['RAW-1']],
      Drawings: [['name'], ['Poster']],
    });

    expect(Object.keys(redacted.tabs)).toEqual(['RawMaterials', 'Drawings']);
    expect(JSON.stringify(redacted)).not.toMatch(/ABCD-EFGH|hunter2|secret-token|reset/);
  });

  it('redacts and detects sensitive key/value rows nested in array-shaped reports', () => {
    const report = { rows: [['password', 'secret'], ['status', 'ok']], nested: [[['apiToken', 'token-value']]] };

    expect(redactForExport(report)).toEqual({
      rows: [['password', '[REDACTED]'], ['status', 'ok']],
      nested: [[['apiToken', '[REDACTED]']]],
    });
    expect(() => assertNoSensitiveData(report)).toThrow(/sensitive/i);
    expect(() => assertNoSensitiveData(redactForExport(report))).not.toThrow();
  });

  it.each([
    ['string', 'plaintext-secret'],
    ['array', ['a'.repeat(64)]],
    ['null', null],
    ['non-plain object', new Date(0)],
    ['inherited key', Object.create({ passwordHint: 'teacher' })],
    ['symbol key', { [Symbol('passwordHint')]: 'teacher' }],
    ['extra key', { recoveryCodeHash: 'a'.repeat(64), passwordHint: 'teacher' }],
    ['nested hash value', { adminPasswordHash: { value: 'a'.repeat(64) } }],
    ['malformed hash', { adminPasswordHash: `scrypt$16384$8$1$${'a'.repeat(32)}$short` }],
    ['plaintext value', { recoveryCodeHash: 'recovery-code' }],
    ['unbounded value', { adminPasswordHash: 'a'.repeat(10_000) }],
  ])('fails closed for invalid credentialHashes %s values', (_label, credentialHashes) => {
    const artifact = { credentialHashes };

    expect(() => assertNoSensitiveData(artifact)).toThrow(/sensitive/i);
    expect(redactForExport(artifact)).toEqual({ credentialHashes: '[REDACTED]' });
  });

  it('preserves exact supported credentialHashes objects while traversing ordinary nested fields', () => {
    const adminPasswordHash = `scrypt$16384$8$1$${'a'.repeat(32)}$${'b'.repeat(64)}`;
    const artifact = {
      nested: {
        credentialHashes: { adminPasswordHash, recoveryCodeHash: 'c'.repeat(64) },
        report: { status: 'ok' },
      },
    };

    expect(() => assertNoSensitiveData(artifact)).not.toThrow();
    expect(redactForExport(artifact)).toEqual(artifact);
  });

  it('accepts the exact empty credentialHashes object emitted for a workbook without supported hashes', () => {
    const redacted = redactWorkbook({
      Settings: [['key', 'value'], ['schemaVersion', '3'], ['adminPassword', 'plaintext']],
      Students: [['studentId'], ['S1']],
    });
    const artifact = { credentialHashes: redacted.credentialHashes, tabs: redacted.tabs };

    expect(redacted.credentialHashes).toEqual({});
    expect(() => assertNoSensitiveData(artifact)).not.toThrow();
    expect(redactForExport(artifact)).toEqual(artifact);
  });
});
