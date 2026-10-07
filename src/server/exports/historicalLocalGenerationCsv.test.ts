// @vitest-environment node
import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { QueryConfig } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedLocalGenerationReadResult } from './readPersistedLocalGeneration';
import { buildHistoricalLocalGenerationCsv } from './historicalLocalGenerationCsv';

// No actual pg implementation/SQL engine, sockets, SDK, test harness or Docker.
// The Google cookie verifier, tenant resolver/authorizer and reader are REAL.
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ connect: vi.fn(), pool: vi.fn(), on: vi.fn(), network: vi.fn(() => {
  throw new Error('Network forbidden in synthetic composition');
}) }));
vi.mock('pg', () => ({ Pool: class {
  constructor(options: unknown) { mocks.pool(options); }
  connect = mocks.connect;
  on = mocks.on;
}, types: { getTypeParser: () => (value: string) => value } }));
vi.mock('googleapis', () => ({ google: { auth: { OAuth2: mocks.network }, oauth2: mocks.network } }));
import { readPersistedLocalGeneration } from './readPersistedLocalGeneration';

type HistoricalDto = Extract<PersistedLocalGenerationReadResult, { kind: 'HISTORICAL_LOCAL_GENERATION' }>;
const GENERATION = `preparation:candidate:${'a'.repeat(64)}`;
const PLAN = `preparation:plan:${'b'.repeat(64)}`;
const dto = (): HistoricalDto => ({
  kind: 'HISTORICAL_LOCAL_GENERATION', authority: 'NONAUTHORITY', readOnly: true,
  scope: 'HISTORICAL_ONLY', phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN', originalSnapshotPhase: 'PREFLIGHT',
  verification: 'PERSISTED_BINDING_ONLY', payloadIntegrity: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED',
  currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false, activationAllowed: false,
  jobId: '과거/작업😀:%ZZ', generationId: GENERATION, originalSourceId: 'source:synthetic',
  originalSnapshotId: 'snapshot:synthetic', candidateManifestDigest: 'c'.repeat(64),
  candidateSheetDigest: 'd'.repeat(64), recordedStateVersion: '7',
});
const COLUMNS = ['schemaVersion', 'purpose', 'kind', 'authority', 'readOnly', 'scope', 'phase', 'exclusion',
  'originalSnapshotPhase', 'verification', 'payloadIntegrity', 'currentFreshness', 'currentPreflight',
  'operationalAuthority', 'cutoverAllowed', 'activationAllowed', 'jobId', 'generationId', 'originalSourceId',
  'originalSnapshotId', 'candidateManifestDigest', 'candidateSheetDigest', 'recordedStateVersion'];
const GOLDEN = '"schemaVersion","purpose","kind","authority","readOnly","scope","phase","exclusion","originalSnapshotPhase","verification","payloadIntegrity","currentFreshness","currentPreflight","operationalAuthority","cutoverAllowed","activationAllowed","jobId","generationId","originalSourceId","originalSnapshotId","candidateManifestDigest","candidateSheetDigest","recordedStateVersion"\r\n'
  + `"'historical-local-generation-metadata-display/v1","'DISPLAY_ONLY","'HISTORICAL_LOCAL_GENERATION","'NONAUTHORITY","'true","'HISTORICAL_ONLY","'LOCAL_CANDIDATE","'NOT_PROVEN","'PREFLIGHT","'PERSISTED_BINDING_ONLY","'NOT_VERIFIED","'NOT_VERIFIED","'NOT_EVALUATED","'UNKNOWN","'false","'false","'과거/작업😀:%ZZ","'preparation:candidate:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","'source:synthetic","'snapshot:synthetic","'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","'7"\r\n`;
const ERROR = 'Invalid historical local generation metadata display CSV input';
const opaqueKeys = ['jobId', 'originalSourceId', 'originalSnapshotId'] as const;

// Independent CSV state machine: not a production decoder or split-on-comma oracle.
function parse(bytes: Uint8Array): string[][] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const rows: string[][] = [];
  let row: string[] = [];
  let index = 0;
  while (index < text.length) {
    expect(text[index++]).toBe('"');
    let cell = '';
    let closed = false;
    while (index < text.length) {
      const char = text[index++];
      if (char !== '"') { cell += char; continue; }
      if (text[index] === '"') { cell += '"'; index++; continue; }
      closed = true;
      break;
    }
    expect(closed).toBe(true);
    row.push(cell);
    if (text[index] === ',') { index++; continue; }
    expect(text.slice(index, index + 2)).toBe('\r\n');
    index += 2; rows.push(row); row = [];
  }
  expect(row).toEqual([]);
  return rows;
}
function cells(input: unknown) {
  const [header, row] = parse(buildHistoricalLocalGenerationCsv(input).bytes);
  return Object.fromEntries(header.map((key, i) => [key, row[i]]));
}
function refuses(input: unknown) {
  expect(() => buildHistoricalLocalGenerationCsv(input)).toThrow(new TypeError(ERROR));
}

beforeEach(() => {
  mocks.network.mockClear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(mocks.network);
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(mocks.network).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

describe('pure historical LOCAL_CANDIDATE metadata DISPLAY bytes, not a source export', () => {
  it('matches literal UTF-8 golden bytes, fixed 23 columns, one metadata row, no BOM and final CRLF', () => {
    const result = buildHistoricalLocalGenerationCsv(dto());
    expect(Object.keys(result).sort()).toEqual([
      'format', 'schemaVersion', 'purpose', 'contentType', 'metadataRowCount', 'bytes', 'byteLength', 'sha256',
    ].sort());
    expect(result).toMatchObject({ format: 'CSV', schemaVersion: 'historical-local-generation-metadata-display/v1',
      purpose: 'DISPLAY_ONLY', contentType: 'text/csv; charset=utf-8; header=present', metadataRowCount: 1 });
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result.bytes)).toEqual(Buffer.from(GOLDEN, 'utf8'));
    expect([...result.bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(parse(result.bytes)).toHaveLength(2);
    expect(parse(result.bytes)[0]).toEqual(COLUMNS);
    expect(parse(result.bytes)[1]).toHaveLength(23);
    expect(parse(result.bytes)[1].every(cell => cell.startsWith("'"))).toBe(true);
    expect(result.byteLength).toBe(Buffer.byteLength(GOLDEN, 'utf8'));
    expect(result.sha256).toBe(createHash('sha256').update(Buffer.from(GOLDEN, 'utf8')).digest('hex'));
    expect(result.sha256).not.toBe(dto().candidateManifestDigest);
  });

  it('keeps ALL historical/nonauthority warnings inside CSV and invents no authority/completeness', () => {
    const result = cells(dto());
    for (const [key, value] of Object.entries(dto())) expect(result[key]).toBe(`'${value}`);
    expect(result.operationalAuthority).toBe("'UNKNOWN");
    expect(result.cutoverAllowed).toBe("'false");
    expect(result.activationAllowed).toBe("'false");
    for (const key of ['tenantId', 'complete', 'rowCount', 'createdAt', 'retention', 'exportId', 'status']) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it('is deterministic across property order/null prototypes/frozen input and returns unshared exact-size bytes', () => {
    const input = Object.freeze(dto());
    const before = JSON.stringify(input);
    const first = buildHistoricalLocalGenerationCsv(input);
    const reversed = Object.assign(Object.create(null), Object.fromEntries(Object.entries(input).reverse()));
    const second = buildHistoricalLocalGenerationCsv(reversed);
    expect(second).toEqual(first);
    expect(first.bytes).not.toBe(second.bytes);
    expect(first.bytes.buffer).not.toBe(second.bytes.buffer);
    expect(first.bytes.byteOffset).toBe(0);
    expect(first.bytes.buffer.byteLength).toBe(first.byteLength);
    first.bytes.fill(0);
    expect(Buffer.from(second.bytes).toString('utf8')).toBe(GOLDEN);
    expect(buildHistoricalLocalGenerationCsv(input)).toEqual(second);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(opaqueKeys)('quotes and text-prefixes each opaque %s without Unicode/URL/numeric normalization', key => {
    for (const value of ['=1+1', '+SUM(A1)', '-1', '@SUM(A1)', "'literal", '0000123', '1e100', '2026-09-26',
      'a,"b",c', '한글😀/내부 공백:%ZZ/../%20', 'e\u0301', 'é', '＝1+1', 'x\u00a0y']) {
      const input = { ...dto(), [key]: value };
      expect(cells(input)[key]).toBe(`'${value}`);
      expect(parse(buildHistoricalLocalGenerationCsv(input).bytes)[1]).toHaveLength(23);
    }
    expect(Buffer.from(buildHistoricalLocalGenerationCsv({ ...dto(), [key]: 'a,"b",c' }).bytes).toString('utf8'))
      .toContain(`"'a,""b"",c"`);
  });

  it.each(opaqueKeys)('applies reader UTF-8 byte limits to %s, not merely JS string length', key => {
    for (const value of ['x'.repeat(1024), '한'.repeat(341) + 'x', '😀'.repeat(256), '"'.repeat(1024)]) {
      expect(Buffer.byteLength(value)).toBe(1024);
      expect(cells({ ...dto(), [key]: value })[key]).toBe(`'${value}`);
    }
    for (const value of ['x'.repeat(1025), '한'.repeat(342), '😀'.repeat(256) + 'x', 'x'.repeat(100_000)]) {
      refuses({ ...dto(), [key]: value });
    }
  });

  it.each(opaqueKeys)('refuses invalid %s without trimming, escaping controls into acceptance, or coercion', key => {
    for (const value of ['', ' ', ' x', 'x ', '\t=1', 'x\n', 'a\rb', 'a\tb', 'a\0b', 'a\u007fb', 'a\u0085b',
      'a\u200bb', 'a\u202eb', 'a\u2028b', 'a\u2029b', '\ufeffx', '\uD800', '\uDC00', 'a\uD800b',
      undefined, null, 7, new String('x'), { toString: () => 'x' }]) refuses({ ...dto(), [key]: value });
  });

  it('bounds the fully escaped quote-heavy maximum, with hash over exact returned bytes', () => {
    const input = { ...dto(), jobId: '"'.repeat(1024), originalSourceId: '"'.repeat(1024),
      originalSnapshotId: '"'.repeat(1024), recordedStateVersion: '9007199254740991' };
    const result = buildHistoricalLocalGenerationCsv(input);
    expect(result.byteLength).toBe(7070);
    expect(result.byteLength).toBeLessThanOrEqual(16384);
    expect(result.byteLength).toBe(result.bytes.length);
    expect(result.sha256).toBe(createHash('sha256').update(result.bytes).digest('hex'));
    expect(cells(input).jobId).toBe(`'${input.jobId}`);
    // No valid DTO reaches 16384; this is NOT an invented cap/cap+1 acceptance test.
  });

  it.each(['generationId', 'candidateManifestDigest', 'candidateSheetDigest'] as const)('enforces exact lower-hex %s', key => {
    const valid = dto()[key];
    for (const value of ['', valid.toUpperCase(), valid + 'a', valid.slice(1), valid + '\n', valid + '\r\n',
      ' ' + valid, valid.replace(/a|c|d/, 'g'), 1, null]) refuses({ ...dto(), [key]: value });
    refuses({ ...dto(), generationId: PLAN });
    // The reader does not require generation suffix == manifest digest.
    expect(cells(dto())[key]).toBe(`'${valid}`);
  });

  it('preserves canonical recorded versions as protected text and rejects unsafe/cast values', () => {
    for (const value of ['1', '9007199254740991']) expect(cells({ ...dto(), recordedStateVersion: value }).recordedStateVersion).toBe(`'${value}`);
    for (const value of ['0', '07', '-1', '+1', '1.0', '1e3', ' 1', '1 ', '1\n', '9007199254740992',
      '9'.repeat(100), '', null, undefined, 7, BigInt(7)]) refuses({ ...dto(), recordedStateVersion: value });
  });

  it.each(['UNAUTHENTICATED', 'FORBIDDEN', 'INVALID_REQUEST', 'NOT_FOUND', 'UNAVAILABLE'])('never makes empty/partial CSV for reader %s', kind => {
    refuses({ kind }); refuses({ ...dto(), kind });
  });

  it('rejects every changed literal flag, missing field, unrelated DTO and raw DB row', () => {
    const input = dto();
    for (const key of Object.keys(input)) {
      const missing: Record<string, unknown> = { ...input }; delete missing[key]; refuses(missing);
    }
    for (const key of COLUMNS.slice(2, 16)) {
      refuses({ ...input, [key]: 'ACTIVE' }); refuses({ ...input, [key]: null });
    }
    refuses({ ...input, readOnly: false }); refuses({ ...input, cutoverAllowed: true });
    refuses({ ...input, activationAllowed: true });
    for (const other of [null, undefined, [], '', 7, true, new Date(), { rows: [] },
      { kind: 'MATCHED', complete: true }, { kind: 'STRUCTURE_ONLY' }, { generation_id: GENERATION, phase: 'LOCAL_CANDIDATE' }]) refuses(other);
  });

  it.each(['tenantId', 'studentName', 'studentId', 'qrToken', 'balance', 'claims', 'cookie', 'refreshToken',
    'credentialHash', 'sourceUrl', 'sheetId', 'canonical_record', 'redacted_details', 'diagnostics', 'complete',
    'rowCount', 'createdAt', 'exportId', 'retention'])('does not admit sensitive/unsupported extra %s', key => {
    refuses({ ...dto(), [key]: 'synthetic-private-canary' });
    refuses(Object.defineProperty(dto(), key, { value: 'hidden-private-canary', enumerable: false }));
  });

  it('rejects active objects/hidden/symbol/inherited fields without getter, Proxy or coercion calls or logs', () => {
    const trap = vi.fn(() => { throw new Error('private-value-must-not-escape'); });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const accessor = Object.defineProperty(dto(), 'jobId', { enumerable: true, get: trap });
    const revoked = Proxy.revocable(dto(), {}); revoked.revoke();
    const proxy = new Proxy(dto(), { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    for (const input of [accessor, proxy, revoked.proxy, Object.create(dto()), Object.assign(Object.create({ inherited: true }), dto()),
      Object.defineProperty(dto(), 'jobId', { enumerable: false }), { ...dto(), [Symbol('private')]: 'canary' },
      { ...dto(), toJSON: trap }, { ...dto(), toString: trap }, { ...dto(), jobId: { toString: trap, [Symbol.toPrimitive]: trap } }]) refuses(input);
    expect(trap).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });

  it('does not claim DLP or provenance: a self-consistent forged DTO/secret-like allowed ID is still only display text', () => {
    expect(cells({ ...dto(), jobId: 'synthetic-secret-in-an-allowed-id' }).jobId).toBe("'synthetic-secret-in-an-allowed-id");
    expect(cells({ ...dto(), candidateManifestDigest: 'e'.repeat(64) }).payloadIntegrity).toBe("'NOT_VERIFIED");
  });

  it('keeps runtime dependencies pure, with a type-only reference to the actual closed reader result', () => {
    const source = readFileSync(new URL('./historicalLocalGenerationCsv.ts', import.meta.url), 'utf8');
    const imports = source.split('\n').filter(line => line.startsWith('import '));
    expect(imports.filter(line => !line.startsWith('import type '))).toEqual([
      "import { Buffer } from 'node:buffer';", "import { createHash } from 'node:crypto';", "import { types } from 'node:util';",
    ]);
    expect(imports).toContain("import type { PersistedLocalGenerationReadResult } from './readPersistedLocalGeneration';");
    expect(source).not.toMatch(/\b(?:process\.|fetch\(|Date\.|Math\.random|require\(|import\(|console\.)/);
  });
});

// This is test-local composition, NOT a new production adapter, URL or HTTP contract.
// All SQL responses below are inert scalar fixtures; no actual SQL/RLS/roles are exercised.
type Row = Record<string, unknown>;
type Reply = { rows: Row[]; fields: { name: string; dataTypeID: number; format: string }[] };
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUBJECT = 'synthetic-subject-canary';
const SECRET = 'public-synthetic-metadata-composition-secret';
const NOW = Date.parse('2026-09-26T00:00:00.000Z');
const SECURITY_FIELDS: [string, number][] = [['runtime_safe', 16]];
const TENANT_FIELDS: [string, number][] = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: [string, number][] = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const GENERATION_FIELDS: [string, number][] = [
  ['found', 16], ['binding_valid', 16], ['tenant_id', 2950], ['job_id', 25], ['generation_id', 25],
  ['original_source_id', 25], ['original_snapshot_id', 25], ['candidate_event_id', 25], ['plan_event_id', 25],
  ['candidate_manifest_digest', 25], ['candidate_sheet_digest', 25], ['recorded_state_version', 25],
  ['phase', 25], ['exclusion', 25], ['original_snapshot_phase', 25],
];
const reply = (rows: Row[], fields: [string, number][]): Reply => ({ rows,
  fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID, format: 'text' })) });
function cookie(issuedAt = Date.now(), subject = SUBJECT) {
  const iv = Buffer.alloc(12, 3); // Deterministic IV for SYNTHETIC test cookies only.
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ subject, email: 'synthetic@example.test', issuedAt })), cipher.final()]);
  return `class_store_google_auth=v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
const request = (value = cookie(), signal?: AbortSignal) => new Request('https://example.test/internal', {
  headers: { cookie: value, 'x-tenant-id': OTHER, 'x-role': 'OWNER' }, signal,
});
const selection = () => ({ jobId: dto().jobId, generationId: GENERATION });
const isGeneration = (config: QueryConfig) => config.text.includes('public.migration_final_generations');
const isSecurity = (config: QueryConfig) => config.text.includes('pg_catalog.pg_roles');

// Do NOT turn errors into empty files or invoke the serializer for any refusal.
async function compose(req: Request, serialize: typeof buildHistoricalLocalGenerationCsv, slug = 'alpha') {
  const result = await readPersistedLocalGeneration(slug, req, selection());
  return result.kind === 'HISTORICAL_LOCAL_GENERATION' ? serialize(result) : result;
}

describe('actual reader -> closed DTO -> serializer (synthetic transport only)', () => {
  let configs: QueryConfig[];
  let directory: Row;
  let membership: Row;
  let generation: Reply;
  let security: Reply;
  let hook: ((config: QueryConfig) => void) | undefined;
  let client: EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.stubEnv('AUTH_SECRET', SECRET);
    vi.stubEnv('DATABASE_URL', 'postgresql://synthetic.invalid/fixture');
    vi.stubEnv('DIRECT_DATABASE_URL', 'must-not-use');
    directory = { id: TENANT, slug: 'alpha', display_name: 'Synthetic', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
    membership = { id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role: 'OWNER' };
    generation = reply([{ found: true, binding_valid: true, tenant_id: TENANT, job_id: dto().jobId,
      generation_id: GENERATION, original_source_id: dto().originalSourceId, original_snapshot_id: dto().originalSnapshotId,
      candidate_event_id: GENERATION, plan_event_id: PLAN, candidate_manifest_digest: dto().candidateManifestDigest,
      candidate_sheet_digest: dto().candidateSheetDigest, recorded_state_version: '7', phase: 'LOCAL_CANDIDATE',
      exclusion: 'NOT_PROVEN', original_snapshot_phase: 'PREFLIGHT' }], GENERATION_FIELDS);
    security = reply([{ runtime_safe: true }], SECURITY_FIELDS); // Mocked, NOT runtime grant/RLS proof.
    configs = []; hook = undefined;
    client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (config: QueryConfig): Promise<Reply> => {
        configs.push(config); hook?.(config);
        if (isSecurity(config)) return security;
        if (isGeneration(config)) return generation;
        if (config.text.includes('public.platform_find_membership')) return reply([membership], MEMBER_FIELDS);
        if (config.text.includes('public.platform_find_tenant')) return reply([directory], TENANT_FIELDS);
        return reply([], []);
      }), release: vi.fn(), end: vi.fn(async () => {}),
    });
    mocks.connect.mockReset().mockResolvedValue(client);
  });

  it.each(['OWNER', 'ADMIN'])('publishes only the real successful DTO after cleanup as %s', async role => {
    membership.role = role;
    const serialize = vi.fn((value: unknown) => {
      expect(client.release).toHaveBeenCalledExactlyOnceWith();
      expect(configs.at(-1)?.text).toBe('ROLLBACK');
      return buildHistoricalLocalGenerationCsv(value);
    });
    const output = await compose(request(), serialize);
    expect(serialize).toHaveBeenCalledExactlyOnceWith(dto());
    expect(output).toEqual(buildHistoricalLocalGenerationCsv(dto()));
    expect(mocks.pool).toHaveBeenCalledWith(expect.objectContaining({ connectionString: 'postgresql://synthetic.invalid/fixture' }));
    expect(configs.find(isGeneration)?.values).toEqual([TENANT, SUBJECT, dto().jobId, MEMBER, USER, 'alpha', GENERATION]);
    expect(configs[0].text).toBe('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    expect(client.listenerCount('error')).toBe(0);
    const exposed = JSON.stringify(serialize.mock.calls) + JSON.stringify(output) +
      ('bytes' in output ? Buffer.from(output.bytes).toString('utf8') : '');
    for (const canary of [TENANT, OTHER, MEMBER, USER, SUBJECT, SECRET, cookie(), 'synthetic@example.test', 'must-not-use']) {
      expect(exposed).not.toContain(canary);
    }
    const sql = configs.map(config => config.text).join('\n');
    expect(sql).not.toMatch(/canonical_record|canonical_target|redacted_details|external_source_id|\b(?:GRANT|CREATE|ALTER|INSERT|DELETE|UPDATE|COMMIT)\b/i);
  });

  it.each(['', 'class_store_admin=fake; class_store_tenant_admin=fake', 'class_store_student=fake',
    'class_store_google_auth=bad', 'class_store_google_auth=%ZZ'])('rejects unauthenticated input before DB/serializer %#', async value => {
    const serialize = vi.fn(buildHistoricalLocalGenerationCsv);
    expect(await compose(request(value), serialize)).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(serialize).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('rejects duplicate/tampered/expired cookies using the real verifier', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const parts = cookie().split('.'); parts[2] = Buffer.alloc(16).toString('base64url');
    for (const value of [cookie() + '; ' + cookie(), parts.join('.'), cookie(NOW - 30 * 24 * 60 * 60 * 1000 - 1)]) {
      const serialize = vi.fn(buildHistoricalLocalGenerationCsv);
      expect(await compose(request(value), serialize)).toEqual({ kind: 'UNAUTHENTICATED' });
      expect(serialize).not.toHaveBeenCalled();
    }
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(['tenant', 'subject', 'member', 'user', 'VIEWER', 'STUDENT', 'slug', 'revoked'])('denies mismatched/revoked identity %s despite spoofed headers', async mode => {
    if (mode === 'tenant') membership.tenant_id = OTHER;
    if (mode === 'subject') membership.google_subject = 'other-subject';
    if (mode === 'member') membership.id = 'bad-member';
    if (mode === 'user') membership.user_id = 'bad-user';
    if (mode === 'VIEWER' || mode === 'STUDENT') membership.role = mode;
    if (mode === 'slug') directory.slug = 'beta';
    if (mode === 'revoked') generation.rows = []; // Final statement membership loss.
    const serialize = vi.fn(buildHistoricalLocalGenerationCsv);
    expect(await compose(request(), serialize)).toEqual({ kind: 'FORBIDDEN' });
    expect(serialize).not.toHaveBeenCalled();
  });

  it.each(['tenant_id', 'job_id', 'generation_id', 'binding_valid'])('refuses broken persisted %s instead of exporting a fallback', async key => {
    generation.rows[0][key] = key === 'binding_valid' ? false : 'wrong-binding';
    const serialize = vi.fn(buildHistoricalLocalGenerationCsv);
    expect(await compose(request(), serialize)).toEqual({ kind: 'UNAVAILABLE' });
    expect(serialize).not.toHaveBeenCalled();
  });

  it('preserves authorized NOT_FOUND and INVALID_REQUEST without CSV', async () => {
    generation.rows = [Object.fromEntries(GENERATION_FIELDS.map(([name]) => [name,
      name === 'found' || name === 'binding_valid' ? false : null]))];
    const serialize = vi.fn(buildHistoricalLocalGenerationCsv);
    expect(await compose(request(), serialize)).toEqual({ kind: 'NOT_FOUND' });
    const post = new Request(request(), { method: 'POST' });
    expect(await compose(post, serialize)).toEqual({ kind: 'INVALID_REQUEST' });
    expect(serialize).not.toHaveBeenCalled();
  });

  it.each(['unsafe', '42501', '42P01', '42883', 'rollback', 'release'])('publishes no bytes/raw error on %s failure', async mode => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (mode === 'unsafe') security.rows[0].runtime_safe = false;
    const fail = () => { throw Object.assign(new Error('synthetic-private-payload-canary postgresql://private'), { code: mode }); };
    if (mode === 'release') client.release.mockImplementation(fail);
    else if (mode !== 'unsafe') hook = config => {
      if (mode === 'rollback' ? config.text === 'ROLLBACK' : isGeneration(config)) fail();
    };
    const serialize = vi.fn(buildHistoricalLocalGenerationCsv);
    expect(await compose(request(), serialize)).toEqual({ kind: 'UNAVAILABLE' });
    expect(serialize).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
    if (mode === 'unsafe') expect(configs.some(isGeneration)).toBe(false);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it('does not reuse alpha success for beta or a later revoked membership', async () => {
    const serialize = vi.fn(buildHistoricalLocalGenerationCsv);
    expect(await compose(request(), serialize)).toEqual(buildHistoricalLocalGenerationCsv(dto()));
    expect(await compose(request(), serialize, 'beta')).toEqual({ kind: 'FORBIDDEN' });
    membership.role = 'VIEWER';
    expect(await compose(request(), serialize)).toEqual({ kind: 'FORBIDDEN' });
    expect(serialize).toHaveBeenCalledTimes(1); expect(mocks.connect).toHaveBeenCalledTimes(3);
  });

  it.each(['abort', 'cookie', 'expiry'])('does not serialize after reader detects %s drift', async mode => {
    const abort = new AbortController();
    let clock = NOW; vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const req = request(cookie(NOW), abort.signal);
    hook = config => {
      if (!isGeneration(config)) return;
      if (mode === 'abort') abort.abort();
      if (mode === 'cookie') req.headers.set('cookie', cookie(NOW, 'different-subject'));
      if (mode === 'expiry') clock = NOW + 30 * 24 * 60 * 60 * 1000 + 1;
    };
    const serialize = vi.fn(buildHistoricalLocalGenerationCsv);
    expect(await compose(req, serialize)).toEqual({ kind: mode === 'abort' ? 'UNAVAILABLE' : 'UNAUTHENTICATED' });
    expect(serialize).not.toHaveBeenCalled();
  });

  it('keeps timeout/late connection cleanup unavailable and never starts SQL or serialization', async () => {
    vi.useFakeTimers();
    let resolve!: (value: typeof client) => void;
    mocks.connect.mockReturnValue(new Promise<typeof client>(yes => { resolve = yes; }));
    const serialize = vi.fn(buildHistoricalLocalGenerationCsv);
    const result = compose(request(), serialize);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await result).toEqual({ kind: 'UNAVAILABLE' });
    resolve(client); await vi.advanceTimersByTimeAsync(0);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(configs).toEqual([]); expect(serialize).not.toHaveBeenCalled();
  });
});
