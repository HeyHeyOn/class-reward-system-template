import type { Promotion, TaskSchedule } from '@/domain/types';
import { createPgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createDatabaseCatalogQueries } from '@/server/repositories/database/catalogQueries';
import { createDatabaseStudentQueries } from '@/server/repositories/database/studentQueries';
import { createDatabaseTaskQueries } from '@/server/repositories/database/taskQueries';
import { createDatabaseTransactionQueries } from '@/server/repositories/database/transactionQueries';
import {
  getActivePromotions as getSheetActivePromotions,
  getPromotions as getSheetPromotions,
} from '@/server/repositories/sheets/promotionQueries';
import {
  getActiveProducts as getSheetActiveProducts,
  getProducts as getSheetProducts,
  getStudentById as getSheetStudentById,
  getTaskById as getSheetTaskById,
  getTasks as getSheetTasks,
  getTransactions as getSheetTransactions,
  type SheetsReader,
} from '@/server/sheetsRepository';

export const PUBLIC_PROJECTION_FORBIDDEN_FIELDS = [
  'padletBoardId',
  'evidenceProvider',
  'evidenceBoardId',
  'evidencePostId',
  'evidenceCreatedAt',
  'evidenceAuthorFullName',
] as const;

type ProjectionRead = () => Promise<unknown>;

type ProjectionParityContract = Readonly<{
  sheets: ProjectionRead;
  postgresql: ProjectionRead;
}>;

export type ProjectionParityFixture = Readonly<{
  contracts: ReadonlyMap<string, ProjectionParityContract>;
  readAllPublicGateAProjections(): Promise<unknown[]>;
  close(): Promise<void>;
}>;

const NONE_SCHEDULE: TaskSchedule = {
  ruleVersion: 1,
  effectiveFrom: '2026-08-01T00:00:00.000Z',
  timeZone: 'Asia/Seoul',
  recurrence: { type: 'NONE' },
  resetCompletionOnCycle: false,
  resetAssignmentOnCycle: false,
};

const WEEKLY_SCHEDULE: TaskSchedule = {
  ruleVersion: 2,
  effectiveFrom: '2026-08-20T00:00:00.000Z',
  timeZone: 'Asia/Seoul',
  recurrence: { type: 'WEEKLY', weekdays: [1, 3, 5], time: '09:30' },
  resetCompletionOnCycle: true,
  resetAssignmentOnCycle: false,
};

const PENDING_SCHEDULE: TaskSchedule = {
  ruleVersion: 3,
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  timeZone: 'Asia/Seoul',
  recurrence: { type: 'MONTHLY', dayOfMonth: 15, time: '10:00' },
  resetCompletionOnCycle: true,
  resetAssignmentOnCycle: true,
};

const LINKED_PROMOTION: Promotion = {
  promotionId: 'PROMO-A',
  name: '2+1 행사',
  description: '연결 행사',
  type: 'N_PLUS_ONE',
  buyQuantity: 2,
  freeQuantity: 1,
  productIds: ['PRODUCT-A'],
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2027-01-01T00:00:00.000Z',
  isActive: true,
  sortOrder: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  schemaVersion: 3,
};

const LINKED_ADJUSTMENT = {
  promotionId: 'PROMO-A',
  type: 'N_PLUS_ONE' as const,
  beforeAmount: 900,
  afterAmount: 600,
  discountAmount: 300,
  freeQuantity: 1,
};

export async function createProjectionParityFixture(): Promise<ProjectionParityFixture> {
  const harness = await createPgliteDatabaseHarness();
  try {
    const sheetReader = createCanonicalSheetReader();
    await seedCanonicalPostgresql(harness.database, harness.tenantOneId);

    const students = createDatabaseStudentQueries({
      tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
    });
    const catalog = createDatabaseCatalogQueries({
      tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
    });
    const tasks = createDatabaseTaskQueries({
      tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
    });
    const transactions = createDatabaseTransactionQueries({
      tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
    });

    const sheetProductById = async (productId: string) =>
      (await getSheetProducts(sheetReader)).find((product) => product.productId === productId) ?? null;
    const sheetPromotionById = async (promotionId: string) =>
      (await getSheetPromotions(sheetReader)).find((promotion) => promotion.promotionId === promotionId) ?? null;
    const sheetTransactionById = async (transactionId: string) =>
      (await getSheetTransactions(sheetReader))
        .find((transaction) => transaction.transactionId === transactionId) ?? null;

    const contracts = new Map<string, ProjectionParityContract>([
      ['student.active', pair(
        () => getSheetStudentById(sheetReader, 'S2'),
        () => students.getStudentById('S2'),
      )],
      ['student.inactive', pair(
        () => getSheetStudentById(sheetReader, 'S1'),
        () => students.getStudentById('S1'),
      )],
      ['student.missing', pair(
        () => getSheetStudentById(sheetReader, 'MISSING'),
        () => students.getStudentById('MISSING'),
      )],
      ['products.active', pair(
        () => getSheetActiveProducts(sheetReader),
        () => catalog.getActiveProducts(),
      )],
      ['product.active', pair(
        () => sheetProductById('PRODUCT-B'),
        () => catalog.getProductById('PRODUCT-B'),
      )],
      ['product.inactive', pair(
        () => sheetProductById('PRODUCT-OFF'),
        () => catalog.getProductById('PRODUCT-OFF'),
      )],
      ['product.missing', pair(
        () => sheetProductById('MISSING'),
        () => catalog.getProductById('MISSING'),
      )],
      ['promotions.active', pair(
        () => getSheetActivePromotions(sheetReader),
        () => catalog.getActivePromotions(),
      )],
      ['promotion.active', pair(
        () => sheetPromotionById('PROMO-A'),
        () => catalog.getPromotionById('PROMO-A'),
      )],
      ['promotion.inactive', pair(
        () => sheetPromotionById('PROMO-OFF'),
        () => catalog.getPromotionById('PROMO-OFF'),
      )],
      ['promotion.missing', pair(
        () => sheetPromotionById('MISSING'),
        () => catalog.getPromotionById('MISSING'),
      )],
      ['tasks.active', pair(
        () => getSheetTasks(sheetReader),
        () => tasks.getActiveTasks(),
      )],
      ['task.active', pair(
        () => getSheetTaskById(sheetReader, 'TASK-B'),
        () => tasks.getTaskById('TASK-B'),
      )],
      ['task.inactive', pair(
        () => getSheetTaskById(sheetReader, 'TASK-OFF'),
        () => tasks.getTaskById('TASK-OFF'),
      )],
      ['task.missing', pair(
        () => getSheetTaskById(sheetReader, 'MISSING'),
        () => tasks.getTaskById('MISSING'),
      )],
      ['transaction.cancelled', pair(
        () => sheetTransactionById('CHECKOUT-1'),
        () => transactions.getTransactionById('CHECKOUT-1'),
      )],
      ['transaction.missing', pair(
        () => sheetTransactionById('MISSING'),
        () => transactions.getTransactionById('MISSING'),
      )],
    ]);

    return {
      contracts,
      async readAllPublicGateAProjections() {
        const values: unknown[] = [];
        for (const contract of contracts.values()) {
          values.push(await contract.sheets(), await contract.postgresql());
        }
        return values;
      },
      close: () => harness.close(),
    };
  } catch (error) {
    await harness.close();
    throw error;
  }
}

function pair(sheets: ProjectionRead, postgresql: ProjectionRead): ProjectionParityContract {
  return { sheets, postgresql };
}

function createCanonicalSheetReader(): SheetsReader {
  const taskHeaders = [
    'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt',
    'allowedStudentIds', 'availableFrom', 'dueAt', 'prerequisiteTaskId', 'padletBoardId',
    'taskInstanceId', 'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone',
    'recurrenceType', 'recurrenceTime', 'recurrenceWeekday', 'recurrenceDayOfMonth',
    'resetCompletionOnCycle', 'resetAssignmentOnCycle', 'pendingRuleVersion',
    'pendingEffectiveFrom', 'pendingTimeZone', 'pendingRecurrenceType',
    'pendingRecurrenceTime', 'pendingRecurrenceWeekday', 'pendingRecurrenceDayOfMonth',
    'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle', 'recurrenceWeekdays',
    'pendingRecurrenceWeekdays',
  ];
  const taskRow = (values: Record<string, string>) =>
    taskHeaders.map((header) => values[header] ?? '');
  const extendedItem = {
    productId: 'PRODUCT-A', name: '행사 상품', price: 300, quantity: 3, subtotal: 600,
    regularUnitPrice: 300, regularTotal: 900, totalQuantity: 3, paidQuantity: 2,
    freeQuantity: 1, finalTotal: 600, totalDiscount: 300,
    adjustments: [LINKED_ADJUSTMENT], appliedPromotions: [LINKED_PROMOTION],
  };

  const rows = {
    Students: [
      ['studentId', 'name', 'balance', 'status'],
      ['S2', '활성 학생', '2000', 'ACTIVE'],
      ['S1', '비활성 학생', '-50', 'INACTIVE'],
    ],
    Products: [
      ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'],
      ['PRODUCT-B', '동률 상품', '200', '2', 'TRUE', '', '', '1'],
      ['PRODUCT-A', '동률 상품', '300', '3', 'TRUE', 'https://example.com/a.png', '문구', '1'],
      ['PRODUCT-OFF', '비활성 상품', '50', '0', 'FALSE', '', '', '2'],
    ],
    Promotions: [
      ['promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity',
        'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion'],
      ['PROMO-B', '정액 행사', '', 'FIXED_DISCOUNT', '50', '', '',
        '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'TRUE', '1',
        '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z', '3'],
      ['PROMO-A', '2+1 행사', '연결 행사', 'N_PLUS_ONE', '', '2', '1',
        '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'TRUE', '1',
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '3'],
      ['PROMO-OFF', '비활성 행사', '', 'PROMOTIONAL_PRICE', '75', '', '',
        '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'FALSE', '2',
        '2026-01-05T00:00:00.000Z', '2026-01-06T00:00:00.000Z', '3'],
    ],
    PromotionProducts: [
      ['promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion'],
      ['LINK-A', 'PROMO-A', 'PRODUCT-A', '2026-01-01T00:00:00.000Z', '3'],
    ],
    Tasks: [
      taskHeaders,
      taskRow({
        taskId: 'BASE', title: '선행 과제', reward: '10', isActive: 'TRUE', sortOrder: '1',
        createdAt: '2026-08-01T00:00:00.000Z', taskInstanceId: 'INSTANCE-BASE',
        ruleVersion: '1', scheduleEffectiveFrom: NONE_SCHEDULE.effectiveFrom,
        recurrenceTimeZone: 'Asia/Seoul', recurrenceType: 'NONE',
        resetCompletionOnCycle: 'FALSE', resetAssignmentOnCycle: 'FALSE',
      }),
      taskRow({
        taskId: 'TASK-B', title: '동률 과제', description: '활성 설명', reward: '20',
        isActive: 'TRUE', sortOrder: '2', createdAt: '2026-08-02T00:00:00.000Z',
        allowedStudentIds: 'S2,S1', taskInstanceId: 'INSTANCE-B', ruleVersion: '1',
        scheduleEffectiveFrom: NONE_SCHEDULE.effectiveFrom, recurrenceTimeZone: 'Asia/Seoul',
        recurrenceType: 'NONE', resetCompletionOnCycle: 'FALSE', resetAssignmentOnCycle: 'FALSE',
      }),
      taskRow({
        taskId: 'TASK-A', title: '동률 과제', reward: '30', isActive: 'TRUE', sortOrder: '2',
        createdAt: '2026-08-03T00:00:00.000Z', taskInstanceId: 'INSTANCE-A', ruleVersion: '1',
        scheduleEffectiveFrom: NONE_SCHEDULE.effectiveFrom, recurrenceTimeZone: 'Asia/Seoul',
        recurrenceType: 'NONE', resetCompletionOnCycle: 'FALSE', resetAssignmentOnCycle: 'FALSE',
      }),
      taskRow({
        taskId: 'TASK-OFF', title: '비활성 과제', description: '예약 설명', reward: '40',
        isActive: 'FALSE', sortOrder: '3', createdAt: '2026-08-04T00:00:00.000Z',
        availableFrom: '2026-08-21T01:02:03.000Z', dueAt: '2026-08-31T04:05:06.000Z',
        prerequisiteTaskId: 'BASE', padletBoardId: 'BOARD000000000001',
        taskInstanceId: 'INSTANCE-OFF', ruleVersion: '2',
        scheduleEffectiveFrom: WEEKLY_SCHEDULE.effectiveFrom, recurrenceTimeZone: 'Asia/Seoul',
        recurrenceType: 'WEEKLY', recurrenceTime: '09:30', recurrenceWeekdays: '5,1,3',
        resetCompletionOnCycle: 'TRUE', resetAssignmentOnCycle: 'FALSE',
        pendingRuleVersion: '3', pendingEffectiveFrom: PENDING_SCHEDULE.effectiveFrom,
        pendingTimeZone: 'Asia/Seoul', pendingRecurrenceType: 'MONTHLY',
        pendingRecurrenceTime: '10:00', pendingRecurrenceDayOfMonth: '15',
        pendingResetCompletionOnCycle: 'TRUE', pendingResetAssignmentOnCycle: 'TRUE',
      }),
    ],
    Transactions: [
      ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount',
        'balanceBefore', 'balanceAfter', 'status', 'operator'],
      ['CHECKOUT-1', '2026-08-29T01:00:00.000Z', 'S2', '활성 학생', JSON.stringify([
        extendedItem,
        { productId: 'PRODUCT-B', name: '보조 상품', price: 200, quantity: 1, subtotal: 200 },
      ]), '800', '2000', '1200', 'CANCELLED', 'kiosk'],
      ['CANCEL-1', '2026-08-29T02:00:00.000Z', 'S2', '활성 학생', '[]',
        '-800', '1200', '2000', 'CANCEL_REVERSAL', 'cancel:CHECKOUT-1'],
    ],
  } satisfies Partial<Record<Parameters<SheetsReader['getRows']>[0], string[][]>>;

  return { getRows: async (sheetName) => rows[sheetName as keyof typeof rows] ?? [] };
}

type PgliteDatabase = Awaited<ReturnType<typeof createPgliteDatabaseHarness>>['database'];

async function seedCanonicalPostgresql(database: PgliteDatabase, tenantId: string): Promise<void> {
  for (const student of [
    ['S2', '활성 학생', 'ACTIVE', 2000],
    ['S1', '비활성 학생', 'INACTIVE', -50],
  ] as const) {
    await database.query(
      'INSERT INTO students (tenant_id, student_id, name, status) VALUES ($1,$2,$3,$4)',
      [tenantId, student[0], student[1], student[2]],
    );
    await database.query(
      'INSERT INTO accounts (tenant_id, student_id, balance) VALUES ($1,$2,$3)',
      [tenantId, student[0], student[3]],
    );
  }

  for (const product of [
    ['PRODUCT-B', '동률 상품', 200, 2, true, null, null, 1, '2026-01-01T00:00:00.000Z'],
    ['PRODUCT-A', '동률 상품', 300, 3, true, 'https://example.com/a.png', '문구', 1, '2026-01-02T00:00:00.000Z'],
    ['PRODUCT-OFF', '비활성 상품', 50, 0, false, null, null, 2, '2026-01-03T00:00:00.000Z'],
  ] as const) {
    await database.query(
      `INSERT INTO products
       (tenant_id, product_id, name, price, stock, is_active, image_url, category, sort_order,
        created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [tenantId, ...product],
    );
  }

  for (const promotion of [
    ['PROMO-B', '정액 행사', '', 'FIXED_DISCOUNT', null, null, null, null, 50,
      true, 1, '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z'],
    ['PROMO-A', '2+1 행사', '연결 행사', 'N_PLUS_ONE', 2, 1, null, null, null,
      true, 1, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'],
    ['PROMO-OFF', '비활성 행사', '', 'PROMOTIONAL_PRICE', null, null, 75, null, null,
      false, 2, '2026-01-05T00:00:00.000Z', '2026-01-06T00:00:00.000Z'],
  ] as const) {
    await database.query(
      `INSERT INTO promotions
       (tenant_id, promotion_id, name, description, type, n_plus_one_buy_quantity,
        n_plus_one_free_quantity, promotional_price, percent_discount, fixed_discount,
        starts_at, ends_at, is_active, sort_order, created_at, updated_at, schema_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               '2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z',$11,$12,$13,$14,3)`,
      [tenantId, ...promotion],
    );
  }
  await database.query(
    `INSERT INTO promotion_products
     (tenant_id, promotion_product_id, promotion_id, product_id, created_at, schema_version)
     VALUES ($1,'LINK-A','PROMO-A','PRODUCT-A','2026-01-01T00:00:00.000Z',3)`,
    [tenantId],
  );

  const tasks = [
    ['INSTANCE-BASE', 'BASE', '선행 과제', '', 10, true, 1, null, null, null, null,
      NONE_SCHEDULE, null, '2026-08-01T00:00:00.000Z'],
    ['INSTANCE-B', 'TASK-B', '동률 과제', '활성 설명', 20, true, 2, null, null, null, null,
      NONE_SCHEDULE, null, '2026-08-02T00:00:00.000Z'],
    ['INSTANCE-A', 'TASK-A', '동률 과제', '', 30, true, 2, null, null, null, null,
      NONE_SCHEDULE, null, '2026-08-03T00:00:00.000Z'],
    ['INSTANCE-OFF', 'TASK-OFF', '비활성 과제', '예약 설명', 40, false, 3,
      '2026-08-21T01:02:03.000Z', '2026-08-31T04:05:06.000Z', 'INSTANCE-BASE',
      'BOARD000000000001', WEEKLY_SCHEDULE, PENDING_SCHEDULE, '2026-08-04T00:00:00.000Z'],
  ] as const;
  for (const task of tasks) {
    await database.query(
      `INSERT INTO tasks
       (tenant_id, task_instance_id, task_id, title, description, reward, is_active, sort_order,
        available_from, due_at, prerequisite_task_instance_id, padlet_board_id,
        current_schedule, pending_schedule, schedule_schema_version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,1,$15,$15)`,
      [
        tenantId, ...task.slice(0, 11), JSON.stringify(task[11]),
        task[12] ? JSON.stringify(task[12]) : null, task[13],
      ],
    );
  }
  await database.query(
    `INSERT INTO task_allowed_students (tenant_id, task_instance_id, student_id, created_at)
     VALUES ($1,'INSTANCE-B','S2','2026-08-01T00:00:00.000Z'),
            ($1,'INSTANCE-B','S1','2026-08-02T00:00:00.000Z')`,
    [tenantId],
  );

  await database.query(
    `INSERT INTO transactions
     (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
      legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot,
      legacy_status_snapshot, reverses_transaction_id, schema_version)
     VALUES
     ($1,'CHECKOUT-1','2026-08-29T01:00:00.000Z','S2','활성 학생','CHECKOUT',
      800,-800,2000,1200,'kiosk','COMPLETED',NULL,1),
     ($1,'CANCEL-1','2026-08-29T02:00:00.000Z','S2','활성 학생','CANCELLATION',
      -800,800,1200,2000,'cancel:CHECKOUT-1','CANCEL_REVERSAL','CHECKOUT-1',1)`,
    [tenantId],
  );
  await database.query(
    `INSERT INTO transaction_items
     (tenant_id, transaction_id, line_number, product_id_snapshot, product_name_snapshot,
      quantity, unit_price_snapshot, subtotal_snapshot, regular_unit_price, regular_total,
      total_quantity, paid_quantity, free_quantity, final_total, total_discount,
      adjustments_snapshot, applied_promotions_snapshot)
     VALUES
     ($1,'CHECKOUT-1',2,'PRODUCT-B','보조 상품',1,200,200,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
     ($1,'CHECKOUT-1',1,'PRODUCT-A','행사 상품',3,300,600,300,900,3,2,1,600,300,$2::jsonb,$3::jsonb)`,
    [tenantId, JSON.stringify([LINKED_ADJUSTMENT]), JSON.stringify([LINKED_PROMOTION])],
  );

  await database.query(
    `INSERT INTO task_completions
     (tenant_id, completion_id, completed_at, task_id_snapshot, task_name_snapshot,
      student_id, student_name_snapshot, reward_snapshot, balance_before, balance_after,
      status, evidence_provider, evidence_board_id, evidence_post_id, evidence_created_at,
      evidence_author_full_name, schema_version)
     VALUES ($1,'HIDDEN-EVIDENCE','2026-08-30T00:00:00.000Z','TASK-OFF','비활성 과제',
      'S2','활성 학생',0,2000,2000,'COMPLETED','PADLET','BOARD000000000001',
      'POST-1','2026-08-30T00:00:00.000Z','학생 작성자',1)`,
    [tenantId],
  );
}
