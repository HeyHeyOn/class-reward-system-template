import { describe, expect, it, vi } from 'vitest';
import {
  createSignedStudentQr,
  parseStudentQrCode,
  resolveStudentQr,
  StudentQrConfigurationError,
  studentQrCodeValue,
  StudentQrValidationError,
  type StudentQrLookup,
} from '@/server/studentQr';

vi.mock('server-only', () => ({}));

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const keyOne = Buffer.alloc(32, 1).toString('base64url');
const keyTwo = Buffer.alloc(32, 2).toString('base64url');
const env = {
  STUDENT_QR_ACTIVE_KEY_ID: 'k1',
  STUDENT_QR_SIGNING_KEYS: JSON.stringify({ k1: keyOne, k0: keyTwo }),
};
/** The class has S001 with code 0123456789AB; signed cards still work unless listed in `retired`. */
const lookupWith = (retired: string[] = []): StudentQrLookup => ({
  studentIdForCode: async (code) => (code === '0123456789AB' ? 'S001' : null),
  signedQrAccepted: async (studentId) => !retired.includes(studentId),
});
const lookup = lookupWith();

describe('signed tenant student QR', () => {
  it('round-trips a compact signed student QR inside its trusted tenant', async () => {
    const token = createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, env);

    expect(token).toMatch(/^csq1\.k1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain(tenantA);
    expect(token).not.toContain('S001');
    await expect(resolveStudentQr(token, tenantA, lookup, env)).resolves.toEqual({ studentId: 'S001', format: 'SIGNED' });
  });

  it('rejects a signed QR in another trusted tenant without exposing its tenant', async () => {
    const token = createSignedStudentQr({ tenantId: tenantA, studentId: 'SAME-ID' }, env);

    await expect(resolveStudentQr(token, tenantB, lookup, env)).rejects.toThrow(StudentQrValidationError);
    await expect(resolveStudentQr(token, tenantB, lookup, env)).rejects.toThrow('Student QR is invalid.');
  });

  it.each([
    ['payload', (token: string) => token.replace(/(csq1\.k1\.)(.)/, (_all, prefix, first) => `${prefix}${first === 'A' ? 'B' : 'A'}`)],
    ['signature', (token: string) => `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`],
    ['version', (token: string) => token.replace(/^csq1/, 'csq2')],
    ['key id', (token: string) => token.replace('.k1.', '.unknown.')],
  ])('rejects %s tampering', async (_name, tamper) => {
    const token = createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, env);
    await expect(resolveStudentQr(tamper(token), tenantA, lookup, env)).rejects.toThrow('Student QR is invalid.');
  });

  it.each([
    '', 'csq1', 'csq1.k1.bad.bad', 'csq1.k1.%FF.signature',
    `csq1.k1.${'A'.repeat(500)}.${'A'.repeat(43)}`,
    'csq1.k1.8J-SqQ.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ])('rejects malformed or non-canonical signed input', async (value) => {
    await expect(resolveStudentQr(value, tenantA, lookup, env)).rejects.toThrow('Student QR is invalid.');
  });

  it('requires strict server-only signing configuration', () => {
    expect(() => createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, {}))
      .toThrow(StudentQrConfigurationError);
    expect(() => createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, {
      STUDENT_QR_ACTIVE_KEY_ID: 'k1', STUDENT_QR_SIGNING_KEYS: JSON.stringify({ k1: 'short' }),
    })).toThrow(StudentQrConfigurationError);
  });

  it('supports safe verification-key rotation and signs only with the active key', async () => {
    const oldEnv = { STUDENT_QR_ACTIVE_KEY_ID: 'k0', STUDENT_QR_SIGNING_KEYS: env.STUDENT_QR_SIGNING_KEYS };
    const oldToken = createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, oldEnv);
    const newToken = createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, env);

    await expect(resolveStudentQr(oldToken, tenantA, lookup, env)).resolves.toMatchObject({ studentId: 'S001' });
    expect(newToken.startsWith('csq1.k1.')).toBe(true);
    await expect(resolveStudentQr(oldToken, tenantA, lookup, {
      STUDENT_QR_ACTIVE_KEY_ID: 'k1', STUDENT_QR_SIGNING_KEYS: JSON.stringify({ k1: keyOne }),
    })).rejects.toThrow('Student QR is invalid.');
  });
});

describe('tenant-scoped legacy student QR compatibility', () => {
  it('accepts a bounded legacy value only after trusted tenant selection', async () => {
    await expect(resolveStudentQr(' S001 ', tenantA, lookup, env)).resolves.toEqual({ studentId: 'S001', format: 'LEGACY' });
    await expect(resolveStudentQr('S001', undefined, lookup, env)).rejects.toThrow('Student QR is invalid.');
  });

  it.each(['csq1.not-a-token', 'a'.repeat(129), 'line\nbreak', '\ud800'])('fails closed for unsafe legacy input', async (value) => {
    await expect(resolveStudentQr(value, tenantA, lookup, env)).rejects.toThrow('Student QR is invalid.');
  });

  it('reads pasted configuration forms as the same keys', async () => {
    const canonical = createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, env);
    const standardBase64 = Buffer.alloc(32, 1).toString('base64');
    for (const variant of [
      { STUDENT_QR_ACTIVE_KEY_ID: ' k1\n', STUDENT_QR_SIGNING_KEYS: `  ${env.STUDENT_QR_SIGNING_KEYS}\n` },
      { STUDENT_QR_ACTIVE_KEY_ID: '"k1"', STUDENT_QR_SIGNING_KEYS: `'${env.STUDENT_QR_SIGNING_KEYS}'` },
      { STUDENT_QR_ACTIVE_KEY_ID: 'k1', STUDENT_QR_SIGNING_KEYS: JSON.stringify(env.STUDENT_QR_SIGNING_KEYS) },
      { STUDENT_QR_ACTIVE_KEY_ID: 'k1', STUDENT_QR_SIGNING_KEYS: JSON.stringify({ k1: standardBase64, k0: keyTwo }) },
    ]) {
      expect(createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, variant)).toBe(canonical);
      await expect(resolveStudentQr(canonical, tenantA, lookup, variant)).resolves.toEqual({ studentId: 'S001', format: 'SIGNED' });
    }
  });

  it('names the failed configuration check without exposing key material', () => {
    const problem = (variant: Record<string, string | undefined>) => {
      try { createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, variant); return 'OK'; }
      catch (error) { expect(error).toBeInstanceOf(StudentQrConfigurationError); return (error as StudentQrConfigurationError).problem; }
    };
    expect(problem({ STUDENT_QR_SIGNING_KEYS: env.STUDENT_QR_SIGNING_KEYS })).toBe('ACTIVE_KEY_ID');
    expect(problem({ STUDENT_QR_ACTIVE_KEY_ID: 'k1' })).toBe('KEYS_MISSING');
    expect(problem({ STUDENT_QR_ACTIVE_KEY_ID: 'k1', STUDENT_QR_SIGNING_KEYS: '{not json' })).toBe('KEYS_JSON');
    expect(problem({ STUDENT_QR_ACTIVE_KEY_ID: 'k1', STUDENT_QR_SIGNING_KEYS: JSON.stringify({ k1: 'short' }) })).toBe('KEY_FORMAT');
    expect(problem({ STUDENT_QR_ACTIVE_KEY_ID: 'k9', STUDENT_QR_SIGNING_KEYS: env.STUDENT_QR_SIGNING_KEYS })).toBe('ACTIVE_KEY_MISSING');
    const message = (() => { try { createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, { STUDENT_QR_ACTIVE_KEY_ID: 'k1', STUDENT_QR_SIGNING_KEYS: JSON.stringify({ k1: 'short' }) }); return ''; } catch (error) { return String((error as Error).message); } })();
    expect(message).not.toContain('short');
  });
});

describe('short student QR codes', () => {
  it('reads the printed value in any letter case and nothing else', () => {
    expect(studentQrCodeValue('0123456789AB')).toBe('DS1:0123456789AB');
    expect(parseStudentQrCode(' ds1:0123456789ab ')).toBe('0123456789AB');
    for (const value of ['DS1:0123456789A', 'DS1:0123456789ABC', 'DS1:0123456789AG', 'DS2:0123456789AB', 'S001', '0123456789AB']) {
      expect(parseStudentQrCode(value)).toBeNull();
    }
  });

  it('finds the student who has the code, in the trusted class only', async () => {
    await expect(resolveStudentQr('DS1:0123456789AB', tenantA, lookup, env)).resolves.toEqual({ studentId: 'S001', format: 'CODE' });
    await expect(resolveStudentQr('ds1:0123456789ab', tenantA, lookup, env)).resolves.toEqual({ studentId: 'S001', format: 'CODE' });
    await expect(resolveStudentQr('DS1:FFFFFFFFFFFF', tenantA, lookup, env)).rejects.toThrow(StudentQrValidationError);
    await expect(resolveStudentQr('DS1:0123456789AB', undefined, lookup, env)).rejects.toThrow(StudentQrValidationError);
  });

  it('never reads a malformed code as a student ID', async () => {
    await expect(resolveStudentQr('DS1:0123', tenantA, lookup, env)).rejects.toThrow(StudentQrValidationError);
    await expect(resolveStudentQr('ds9:anything', tenantA, lookup, env)).rejects.toThrow(StudentQrValidationError);
  });

  it('refuses a signed card once the teacher issued the student a new code', async () => {
    const token = createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, env);
    await expect(resolveStudentQr(token, tenantA, lookupWith(['S002']), env)).resolves.toEqual({ studentId: 'S001', format: 'SIGNED' });
    await expect(resolveStudentQr(token, tenantA, lookupWith(['S001']), env)).rejects.toThrow(StudentQrValidationError);
  });
});
