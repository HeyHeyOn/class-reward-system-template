// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { buildXlsxImportPlan, type XlsxImportPlan } from './xlsxImportPlan';
import { readXlsxWorkbookGrid } from './xlsxWorkbook';
import { buildSyntheticCrsWorkbook, writeSyntheticXlsx, type SyntheticWorkbook } from './testing/syntheticCrsWorkbook';

const NOW = new Date('2026-10-07T03:00:00.000Z'); // Wednesday 12:00 in Asia/Seoul

async function plan(workbook: SyntheticWorkbook, now = NOW): Promise<XlsxImportPlan> {
  const grid = await readXlsxWorkbookGrid(await writeSyntheticXlsx(workbook));
  return buildXlsxImportPlan(grid, { now: now.toISOString(), fileDigest: 'f'.repeat(64) });
}

function messages(result: XlsxImportPlan, level: 'error' | 'warning') {
  return result.issues.filter(issue => issue.level === level).map(issue => [issue.sheet, issue.row, issue.message]);
}

describe('buildXlsxImportPlan', () => {
  it('maps every sheet of a synthetic CRS workbook to the current class state', async () => {
    const { workbook, expected } = buildSyntheticCrsWorkbook(NOW);
    const result = await plan(workbook);
    expect(messages(result, 'error')).toEqual([]);
    expect(result.canImport).toBe(true);
    expect(result.settings).toEqual({ currencyUnit: '점', appTitle: '시험 매점', bankTitle: '시험 은행', themeColor: 'white',
      fontFamily: 'default', qrManualInputEnabled: true });
    expect(result.students).toEqual([
      { studentId: '0101', name: '바다', balance: 1, status: 'ACTIVE' },
      { studentId: 'S01', name: '가람', balance: 12, status: 'ACTIVE' },
      { studentId: 'S02', name: '나래', balance: 0, status: 'ACTIVE' },
      { studentId: 'S03', name: '다솜', balance: 5, status: 'ACTIVE' },
      { studentId: 'S04', name: '라온', balance: 7, status: 'ACTIVE' },
      { studentId: 'S05', name: '마루', balance: 3, status: 'INACTIVE' },
    ]);
    expect(result.products).toEqual([
      { productId: 'P1', name: '연필', price: 2, stock: 10, isActive: true, category: '문구', sortOrder: 1 },
      { productId: 'P2', name: '지우개', price: 1, stock: 0, isActive: false, imageUrl: 'https://example.invalid/eraser.png', sortOrder: 2 },
    ]);
    expect(result.promotions).toEqual([{ promotionId: 'PR1', productIds: ['P1'], definition: expect.objectContaining({
      name: '연필 할인', type: 'FIXED_DISCOUNT', discountAmount: 1, isActive: true, sortOrder: 1 }) }]);
    // Prerequisites precede dependents.
    expect(result.tasks.map(task => task.taskId).indexOf('TA')).toBeLessThan(result.tasks.map(task => task.taskId).indexOf('TC'));
    const byId = Object.fromEntries(result.tasks.map(task => [task.taskId, task]));
    for (const [taskId, state] of Object.entries(expected.tasks)) {
      expect({ ready: byId[taskId].readyStudentIds, completed: byId[taskId].completedStudentIds,
        completedUnassigned: byId[taskId].completedUnassignedStudentIds, isActive: byId[taskId].isActive }, taskId).toEqual(state);
    }
    expect(byId.TB.schedule).toEqual({ recurrence: { type: 'WEEKLY', weekdays: [1], time: '09:00' }, timeZone: 'Asia/Seoul',
      resetCompletionOnCycle: true, resetAssignmentOnCycle: false });
    expect(byId.TC.prerequisiteTaskId).toBe('TA');
    // Real date cells are wall-clock Asia/Seoul.
    expect(byId.TD).toMatchObject({ availableFrom: '2030-03-02T00:00:00.000Z', dueAt: '2030-03-09T09:30:00.000Z', reward: 0 });
    expect(result.summary).toMatchObject({ students: 6, activeStudents: 5, totalBalance: 28, products: 2, activeProducts: 1,
      totalStock: 10, promotions: 1, tasks: 4, activeTasks: 3, readyAssignments: 5, completedAssignments: 4,
      history: { transactions: 1, adjustments: 0, taskAssignments: 10, taskCompletions: 5 } });
    const warnings = messages(result, 'warning').map(([, , message]) => message);
    expect(warnings).toContain('잔액은 그대로 옮기고, 이전 거래, 과제 기록은 옮기지 않아요. 이전 기록은 올린 원본 파일에 그대로 남아 있어요.');
    expect(warnings).toContain("'메모' 시트는 구글 시트 버전의 시트가 아니라서 옮기지 않아요.");
    expect(messages(result, 'warning')).toContainEqual(['PromotionProducts', 3,
      "상품 'P9' 또는 행사 'PR1'를 찾을 수 없어 이 행사 연결은 옮기지 않아요."]);
    expect(messages(result, 'warning')).toContainEqual(['Tasks', 5, "'availableFrom' 칸의 날짜를 한국 시간 2030-03-02 09:00로 읽었어요."]);
    expect(messages(result, 'warning')).toContainEqual(['Tasks', 5, "'dueAt' 칸의 날짜를 한국 시간 2030-03-09 18:30로 읽었어요."]);
    expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
  });

  it('reports row-level problems in Korean with sheet and row references and blocks the import', async () => {
    const { workbook } = buildSyntheticCrsWorkbook(NOW);
    workbook.Students[2] = ['S02', '', 'many', 'ACTIVE'];
    workbook.Students[3] = ['S01', '다솜', 5, 'ACTIVE'];
    workbook.Products[1] = ['P1', '연필', -2, 10, 'MAYBE', '', '문구', 1];
    const result = await plan(workbook);
    expect(result.canImport).toBe(false);
    const errors = messages(result, 'error');
    expect(errors).toContainEqual(['Students', 3, '이름(name)이 비어 있어요, 잔액(balance)은 정수여야 해요.']);
    expect(errors).toContainEqual(['Students', 2, '같은 ID가 다른 행에도 있어요. ID는 한 번씩만 써 주세요.']);
    expect(errors).toContainEqual(['Students', 4, '같은 ID가 다른 행에도 있어요. ID는 한 번씩만 써 주세요.']);
    expect(errors).toContainEqual(['Products', 2, '가격(price)은 0 이상의 정수여야 해요, 판매 여부(isActive)은 TRUE 또는 FALSE여야 해요.']);
  });

  it('refuses a workbook without the CRS sheets and reports missing columns', async () => {
    const missing = await plan({ Sheet1: [['이름'], ['가람']] });
    expect(missing.canImport).toBe(false);
    expect(messages(missing, 'error').map(([sheet]) => sheet)).toEqual(['Students', 'Products', 'Settings', 'Tasks']);
    const { workbook } = buildSyntheticCrsWorkbook(NOW);
    workbook.Students = workbook.Students.map(row => row.slice(0, 2).concat(row.slice(3)));
    const columns = await plan(workbook);
    expect(messages(columns, 'error')).toContainEqual(['Students', 1, "'Students(학생)' 시트에 'balance' 열이 없어요."]);
  });

  it('falls back to safe defaults for unusable settings and drops references to missing rows', async () => {
    const { workbook } = buildSyntheticCrsWorkbook(NOW);
    workbook.Settings = [['key', 'value'], ['schemaVersion', '1'], ['themeColor', 'rainbow'], ['currencyUnit', 'x'.repeat(30)],
      ['classTimeZone', 'America/New_York']];
    workbook.Tasks[1][9] = 'S01,S02,S03,S99';
    workbook.Tasks[3][31] = 'T-GONE';
    const result = await plan(workbook);
    expect(result.canImport).toBe(true);
    expect(result.settings).toEqual({ currencyUnit: '원', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white',
      fontFamily: 'default', qrManualInputEnabled: false });
    const warnings = messages(result, 'warning');
    expect(warnings).toContainEqual(['Tasks', 2, '부여 학생 목록에 학생 시트에 없는 학생 1명이 있어 뺐어요.']);
    expect(warnings).toContainEqual(['Tasks', 4, "선행 과제 'T-GONE'를 과제 시트에서 찾을 수 없어 선행 과제 없이 옮겨요."]);
    expect(warnings).toContainEqual(['Settings', 5, '학급 시간대는 한국 시간(Asia/Seoul)으로 옮겨요.']);
    expect(result.tasks.find(task => task.taskId === 'TC')?.prerequisiteTaskId).toBeNull();
  });

  it('drops a prerequisite that is hidden while its dependent stays visible', async () => {
    const { workbook } = buildSyntheticCrsWorkbook(NOW);
    workbook.Tasks[1][5] = 'FALSE';
    workbook.Tasks[3][5] = 'TRUE';
    const result = await plan(workbook);
    expect(result.tasks.find(task => task.taskId === 'TC')?.prerequisiteTaskId).toBeNull();
    expect(messages(result, 'warning')).toContainEqual(['Tasks', 4, "선행 과제 'TA'가 숨김 상태라 선행 과제 없이 옮겨요."]);
  });
});
