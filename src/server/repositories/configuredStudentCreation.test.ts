import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ createStudent: vi.fn() }));

import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { createStudentAdminTransactionId } from '@/server/repositories/database/studentCommands';
import {
  createConfiguredStudentCreation,
  createStudentCreationRepositoryCreators,
} from '@/server/repositories/configuredStudentCreation';
import { createStudent } from '@/server/sheetsRepository';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const INPUT = {
  operationId: '11111111-1111-4111-8111-111111111111',
  studentId: ' S003 ',
  name: ' 박도윤 ',
  balance: -25,
  status: 'ACTIVE' as const,
};
const COMPLETED_AT = '2026-09-01T00:00:00.000Z';

function activeTenant() {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE' } as const;
}

function success(balance = INPUT.balance) {
  return {
    ok: true as const,
    operationId: INPUT.operationId,
    action: 'CREATE' as const,
    completedAt: COMPLETED_AT,
    students: [{
      studentId: 'S003',
      name: '박도윤',
      balance,
      status: INPUT.status,
      studentVersionBefore: null,
      studentVersionAfter: 1,
      accountVersionBefore: null,
      accountVersionAfter: 1,
      balanceBefore: null,
      balanceAfter: balance,
      transactionId: balance === 0
        ? null
        : createStudentAdminTransactionId(INPUT.operationId, 'S003'),
    }],
  };
}

function postgresqlCommand(result: unknown) {
  const create = vi.fn(async () => result);
  const createDatabaseStudentCommands = vi.fn(() => ({ create }));
  const runTenantTransaction = vi.fn();
  const createSheetsStore = vi.fn();
  const creators = createStudentCreationRepositoryCreators({
    createDatabaseStudentCommands: createDatabaseStudentCommands as never,
    withTenantTransaction: runTenantTransaction,
    createConfiguredSheetsStore: createSheetsStore,
    createStudent: vi.fn(),
  });
  return { create, createDatabaseStudentCommands, runTenantTransaction, createSheetsStore, creators };
}

async function configuredPostgresql(result: unknown) {
  const fixture = postgresqlCommand(result);
  const command = await createConfiguredStudentCreation({
    env: { CLASS_STORE_STORAGE: 'postgresql' },
    getCentralTenantContext: () => activeTenant(),
    creators: fixture.creators,
  });
  return { ...fixture, command };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('configured student creation composition root', () => {
  it('uses the active PostgreSQL tenant, forwards exact input, validates evidence, and projects one versionless student', async () => {
    const fixture = postgresqlCommand(success());
    const sheetsGetter = vi.fn();
    Object.defineProperty(fixture.creators, 'createSheets', { get: sheetsGetter });
    const command = await createConfiguredStudentCreation({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(),
      creators: fixture.creators,
    });

    const student = await command.create(INPUT);

    expect(fixture.createDatabaseStudentCommands).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runTenantTransaction: fixture.runTenantTransaction,
    });
    expect(fixture.create).toHaveBeenCalledWith(INPUT);
    expect(student).toEqual({ studentId: 'S003', name: '박도윤', balance: -25, status: 'ACTIVE' });
    expect(Object.keys(student)).toEqual(['studentId', 'name', 'balance', 'status']);
    expect(sheetsGetter).not.toHaveBeenCalled();
    expect(fixture.createSheetsStore).not.toHaveBeenCalled();
  });

  it('accepts the exact zero-balance result only with a null transaction ID', async () => {
    const zeroInput = { ...INPUT, balance: 0 };
    const result = success(0);
    const fixture = postgresqlCommand(result);
    const command = await createConfiguredStudentCreation({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(),
      creators: fixture.creators,
    });

    await expect(command.create(zeroInput)).resolves.toEqual({
      studentId: 'S003', name: '박도윤', balance: 0, status: 'ACTIVE',
    });
  });

  it.each([
    ['extra envelope key', () => ({ ...success(), extra: true })],
    ['wrong success marker', () => ({ ...success(), ok: false })],
    ['wrong operation', () => ({ ...success(), operationId: '22222222-2222-4222-8222-222222222222' })],
    ['wrong action', () => ({ ...success(), action: 'UPDATE' })],
    ['noncanonical completion time', () => ({ ...success(), completedAt: '2026-09-01T00:00:00Z' })],
    ['non-array students', () => ({ ...success(), students: {} })],
    ['non-singleton students', () => ({ ...success(), students: [] })],
    ['extra student key', () => ({ ...success(), students: [{ ...success().students[0], extra: true }] })],
    ['mismatched student ID', () => ({ ...success(), students: [{ ...success().students[0], studentId: 'S004' }] })],
    ['mismatched name', () => ({ ...success(), students: [{ ...success().students[0], name: '다른 학생' }] })],
    ['mismatched balance', () => ({ ...success(), students: [{ ...success().students[0], balance: -24 }] })],
    ['mismatched status', () => ({ ...success(), students: [{ ...success().students[0], status: 'INACTIVE' }] })],
    ['non-null student before-version', () => ({ ...success(), students: [{ ...success().students[0], studentVersionBefore: 0 }] })],
    ['wrong student after-version', () => ({ ...success(), students: [{ ...success().students[0], studentVersionAfter: 2 }] })],
    ['non-null account before-version', () => ({ ...success(), students: [{ ...success().students[0], accountVersionBefore: 0 }] })],
    ['wrong account after-version', () => ({ ...success(), students: [{ ...success().students[0], accountVersionAfter: 2 }] })],
    ['non-null balance before', () => ({ ...success(), students: [{ ...success().students[0], balanceBefore: 0 }] })],
    ['wrong balance after', () => ({ ...success(), students: [{ ...success().students[0], balanceAfter: 0 }] })],
    ['missing nonzero transaction', () => ({ ...success(), students: [{ ...success().students[0], transactionId: null }] })],
    ['wrong deterministic transaction', () => ({ ...success(), students: [{ ...success().students[0], transactionId: 'student-admin:wrong' }] })],
    ['symbol-decorated envelope', () => {
      const result = success();
      Object.defineProperty(result, Symbol('extra'), { value: true });
      return result;
    }],
    ['exotic envelope prototype', () => Object.setPrototypeOf(success(), null)],
    ['non-enumerable student field', () => {
      const result = success();
      Object.defineProperty(result.students[0], 'name', { value: '박도윤', enumerable: false });
      return result;
    }],
    ['sparse students array', () => ({ ...success(), students: new Array(1) })],
    ['exotic students array prototype', () => {
      const students = [...success().students];
      Object.setPrototypeOf(students, null);
      return { ...success(), students };
    }],
  ])('rejects PostgreSQL result integrity failure: %s', async (_label, makeResult) => {
    const { command } = await configuredPostgresql(makeResult());
    await expect(command.create(INPUT)).rejects.toThrow('Student creation result integrity check failed.');
  });

  it('rejects accessor-backed evidence without invoking the accessor', async () => {
    const getter = vi.fn(() => true);
    const result = success();
    Object.defineProperty(result, 'ok', { get: getter, enumerable: true });
    const { command } = await configuredPostgresql(result);

    await expect(command.create(INPUT)).rejects.toThrow(/integrity/i);
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects a non-null transaction ID for zero balance', async () => {
    const result = success(0);
    result.students[0].transactionId = createStudentAdminTransactionId(INPUT.operationId, 'S003');
    const { command } = await configuredPostgresql(result);
    await expect(command.create({ ...INPUT, balance: 0 })).rejects.toThrow(/integrity/i);
  });

  it('keeps Sheets lazy, forwards the exact Request, strips only operationId, and returns the legacy result unchanged', async () => {
    const request = new Request('http://localhost/api/students', { method: 'POST' });
    const store = { marker: 'sheets' };
    const legacyStudent = { studentId: 'S003', name: '박도윤', balance: -25, status: 'ACTIVE' as const };
    const createSheetsStore = vi.fn(async () => store as never);
    const createLegacyStudent = vi.fn(async () => legacyStudent);
    const creators = createStudentCreationRepositoryCreators({
      createDatabaseStudentCommands: vi.fn(),
      withTenantTransaction: vi.fn(),
      createConfiguredSheetsStore: createSheetsStore,
      createStudent: createLegacyStudent,
    }, request);
    const postgresGetter = vi.fn();
    Object.defineProperty(creators, 'createPostgresql', { get: postgresGetter });
    const getCentralTenantContext = vi.fn(() => activeTenant());

    const command = await createConfiguredStudentCreation({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext, creators,
    });

    expect(createSheetsStore).not.toHaveBeenCalled();
    await expect(command.create(INPUT)).resolves.toBe(legacyStudent);
    await expect(command.create(INPUT)).resolves.toBe(legacyStudent);
    expect(createSheetsStore).toHaveBeenCalledTimes(1);
    expect(createSheetsStore).toHaveBeenCalledWith(request);
    expect(createLegacyStudent).toHaveBeenCalledWith(store, {
      studentId: INPUT.studentId,
      name: INPUT.name,
      balance: INPUT.balance,
      status: INPUT.status,
    });
    expect(getCentralTenantContext).not.toHaveBeenCalled();
    expect(postgresGetter).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { env: { CLASS_STORE_STORAGE: 'postgresql' }, getCentralTenantContext: () => activeTenant(), creators: null },
    { env: { CLASS_STORE_STORAGE: 'postgresql' }, getCentralTenantContext: () => activeTenant(), creators: {} },
  ])('rejects a malformed supplied options object without falling back to production dependencies', async (invalid) => {
    await expect(createConfiguredStudentCreation(invalid as never))
      .rejects.toThrow('Invalid configured student creation options.');
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('recognizes a decorated Request before the full own-property options discriminator', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const request = new Request('http://localhost/api/students', { method: 'POST' });
    Object.defineProperties(request, {
      env: { value: { CLASS_STORE_STORAGE: 'postgresql' } },
      getCentralTenantContext: { value: vi.fn(() => activeTenant()) },
      creators: { value: { createSheets: vi.fn(() => { throw new Error('wrong options'); }) } },
    });
    const legacyStudent = { studentId: 'S003', name: '박도윤', balance: -25, status: 'ACTIVE' as const };
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({ marker: 'store' } as never);
    vi.mocked(createStudent).mockResolvedValue(legacyStudent);

    const command = await createConfiguredStudentCreation(request);
    await expect(command.create(INPUT)).resolves.toBe(legacyStudent);

    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
  });
});
