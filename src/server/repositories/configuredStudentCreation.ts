import 'server-only';

import type { Student } from '@/domain/types';
import { withTenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  createDatabaseStudentCommands,
  createStudentAdminTransactionId,
  type CreateStudentAdminInput,
  type StudentAdminSuccess,
} from '@/server/repositories/database/studentCommands';
import type { RepositoryCreators } from '@/server/repositories/factory';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { createStudent, type SheetsStore, type StudentCreate } from '@/server/sheetsRepository';

export type ConfiguredStudentCreationInput = CreateStudentAdminInput;

export type ConfiguredStudentCreationCommand = Readonly<{
  create(input: ConfiguredStudentCreationInput): Promise<Student>;
}>;

type DatabaseStudentCreationCommand = Readonly<{
  create(input: CreateStudentAdminInput): Promise<StudentAdminSuccess>;
}>;

type StudentCreationCreatorDependencies = Readonly<{
  createDatabaseStudentCommands: (dependencies: {
    tenantId: string;
    runTenantTransaction: typeof withTenantTransaction;
  }) => DatabaseStudentCreationCommand;
  withTenantTransaction: typeof withTenantTransaction;
  createConfiguredSheetsStore: (request?: Request) => Promise<SheetsStore>;
  createStudent: (store: SheetsStore, input: StudentCreate) => Promise<Student>;
}>;

export type ConfiguredStudentCreationOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredStudentCreationCommand, ConfiguredStudentCreationCommand>;
}>;

export function createStudentCreationRepositoryCreators(
  dependencies: StudentCreationCreatorDependencies,
  request?: Request,
): RepositoryCreators<ConfiguredStudentCreationCommand, ConfiguredStudentCreationCommand> {
  return {
    createPostgresql(authority) {
      const commands = dependencies.createDatabaseStudentCommands({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantTransaction,
      });
      return {
        async create(input) {
          const result: unknown = await commands.create(input);
          assertStudentCreationResult(result, input);
          const created = result.students[0];
          return {
            studentId: created.studentId,
            name: created.name,
            balance: created.balance,
            status: created.status,
          };
        },
      };
    },
    createSheets() {
      let storePromise: Promise<SheetsStore> | undefined;
      const configuredStore = () => {
        storePromise ??= dependencies.createConfiguredSheetsStore(request);
        return storePromise;
      };
      return {
        async create(input) {
          return dependencies.createStudent(await configuredStore(), {
            studentId: input.studentId,
            name: input.name,
            balance: input.balance,
            status: input.status,
          });
        },
      };
    },
  };
}

function assertStudentCreationResult(
  value: unknown,
  input: ConfiguredStudentCreationInput,
): asserts value is StudentAdminSuccess {
  assertExactRecord(value, ['ok', 'operationId', 'action', 'completedAt', 'students']);
  if (value.ok !== true
    || value.operationId !== input.operationId
    || value.action !== 'CREATE'
    || !isCanonicalInstant(value.completedAt)
    || !isStrictArray(value.students, 1)) {
    throw resultIntegrityError();
  }

  const student = value.students[0];
  assertExactRecord(student, [
    'studentId', 'name', 'balance', 'status', 'studentVersionBefore',
    'studentVersionAfter', 'accountVersionBefore', 'accountVersionAfter',
    'balanceBefore', 'balanceAfter', 'transactionId',
  ]);
  const expectedStudentId = input.studentId.trim();
  const expectedName = input.name.trim();
  const expectedTransactionId = input.balance === 0
    ? null
    : createStudentAdminTransactionId(input.operationId, expectedStudentId);
  if (student.studentId !== expectedStudentId
    || student.name !== expectedName
    || student.balance !== input.balance
    || student.status !== input.status
    || student.studentVersionBefore !== null
    || student.studentVersionAfter !== 1
    || student.accountVersionBefore !== null
    || student.accountVersionAfter !== 1
    || student.balanceBefore !== null
    || student.balanceAfter !== input.balance
    || student.transactionId !== expectedTransactionId) {
    throw resultIntegrityError();
  }
}

function assertExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) {
    throw resultIntegrityError();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || expectedKeys.some((key) => !keys.includes(key))) {
    throw resultIntegrityError();
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw resultIntegrityError();
    }
  }
}

function isStrictArray(value: unknown, expectedLength: number): value is unknown[] {
  if (!Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0
    || value.length !== expectedLength) return false;
  const keys = Reflect.ownKeys(value);
  const expectedKeys = Array.from({ length: expectedLength }, (_, index) => String(index));
  expectedKeys.push('length');
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) return false;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || lengthDescriptor.enumerable) return false;
  return expectedKeys.slice(0, -1).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
  });
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function resultIntegrityError(): Error {
  return new Error('Student creation result integrity check failed.');
}

function productionCreators(request?: Request) {
  return createStudentCreationRepositoryCreators({
    createDatabaseStudentCommands,
    withTenantTransaction,
    createConfiguredSheetsStore,
    createStudent,
  }, request);
}

export function createConfiguredStudentCreation(): Promise<ConfiguredStudentCreationCommand>;
export function createConfiguredStudentCreation(
  request: Request,
): Promise<ConfiguredStudentCreationCommand>;
export function createConfiguredStudentCreation(
  options: ConfiguredStudentCreationOptions,
): Promise<ConfiguredStudentCreationCommand>;
export async function createConfiguredStudentCreation(
  requestOrOptions?: Request | ConfiguredStudentCreationOptions,
): Promise<ConfiguredStudentCreationCommand> {
  const request = isRequest(requestOrOptions) ? requestOrOptions : undefined;
  const options = request ? undefined : isConfiguredStudentCreationOptions(requestOrOptions)
    ? requestOrOptions
    : undefined;
  if (requestOrOptions !== undefined && !request && !options) {
    throw new Error('Invalid configured student creation options.');
  }
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext
      ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators(request),
  });
  return repository.adapter;
}

function isRequest(value: unknown): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request;
}

function isConfiguredStudentCreationOptions(
  value: Request | ConfiguredStudentCreationOptions | undefined,
): value is ConfiguredStudentCreationOptions {
  return Boolean(
    value
    && typeof value === 'object'
    && Object.hasOwn(value, 'env')
    && Object.hasOwn(value, 'getCentralTenantContext')
    && Object.hasOwn(value, 'creators')
    && typeof (value as ConfiguredStudentCreationOptions).getCentralTenantContext === 'function'
    && typeof (value as ConfiguredStudentCreationOptions).creators === 'object'
    && (value as ConfiguredStudentCreationOptions).creators !== null
    && hasRepositoryCreator((value as ConfiguredStudentCreationOptions).creators, 'createPostgresql')
    && hasRepositoryCreator((value as ConfiguredStudentCreationOptions).creators, 'createSheets'),
  );
}

function hasRepositoryCreator(value: object, key: 'createPostgresql' | 'createSheets'): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return Boolean(descriptor
    && (typeof descriptor.value === 'function' || typeof descriptor.get === 'function'));
}
