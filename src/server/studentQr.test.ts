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
});
