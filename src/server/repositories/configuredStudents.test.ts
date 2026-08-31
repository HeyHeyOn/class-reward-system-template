import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { Student } from '@/domain/types';
import {
  createConfiguredStudentReader,
  createStudentRepositoryCreators,
} from '@/server/repositories/configuredStudents';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const STUDENTS: Student[] = [{
  studentId: 'S1',
  name: '학생',
  balance: 100,
  status: 'ACTIVE',
}];

function activeTenant(overrides: Record<string, unknown> = {}) {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE', ...overrides };
}

describe('configured student read composition root', () => {
  it('selects PostgreSQL and builds student queries with the tenant snapshot runner', async () => {
    const withTenantSnapshot = vi.fn();
    const databaseAdapter = {
      getStudents: vi.fn(async () => STUDENTS),
      getStudentById: vi.fn(async () => STUDENTS[0]),
    };
    const createDatabaseStudentQueries = vi.fn(() => databaseAdapter);
    const createConfiguredSheetsReader = vi.fn();
    const creators = createStudentRepositoryCreators({
      createDatabaseStudentQueries,
      withTenantSnapshot,
      createConfiguredSheetsReader,
      getStudents: vi.fn(),
      getStudentById: vi.fn(),
    });
    const unselectedSheetsCreator = vi.fn(() => {
      throw new Error('unselected Sheets creator accessed');
    });
    Object.defineProperty(creators, 'createSheets', { get: unselectedSheetsCreator });

    const students = await createConfiguredStudentReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(),
      creators,
    });

    expect(students).toBe(databaseAdapter);
    expect(createDatabaseStudentQueries).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runTenantTransaction: withTenantSnapshot,
    });
    expect(unselectedSheetsCreator).not.toHaveBeenCalled();
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
  });

  it('selects explicit Sheets and lazily delegates both reads to one configured reader', async () => {
    const reader = { getRows: vi.fn() };
    const createConfiguredSheetsReader = vi.fn(async () => reader);
    const getStudents = vi.fn(async () => STUDENTS);
    const getStudentById = vi.fn(async () => STUDENTS[0]);
    const creators = createStudentRepositoryCreators({
      createDatabaseStudentQueries: vi.fn(),
      withTenantSnapshot: vi.fn(),
      createConfiguredSheetsReader,
      getStudents,
      getStudentById,
    });
    const unselectedPostgresqlCreator = vi.fn(() => {
      throw new Error('unselected PostgreSQL creator accessed');
    });
    Object.defineProperty(creators, 'createPostgresql', { get: unselectedPostgresqlCreator });
    const getCentralTenantContext = vi.fn(() => activeTenant());

    const students = await createConfiguredStudentReader({
      env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext,
      creators,
    });

    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    await expect(students.getStudents()).resolves.toEqual(STUDENTS);
    await expect(students.getStudentById('S1')).resolves.toEqual(STUDENTS[0]);
    expect(createConfiguredSheetsReader).toHaveBeenCalledOnce();
    expect(getStudents).toHaveBeenCalledWith(reader);
    expect(getStudentById).toHaveBeenCalledWith(reader, 'S1');
    expect(getCentralTenantContext).not.toHaveBeenCalled();
    expect(unselectedPostgresqlCreator).not.toHaveBeenCalled();
  });

  it.each([
    ['missing tenant context', undefined],
    ['invalid tenant UUID', activeTenant({ tenantId: 'not-a-uuid' })],
    ['inactive tenant', activeTenant({ tenantStatus: 'SUSPENDED' })],
  ])('fails closed for PostgreSQL with %s before accessing creators', async (_label, tenantContext) => {
    const creators = {} as Parameters<typeof createConfiguredStudentReader>[0]['creators'];
    const postgresGetter = vi.fn(() => vi.fn());
    const sheetsGetter = vi.fn(() => vi.fn());
    Object.defineProperties(creators, {
      createPostgresql: { get: postgresGetter },
      createSheets: { get: sheetsGetter },
    });

    await expect(createConfiguredStudentReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => tenantContext,
      creators,
    })).rejects.toThrow(/tenant|ACTIVE/i);
    expect(postgresGetter).not.toHaveBeenCalled();
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it('propagates PostgreSQL read failure without accessing Sheets', async () => {
    const dbError = new Error('database unavailable');
    const createPostgresql = vi.fn(async () => ({
      getStudents: vi.fn(async () => { throw dbError; }),
      getStudentById: vi.fn(async () => { throw dbError; }),
    }));
    const sheetsGetter = vi.fn(() => vi.fn());
    const creators = { createPostgresql } as unknown as
      Parameters<typeof createConfiguredStudentReader>[0]['creators'];
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const students = await createConfiguredStudentReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(),
      creators,
    });

    await expect(students.getStudents()).rejects.toBe(dbError);
    await expect(students.getStudentById('S1')).rejects.toBe(dbError);
    expect(createPostgresql).toHaveBeenCalledOnce();
    expect(sheetsGetter).not.toHaveBeenCalled();
  });
});
