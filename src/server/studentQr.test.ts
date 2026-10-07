import { describe, expect, it } from 'vitest';
import {
  createSignedStudentQr,
  resolveStudentQr,
  StudentQrConfigurationError,
  StudentQrValidationError,
} from '@/server/studentQr';

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const keyOne = Buffer.alloc(32, 1).toString('base64url');
const keyTwo = Buffer.alloc(32, 2).toString('base64url');
const env = {
  STUDENT_QR_ACTIVE_KEY_ID: 'k1',
  STUDENT_QR_SIGNING_KEYS: JSON.stringify({ k1: keyOne, k0: keyTwo }),
};

describe('signed tenant student QR', () => {
  it('round-trips a compact signed student QR inside its trusted tenant', () => {
    const token = createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, env);

    expect(token).toMatch(/^csq1\.k1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain(tenantA);
    expect(token).not.toContain('S001');
    expect(resolveStudentQr(token, tenantA, env)).toEqual({ studentId: 'S001', format: 'SIGNED' });
  });

  it('rejects a signed QR in another trusted tenant without exposing its tenant', () => {
    const token = createSignedStudentQr({ tenantId: tenantA, studentId: 'SAME-ID' }, env);

    expect(() => resolveStudentQr(token, tenantB, env)).toThrow(StudentQrValidationError);
    expect(() => resolveStudentQr(token, tenantB, env)).toThrow('Student QR is invalid.');
  });

  it.each([
    ['payload', (token: string) => token.replace(/(csq1\.k1\.)(.)/, (_all, prefix, first) => `${prefix}${first === 'A' ? 'B' : 'A'}`)],
    ['signature', (token: string) => `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`],
    ['version', (token: string) => token.replace(/^csq1/, 'csq2')],
    ['key id', (token: string) => token.replace('.k1.', '.unknown.')],
  ])('rejects %s tampering', (_name, tamper) => {
    const token = createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, env);
    expect(() => resolveStudentQr(tamper(token), tenantA, env)).toThrow('Student QR is invalid.');
  });

  it.each([
    '', 'csq1', 'csq1.k1.bad.bad', 'csq1.k1.%FF.signature',
    `csq1.k1.${'A'.repeat(500)}.${'A'.repeat(43)}`,
    'csq1.k1.8J-SqQ.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ])('rejects malformed or non-canonical signed input', (value) => {
    expect(() => resolveStudentQr(value, tenantA, env)).toThrow('Student QR is invalid.');
  });

  it('requires strict server-only signing configuration', () => {
    expect(() => createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, {}))
      .toThrow(StudentQrConfigurationError);
    expect(() => createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, {
      STUDENT_QR_ACTIVE_KEY_ID: 'k1', STUDENT_QR_SIGNING_KEYS: JSON.stringify({ k1: 'short' }),
    })).toThrow(StudentQrConfigurationError);
  });

  it('supports safe verification-key rotation and signs only with the active key', () => {
    const oldEnv = { STUDENT_QR_ACTIVE_KEY_ID: 'k0', STUDENT_QR_SIGNING_KEYS: env.STUDENT_QR_SIGNING_KEYS };
    const oldToken = createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, oldEnv);
    const newToken = createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, env);

    expect(resolveStudentQr(oldToken, tenantA, env)).toMatchObject({ studentId: 'S001' });
    expect(newToken.startsWith('csq1.k1.')).toBe(true);
    expect(() => resolveStudentQr(oldToken, tenantA, {
      STUDENT_QR_ACTIVE_KEY_ID: 'k1', STUDENT_QR_SIGNING_KEYS: JSON.stringify({ k1: keyOne }),
    })).toThrow('Student QR is invalid.');
  });
});

describe('tenant-scoped legacy student QR compatibility', () => {
  it('accepts a bounded legacy value only after trusted tenant selection', () => {
    expect(resolveStudentQr(' S001 ', tenantA, env)).toEqual({ studentId: 'S001', format: 'LEGACY' });
    expect(() => resolveStudentQr('S001', undefined, env)).toThrow('Student QR is invalid.');
  });

  it.each(['csq1.not-a-token', 'a'.repeat(129), 'line\nbreak', '\ud800'])('fails closed for unsafe legacy input', (value) => {
    expect(() => resolveStudentQr(value, tenantA, env)).toThrow('Student QR is invalid.');
  });

  it('reads pasted configuration forms as the same keys', () => {
    const canonical = createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, env);
    const standardBase64 = Buffer.alloc(32, 1).toString('base64');
    for (const variant of [
      { STUDENT_QR_ACTIVE_KEY_ID: ' k1\n', STUDENT_QR_SIGNING_KEYS: `  ${env.STUDENT_QR_SIGNING_KEYS}\n` },
      { STUDENT_QR_ACTIVE_KEY_ID: '"k1"', STUDENT_QR_SIGNING_KEYS: `'${env.STUDENT_QR_SIGNING_KEYS}'` },
      { STUDENT_QR_ACTIVE_KEY_ID: 'k1', STUDENT_QR_SIGNING_KEYS: JSON.stringify(env.STUDENT_QR_SIGNING_KEYS) },
      { STUDENT_QR_ACTIVE_KEY_ID: 'k1', STUDENT_QR_SIGNING_KEYS: JSON.stringify({ k1: standardBase64, k0: keyTwo }) },
    ]) {
      expect(createSignedStudentQr({ tenantId: tenantA, studentId: 'S001' }, variant)).toBe(canonical);
      expect(resolveStudentQr(canonical, tenantA, variant)).toEqual({ studentId: 'S001', format: 'SIGNED' });
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
