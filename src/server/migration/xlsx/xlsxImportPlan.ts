import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { projectTaskCycleState } from '@/domain/taskCycleState';
import { resolveTaskSchedule } from '@/domain/taskSchedule';
import type { ClassTask, StudentStatus, TaskAssignment, TaskCompletion, TaskRecurrence, TaskSchedule } from '@/domain/types';
import { FONT_FAMILY_OPTIONS, type FontFamily } from '@/lib/fontSettings';
import {
  createHeaderIndex, parseAllowedStudentIds, parseTaskAssignmentRow, parseTaskCompletionRow, parseTaskRow,
} from '@/server/sheetsRows';
import type { PromotionAdminDefinitionInput } from '@/server/repositories/database/promotionCommands';
import { captureOfflineSheetsBaseline } from '../sheetsSnapshot';
import { normalizeLegacySnapshots } from '../normalize';
import { canonicalJson } from '../validators';
import type { XlsxWorkbookGrid } from './xlsxWorkbook';

/** One line of the preview's warning/error list (Korean, with a sheet/row reference). */
export type XlsxImportIssue = Readonly<{
  level: 'error' | 'warning';
  sheet: string | null;
  row: number | null;
  message: string;
}>;

export const THEME_COLORS = ['blue', 'pink', 'yellow', 'green', 'purple', 'white', 'black', 'navy'] as const;
export type XlsxSettingsPlan = Readonly<{
  currencyUnit: string; appTitle: string; bankTitle: string; themeColor: typeof THEME_COLORS[number];
  fontFamily: FontFamily; qrManualInputEnabled: boolean;
}>;
export type XlsxStudentPlan = Readonly<{ studentId: string; name: string; balance: number; status: StudentStatus }>;
export type XlsxProductPlan = Readonly<{
  productId: string; name: string; price: number; stock: number; isActive: boolean;
  imageUrl?: string; category?: string; sortOrder: number;
}>;
export type XlsxPromotionPlan = Readonly<{ promotionId: string; definition: PromotionAdminDefinitionInput; productIds: string[] }>;
export type XlsxTaskPlan = Readonly<{
  taskId: string; title: string; description: string; reward: number; isActive: boolean; sortOrder: number;
  availableFrom: string | null; dueAt: string | null; prerequisiteTaskId: string | null; padletBoardId: string | null;
  schedule: Readonly<{ recurrence: TaskRecurrence; timeZone: 'Asia/Seoul'; resetCompletionOnCycle: boolean; resetAssignmentOnCycle: boolean }>;
  /** Current cycle, assigned and not completed: 완료 가능. */
  readyStudentIds: string[];
  /** Current cycle, completed (marked by the administrator command, no new reward). */
  completedStudentIds: string[];
  /** Completed students the sheet no longer assigns: unassigned again after the completion mark. */
  completedUnassignedStudentIds: string[];
}>;
export type XlsxImportSummary = Readonly<{
  students: number; activeStudents: number; totalBalance: number;
  products: number; activeProducts: number; totalStock: number;
  promotions: number; tasks: number; activeTasks: number;
  readyAssignments: number; completedAssignments: number;
  history: Readonly<{ transactions: number; adjustments: number; taskAssignments: number; taskCompletions: number }>;
  settings: XlsxSettingsPlan;
}>;
export type XlsxImportPlan = Readonly<{
  fileDigest: string;
  settings: XlsxSettingsPlan;
  students: readonly XlsxStudentPlan[];
  products: readonly XlsxProductPlan[];
  promotions: readonly XlsxPromotionPlan[];
  /** Creation order: every prerequisite precedes its dependents. */
  tasks: readonly XlsxTaskPlan[];
  summary: XlsxImportSummary;
  issues: readonly XlsxImportIssue[];
  canImport: boolean;
}>;

const TIME_ZONE = 'Asia/Seoul';
const HISTORY_TABS = ['Transactions', 'Adjustments', 'TaskAssignments', 'TaskCompletions'] as const;
const DEFINITION_TABS = ['Students', 'Products', 'Settings', 'Tasks', 'Promotions', 'PromotionProducts'] as const;
const REQUIRED_TABS = ['Students', 'Products', 'Settings', 'Tasks'] as const;
const TAB_LABELS: Record<string, string> = {
  Students: '학생', Products: '상품', Settings: '설정', Tasks: '과제', Promotions: '행사', PromotionProducts: '행사 상품',
  Transactions: '거래 내역', Adjustments: '지급·회수 내역', TaskAssignments: '과제 부여 기록', TaskCompletions: '과제 완료 기록',
};
// Placeholder headers: history is not imported, so its rows never reach the definition normalizer.
const TRANSACTION_HEADERS = ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'];
const ADJUSTMENT_HEADERS = ['adjustmentId', 'timestamp', 'studentId', 'amount', 'mode', 'operator'];
// Every header any CRS Sheets version wrote for the imported tabs; others are reported as ignored.
const KNOWN_HEADERS: Record<string, readonly string[]> = {
  Students: ['studentId', 'name', 'balance', 'status'],
  Products: ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'],
  Settings: ['key', 'value'],
  Tasks: ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'createdAt', 'updatedAt',
    'allowedStudentIds', 'taskInstanceId', 'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone', 'recurrenceType',
    'recurrenceTime', 'recurrenceWeekday', 'recurrenceDayOfMonth', 'resetCompletionOnCycle', 'resetAssignmentOnCycle',
    'pendingRuleVersion', 'pendingEffectiveFrom', 'pendingTimeZone', 'pendingRecurrenceType', 'pendingRecurrenceTime',
    'pendingRecurrenceWeekday', 'pendingRecurrenceDayOfMonth', 'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle',
    'availableFrom', 'dueAt', 'prerequisiteTaskId', 'recurrenceWeekdays', 'pendingRecurrenceWeekdays', 'padletBoardId'],
  Promotions: ['promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity', 'startsAt', 'endsAt',
    'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion'],
  PromotionProducts: ['promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion'],
};
const BOOLEAN_COLUMNS = new Set(['isActive', 'resetCompletionOnCycle', 'resetAssignmentOnCycle',
  'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle']);
const INSTANT_COLUMNS = ['createdAt', 'updatedAt', 'availableFrom', 'dueAt', 'startsAt', 'endsAt'];
const LOOSE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const PADLET_BOARD_ID = /^[A-Za-z0-9]{16,22}$/;
// Identifiers travel in cycle IDs ("v1|…") and admin command targets, which forbid '|' and controls.
const UNSAFE_ID = /[\u0000-\u001f\u007f|]/;
const MAX_ISSUES = 200;
const DEFAULT_SETTINGS: XlsxSettingsPlan = { currencyUnit: '원', appTitle: '학급 매점', bankTitle: '학급 은행',
  themeColor: 'white', fontFamily: 'default', qrManualInputEnabled: false };
const SETTING_LABELS: Record<string, string> = { currencyUnit: '화폐 단위', appTitle: '매점 제목', bankTitle: '은행 제목',
  themeColor: '테마 색상', fontFamily: '글꼴', qrManualInputEnabled: 'QR 값 직접 입력' };

type TabRow = { cells: string[]; sourceRow: number };

class Issues {
  readonly list: XlsxImportIssue[] = [];
  private overflow = 0;
  add(level: XlsxImportIssue['level'], sheet: string | null, row: number | null, message: string) {
    if (this.list.some(issue => issue.level === level && issue.sheet === sheet && issue.row === row && issue.message === message)) return;
    if (this.list.length >= MAX_ISSUES) { this.overflow += 1; return; }
    this.list.push({ level, sheet, row, message });
  }
  error(sheet: string | null, row: number | null, message: string) { this.add('error', sheet, row, message); }
  warning(sheet: string | null, row: number | null, message: string) { this.add('warning', sheet, row, message); }
  get hasErrors() { return this.list.some(issue => issue.level === 'error'); }
  result(): XlsxImportIssue[] {
    const sorted = [...this.list].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1)
      || sheetOrder(a.sheet) - sheetOrder(b.sheet) || (a.row ?? 0) - (b.row ?? 0));
    if (this.overflow) sorted.push({ level: 'warning', sheet: null, row: null, message: `그 밖에 ${this.overflow}건의 안내가 더 있어요.` });
    return sorted;
  }
}

function sheetOrder(sheet: string | null): number {
  const order = [...DEFINITION_TABS, ...HISTORY_TABS] as readonly string[];
  const index = sheet === null ? -1 : order.indexOf(sheet);
  return index < 0 ? (sheet === null ? -1 : order.length) : index;
}

function label(sheet: string): string {
  return TAB_LABELS[sheet] ? `${sheet}(${TAB_LABELS[sheet]})` : sheet;
}

function isBlankRow(row: readonly string[]): boolean {
  return !row.some(cell => cell.trim());
}

function koreanTime(instant: string): string {
  try {
    const local = Temporal.Instant.from(instant).toZonedDateTimeISO(TIME_ZONE);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${local.year}-${pad(local.month)}-${pad(local.day)} ${pad(local.hour)}:${pad(local.minute)}`;
  } catch { return instant; }
}

function canonicalLooseInstant(value: string): string | null {
  if (!LOOSE_INSTANT.test(value)) return null;
  try { return new Date(Temporal.Instant.from(value).epochMilliseconds).toISOString(); } catch { return null; }
}

function isCanonicalInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function headerIndexOf(headers: readonly string[], name: string): number {
  return headers.findIndex(header => header.trim() === name);
}

function readTab(grid: XlsxWorkbookGrid, tab: string): { headers: string[]; rows: TabRow[] } | null {
  const table = grid.tabs[tab];
  if (!table) return null;
  const [headers = [], ...data] = table;
  return {
    headers: [...headers],
    rows: data.flatMap((cells, index) => isBlankRow(cells) ? [] : [{ cells: [...cells], sourceRow: index + 2 }]),
  };
}

function dedupeSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** Integer text as CRS validators accept it. */
function isIntegerText(value: string, min = Number.MIN_SAFE_INTEGER): boolean {
  if (!/^-?(0|[1-9][0-9]*)$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min;
}

/** Field-level reasons for a definition row the shared normalizer rejected. */
function describeRowProblems(tab: string, headers: readonly string[], cells: readonly string[]): string[] {
  const cell = (name: string) => {
    const index = headerIndexOf(headers, name);
    return index < 0 ? '' : (cells[index] ?? '');
  };
  const problems: string[] = [];
  const id = (name: string, what: string) => {
    const value = cell(name);
    if (!value) problems.push(`${what}(${name})이 비어 있어요`);
    else if (value !== value.trim()) problems.push(`${what}(${name}) 앞뒤에 빈칸이 있어요`);
  };
  const integer = (name: string, what: string, min?: number) => {
    if (!isIntegerText(cell(name), min)) problems.push(`${what}(${name})은 ${min === 0 ? '0 이상의 ' : ''}정수여야 해요`);
  };
  const bool = (name: string, what: string) => {
    if (!['TRUE', 'FALSE'].includes(cell(name))) problems.push(`${what}(${name})은 TRUE 또는 FALSE여야 해요`);
  };
  const instant = (name: string, what: string, optional: boolean) => {
    const value = cell(name);
    if (optional && !value) return;
    if (!isCanonicalInstant(value)) problems.push(`${what}(${name})의 날짜·시간 형식을 읽지 못했어요`);
  };
  if (tab === 'Students') {
    id('studentId', '학생 ID');
    if (!cell('name').trim()) problems.push('이름(name)이 비어 있어요');
    integer('balance', '잔액');
    if (!['ACTIVE', 'INACTIVE'].includes(cell('status'))) problems.push('상태(status)는 ACTIVE 또는 INACTIVE여야 해요');
  } else if (tab === 'Products') {
    id('productId', '상품 ID');
    if (!cell('name').trim()) problems.push('상품명(name)이 비어 있어요');
    integer('price', '가격', 0); integer('stock', '재고', 0); bool('isActive', '판매 여부'); integer('sortOrder', '정렬');
  } else if (tab === 'Tasks') {
    id('taskId', '과제 ID');
    if (!cell('title').trim()) problems.push('과제명(title)이 비어 있어요');
    integer('reward', '보상', 0); bool('isActive', '공개 여부'); integer('sortOrder', '정렬');
    instant('createdAt', '만든 시각', false); instant('updatedAt', '고친 시각', false);
    instant('availableFrom', '시작 시각', true); instant('dueAt', '기한', true);
    const from = cell('availableFrom'), due = cell('dueAt');
    if (from && due && isCanonicalInstant(from) && isCanonicalInstant(due) && Date.parse(due) <= Date.parse(from)) {
      problems.push('기한(dueAt)이 시작 시각(availableFrom)보다 늦어야 해요');
    }
    if (!problems.length) problems.push('반복 설정(recurrence…, reset… 열)을 읽지 못했어요');
  } else if (tab === 'Promotions') {
    id('promotionId', '행사 ID');
    if (!cell('name').trim()) problems.push('행사명(name)이 비어 있어요');
    if (!['N_PLUS_ONE', 'PROMOTIONAL_PRICE', 'PERCENT_DISCOUNT', 'FIXED_DISCOUNT'].includes(cell('type'))) {
      problems.push('행사 종류(type)를 알 수 없어요');
    }
    instant('startsAt', '시작', false); instant('endsAt', '끝', false); bool('isActive', '진행 여부');
    if (!problems.length) problems.push('할인 값(value, buyQuantity, freeQuantity)을 확인해 주세요');
  } else if (tab === 'PromotionProducts') {
    id('promotionProductId', '연결 ID'); id('promotionId', '행사 ID'); id('productId', '상품 ID');
    instant('createdAt', '만든 시각', false);
    if (cell('schemaVersion') !== '3') problems.push('schemaVersion은 3이어야 해요');
  }
  return problems;
}

const CODE_MESSAGES: Record<string, string> = {
  DUPLICATE_PRIMARY_ID: '같은 ID가 다른 행에도 있어요. ID는 한 번씩만 써 주세요.',
  DUPLICATE_BUSINESS_ID: '같은 ID가 다른 행에도 있어요. ID는 한 번씩만 써 주세요.',
  DUPLICATE_SETTING_KEY: '같은 설정 이름(key)이 두 번 있어요. 하나만 남겨 주세요.',
  DUPLICATE_ALLOWED_STUDENT_ID: '부여 학생 목록(allowedStudentIds)에 같은 학생이 두 번 있어요.',
  SELF_TASK_REFERENCE: '선행 과제(prerequisiteTaskId)가 자기 자신이에요.',
  CYCLIC_TASK_PREREQUISITE: '선행 과제(prerequisiteTaskId)가 서로를 가리키고 있어요.',
  BROKEN_ALLOWED_STUDENT_REFERENCE: '부여 학생 목록(allowedStudentIds)에 학생 시트에 없는 학생이 있어요.',
  BROKEN_TASK_REFERENCE: '선행 과제(prerequisiteTaskId)를 찾을 수 없어요.',
  BROKEN_PRODUCT_REFERENCE: '상품 시트에 없는 상품이에요.',
  BROKEN_PROMOTION_REFERENCE: '행사 시트에 없는 행사예요.',
  INVALID_SCHEMA_VERSION_SETTING: '설정의 schemaVersion 값을 확인해 주세요.',
  INVALID_CLASS_TIME_ZONE_SETTING: '설정의 classTimeZone 값을 확인해 주세요.',
  INVALID_HEADER: '이 시트의 첫 줄(열 이름)을 확인해 주세요.',
};

function settingsFrom(rows: readonly TabRow[], keyIndex: number, valueIndex: number, issues: Issues): XlsxSettingsPlan {
  const values = new Map<string, { value: string; row: number }>();
  for (const row of rows) {
    const key = (row.cells[keyIndex] ?? '').trim();
    if (key && !values.has(key)) values.set(key, { value: (row.cells[valueIndex] ?? '').trim(), row: row.sourceRow });
  }
  const text = (key: 'currencyUnit' | 'appTitle' | 'bankTitle', max: number) => {
    const found = values.get(key);
    if (!found) return DEFAULT_SETTINGS[key];
    const value = found.value;
    if (!value || value.length > max || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
      issues.warning('Settings', found.row, `${SETTING_LABELS[key]}(${key}) 값을 쓸 수 없어 기본값 '${DEFAULT_SETTINGS[key]}'으로 정했어요. (${max}자 이하)`);
      return DEFAULT_SETTINGS[key];
    }
    return value;
  };
  const theme = values.get('themeColor');
  const themeColor = theme && (THEME_COLORS as readonly string[]).includes(theme.value)
    ? theme.value as XlsxSettingsPlan['themeColor'] : DEFAULT_SETTINGS.themeColor;
  if (theme && themeColor !== theme.value) issues.warning('Settings', theme.row, `${SETTING_LABELS.themeColor}(themeColor) '${theme.value}'은 쓸 수 없어 파랑으로 정했어요.`);
  const font = values.get('fontFamily');
  const fontFamily = font && FONT_FAMILY_OPTIONS.some(option => option.value === font.value)
    ? font.value as FontFamily : DEFAULT_SETTINGS.fontFamily;
  if (font && font.value && fontFamily !== font.value) issues.warning('Settings', font.row, `${SETTING_LABELS.fontFamily}(fontFamily) '${font.value}'은 쓸 수 없어 기본 글꼴로 정했어요.`);
  const qr = values.get('qrManualInputEnabled');
  const qrValue = qr?.value.toUpperCase();
  if (qr && qrValue !== 'TRUE' && qrValue !== 'FALSE' && qr.value) {
    issues.warning('Settings', qr.row, `${SETTING_LABELS.qrManualInputEnabled}(qrManualInputEnabled)은 TRUE/FALSE만 쓸 수 있어 '끔'으로 정했어요.`);
  }
  return {
    currencyUnit: text('currencyUnit', 20), appTitle: text('appTitle', 80), bankTitle: text('bankTitle', 80),
    themeColor, fontFamily, qrManualInputEnabled: qrValue === 'TRUE',
  };
}

function promotionDefinition(record: Readonly<Record<string, unknown>>): PromotionAdminDefinitionInput | null {
  const common = {
    name: String(record.name ?? ''), description: String(record.description ?? ''),
    startsAt: String(record.startsAt ?? ''), endsAt: String(record.endsAt ?? ''),
    isActive: record.isActive === true, sortOrder: Number(record.sortOrder ?? 0),
  };
  if (!common.name.trim() || !Number.isSafeInteger(common.sortOrder)
    || !(Date.parse(common.startsAt) < Date.parse(common.endsAt))) return null;
  const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  switch (record.type) {
    case 'N_PLUS_ONE':
      return positive(record.buyQuantity) && positive(record.freeQuantity)
        ? { ...common, type: 'N_PLUS_ONE', buyQuantity: record.buyQuantity as number, freeQuantity: record.freeQuantity as number } : null;
    case 'PROMOTIONAL_PRICE':
      return typeof record.promotionalUnitPrice === 'number' && Number.isSafeInteger(record.promotionalUnitPrice) && record.promotionalUnitPrice >= 0
        ? { ...common, type: 'PROMOTIONAL_PRICE', promotionalUnitPrice: record.promotionalUnitPrice } : null;
    case 'PERCENT_DISCOUNT':
      return typeof record.percent === 'number' && Number.isFinite(record.percent) && record.percent > 0 && record.percent <= 100
        ? { ...common, type: 'PERCENT_DISCOUNT', percent: record.percent } : null;
    case 'FIXED_DISCOUNT':
      return positive(record.discountAmount) ? { ...common, type: 'FIXED_DISCOUNT', discountAmount: record.discountAmount as number } : null;
    default:
      return null;
  }
}

function asSchedule(value: unknown): TaskSchedule | null {
  if (!value || typeof value !== 'object') return null;
  return value as TaskSchedule;
}

function scheduleText(schedule: TaskSchedule): string {
  const recurrence = schedule.recurrence;
  if (recurrence.type === 'NONE') return '반복 없음';
  if (recurrence.type === 'DAILY') return `매일 ${recurrence.time}`;
  if (recurrence.type === 'WEEKLY') return `매주 ${recurrence.weekdays.map(day => '월화수목금토일'[day - 1]).join('·')} ${recurrence.time}`;
  return `매월 ${recurrence.dayOfMonth}일 ${recurrence.time}`;
}

/**
 * Reads the uploaded workbook's CURRENT state with the shared Sheets migration parsers:
 * definition tabs go through the same snapshot capture and normalizer the full migration uses
 * (history tabs reduced to headers, as the full-snapshot definition projection does), and the
 * current task cycle is projected with the same function the Sheets app used to display it.
 */
export async function buildXlsxImportPlan(grid: XlsxWorkbookGrid, options: Readonly<{ now: string; fileDigest: string }>): Promise<XlsxImportPlan> {
  const issues = new Issues();
  const now = new Date(options.now).toISOString();
  const missing = REQUIRED_TABS.filter(tab => !grid.tabs[tab]);
  for (const tab of missing) issues.error(tab, null, `'${label(tab)}' 시트가 없어요. 예전 학급 보상 시스템 구글 시트를 통째로 .xlsx로 저장했는지 확인해 주세요.`);
  for (const name of grid.sheetNames) {
    if (!(DEFINITION_TABS as readonly string[]).includes(name) && !(HISTORY_TABS as readonly string[]).includes(name)) {
      issues.warning(name, null, `'${name}' 시트는 학급 보상 시스템 시트가 아니라서 옮기지 않아요.`);
    }
  }
  const historyCounts = {
    transactions: readTab(grid, 'Transactions')?.rows.length ?? 0,
    adjustments: readTab(grid, 'Adjustments')?.rows.length ?? 0,
    taskAssignments: readTab(grid, 'TaskAssignments')?.rows.length ?? 0,
    taskCompletions: readTab(grid, 'TaskCompletions')?.rows.length ?? 0,
  };
  const emptyPlan = (settings: XlsxSettingsPlan = DEFAULT_SETTINGS): XlsxImportPlan => ({
    fileDigest: options.fileDigest, settings, students: [], products: [], promotions: [], tasks: [],
    summary: { students: 0, activeStudents: 0, totalBalance: 0, products: 0, activeProducts: 0, totalStock: 0,
      promotions: 0, tasks: 0, activeTasks: 0, readyAssignments: 0, completedAssignments: 0, history: historyCounts, settings },
    issues: issues.result(), canImport: false,
  });
  if (missing.length) return emptyPlan();

  for (const note of grid.notes) {
    const tab = note.sheet;
    if (!(DEFINITION_TABS as readonly string[]).includes(tab)) continue;
    const header = (grid.tabs[tab]?.[0]?.[note.column - 1] ?? '').trim() || `${note.column}번째`;
    const value = grid.tabs[tab]?.[note.row - 1]?.[note.column - 1] ?? '';
    if (note.kind === 'ERROR') issues.error(tab, note.row, `'${header}' 칸에 오류 값(${value || '#ERROR'})이 있어요. 값을 고친 뒤 다시 저장해 주세요.`);
    else if (note.kind === 'DATE') issues.warning(tab, note.row, `'${header}' 칸의 날짜를 한국 시간 ${koreanTime(value)}로 읽었어요.`);
  }

  // ---- Definition projection (mirrors the full-snapshot definition slice) ----
  const tables: Record<string, { headers: string[]; rows: TabRow[] }> = {};
  for (const tab of DEFINITION_TABS) {
    const table = readTab(grid, tab);
    if (!table) continue;
    const known = new Set(KNOWN_HEADERS[tab]);
    table.headers.forEach((header, index) => {
      const name = header.trim();
      if (name && !known.has(name)) issues.warning(tab, 1, `'${label(tab)}' 시트의 '${name}' 열은 새 학급 보상 시스템에서 쓰지 않아 옮기지 않아요.`);
      // Students column E may hold the old writer's exact duplicate of the status (handled below).
      const duplicateStatus = tab === 'Students' && index === 4 && headerIndexOf(table.headers, 'status') === 3
        && table.rows.every(row => !row.cells[4] || row.cells[4] === row.cells[3]);
      if (!name && !duplicateStatus && table.rows.some(row => (row.cells[index] ?? '').trim())) {
        issues.warning(tab, 1, `'${label(tab)}' 시트 ${index + 1}번째 열에 이름이 없어 옮기지 않아요.`);
      }
    });
    for (const row of table.rows) {
      for (const [index, header] of table.headers.entries()) {
        const name = header.trim(), value = row.cells[index] ?? '';
        if (BOOLEAN_COLUMNS.has(name) && /^(true|false)$/i.test(value) && value !== value.toUpperCase()) row.cells[index] = value.toUpperCase();
        if (INSTANT_COLUMNS.includes(name) && value && !isCanonicalInstant(value)) {
          const canonical = canonicalLooseInstant(value.trim());
          if (canonical) row.cells[index] = canonical;
        }
      }
    }
    tables[tab] = table;
  }
  // An older Students writer kept a duplicate status in column E; only that exact duplicate is admitted.
  const students = tables.Students;
  if (headerIndexOf(students.headers, 'status') === 3) {
    for (const row of students.rows) {
      if (row.cells[4] && row.cells[4] === row.cells[3] && !row.cells.slice(5).some(Boolean)) row.cells[4] = '';
    }
  }
  const studentIdIndex = headerIndexOf(students.headers, 'studentId');
  const knownStudentIds = new Set(studentIdIndex < 0 ? [] : students.rows.map(row => row.cells[studentIdIndex] ?? ''));
  const productIdIndex = headerIndexOf(tables.Products.headers, 'productId');
  const knownProductIds = new Set(productIdIndex < 0 ? [] : tables.Products.rows.map(row => row.cells[productIdIndex] ?? ''));
  const tasksTable = tables.Tasks;
  const taskIdIndex = headerIndexOf(tasksTable.headers, 'taskId');
  const knownTaskIds = new Set(taskIdIndex < 0 ? [] : tasksTable.rows.map(row => row.cells[taskIdIndex] ?? ''));
  // References to rows that no longer exist are dropped with a notice instead of blocking the class.
  const allowedIndex = headerIndexOf(tasksTable.headers, 'allowedStudentIds');
  const prerequisiteIndex = headerIndexOf(tasksTable.headers, 'prerequisiteTaskId');
  for (const row of tasksTable.rows) {
    if (allowedIndex >= 0 && row.cells[allowedIndex]) {
      const ids = parseAllowedStudentIds(row.cells[allowedIndex]);
      const kept = ids.filter(id => knownStudentIds.has(id));
      if (kept.length !== ids.length) {
        issues.warning('Tasks', row.sourceRow, `부여 학생 목록에 학생 시트에 없는 학생 ${ids.length - kept.length}명이 있어 뺐어요.`);
      }
      row.cells[allowedIndex] = kept.join(',');
    }
    if (prerequisiteIndex >= 0 && row.cells[prerequisiteIndex] && !knownTaskIds.has(row.cells[prerequisiteIndex])) {
      issues.warning('Tasks', row.sourceRow, `선행 과제 '${row.cells[prerequisiteIndex]}'를 과제 시트에서 찾을 수 없어 선행 과제 없이 옮겨요.`);
      row.cells[prerequisiteIndex] = '';
    }
  }
  const promotionsTable = tables.Promotions;
  const promotionIdIndex = promotionsTable ? headerIndexOf(promotionsTable.headers, 'promotionId') : -1;
  const knownPromotionIds = new Set(promotionIdIndex < 0 ? [] : promotionsTable!.rows.map(row => row.cells[promotionIdIndex] ?? ''));
  const links = tables.PromotionProducts;
  if (links) {
    const linkProduct = headerIndexOf(links.headers, 'productId'), linkPromotion = headerIndexOf(links.headers, 'promotionId');
    links.rows = links.rows.filter(row => {
      const productId = row.cells[linkProduct] ?? '', promotionId = row.cells[linkPromotion] ?? '';
      if (linkProduct >= 0 && linkPromotion >= 0 && (!knownProductIds.has(productId) || !knownPromotionIds.has(promotionId))) {
        issues.warning('PromotionProducts', row.sourceRow, `상품 '${productId}' 또는 행사 '${promotionId}'를 찾을 수 없어 이 행사 연결은 옮기지 않아요.`);
        return false;
      }
      return true;
    });
  }
  const settingsTable = tables.Settings;
  const keyIndex = headerIndexOf(settingsTable.headers, 'key'), valueIndex = headerIndexOf(settingsTable.headers, 'value');
  if (keyIndex < 0 || valueIndex < 0) {
    issues.error('Settings', 1, `'${label('Settings')}' 시트 첫 줄에 key, value 열이 있어야 해요.`);
    return emptyPlan();
  }
  const settingRows = settingsTable.rows;
  const settingKey = (row: TabRow) => (row.cells[keyIndex] ?? '').trim();
  const zone = settingRows.find(row => settingKey(row) === 'classTimeZone');
  if (zone && (zone.cells[valueIndex] ?? '').trim() !== TIME_ZONE) {
    issues.warning('Settings', zone.sourceRow, '학급 시간대는 한국 시간(Asia/Seoul)으로 옮겨요.');
    zone.cells[valueIndex] = TIME_ZONE;
  }
  const definitionTabs: Record<string, string[][]> = {};
  for (const [tab, table] of Object.entries(tables)) definitionTabs[tab] = [table.headers, ...table.rows.map(row => row.cells)];
  if (!zone) definitionTabs.Settings.push(Object.assign(Array<string>(settingsTable.headers.length).fill(''), { [keyIndex]: 'classTimeZone', [valueIndex]: TIME_ZONE }));
  if (!settingRows.some(row => settingKey(row) === 'schemaVersion')) {
    definitionTabs.Settings.push(Object.assign(Array<string>(settingsTable.headers.length).fill(''), { [keyIndex]: 'schemaVersion', [valueIndex]: '1' }));
  }
  definitionTabs.Transactions = [TRANSACTION_HEADERS];
  definitionTabs.Adjustments = [ADJUSTMENT_HEADERS];
  const width = (rows: string[][]) => Math.max(1, ...rows.map(row => row.length));
  for (const [tab, rows] of Object.entries(definitionTabs)) {
    const size = width(rows);
    definitionTabs[tab] = rows.map(row => [...row, ...Array<string>(Math.max(0, size - row.length)).fill('')]);
  }

  let normalized: ReturnType<typeof normalizeLegacySnapshots>;
  try {
    const snapshot = await captureOfflineSheetsBaseline({ spreadsheetId: 'xlsx-upload', capturedAt: now,
      contentSha256: createHash('sha256').update(canonicalJson(definitionTabs)).digest('hex'), tabs: definitionTabs });
    normalized = normalizeLegacySnapshots({ tenantId: '00000000-0000-4000-8000-000000000000', migrationJobId: 'xlsx-import', sheets: snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    issues.error(null, null, /schema version/i.test(message)
      ? "설정 시트의 schemaVersion 값은 1~4 중 하나여야 해요."
      : /exceeds|oversized|limit/i.test(message)
        ? '학생·상품·과제 시트의 내용이 너무 많아요.'
        : '학생·상품·설정·과제 시트의 형식을 읽지 못했어요. 첫 줄의 열 이름을 확인해 주세요.');
    return emptyPlan();
  }

  // Header and settings-level conflicts (no row pointer) of the imported tabs.
  for (const diagnostic of normalized.blockingConflicts) {
    const [tab] = diagnostic.path.split(/[.[]/, 1);
    if ((HISTORY_TABS as readonly string[]).includes(tab) || /\[\d+\]/.test(diagnostic.path)) continue;
    const column = diagnostic.path.slice(tab.length + 1).replace(/^headers\[(\d+)\]$/, (_m, n) => `${Number(n) + 1}번째 열`);
    if (diagnostic.code === 'MISSING_REQUIRED_COLUMN') issues.error(tab, 1, `'${label(tab)}' 시트에 '${column}' 열이 없어요.`);
    else if (diagnostic.code === 'DUPLICATE_HEADER') issues.error(tab, 1, `'${label(tab)}' 시트에 '${column}' 열이 두 번 있어요.`);
    else issues.error(tab, null, CODE_MESSAGES[diagnostic.code] ?? `'${label(tab)}' 시트를 확인해 주세요. (${diagnostic.code})`);
  }
  // Row-level problems, with the original row number of the uploaded sheet.
  for (const record of normalized.sourceRecords) {
    if (record.mappingStatus !== 'QUARANTINED' || record.source.kind !== 'SHEET') continue;
    const tab = record.source.tab;
    if ((HISTORY_TABS as readonly string[]).includes(tab)) continue;
    const table = tables[tab];
    const projected = table?.rows[record.source.rowNumber - 2];
    const sourceRow = projected?.sourceRow ?? null;
    for (const code of record.errorCodes) {
      if (code === 'MALFORMED_REQUIRED_RECORD' && projected) {
        const problems = describeRowProblems(tab, table.headers, projected.cells);
        issues.error(tab, sourceRow, problems.length ? `${problems.join(', ')}.` : '값을 읽지 못했어요. 빈칸과 형식을 확인해 주세요.');
      } else {
        issues.error(tab, sourceRow, CODE_MESSAGES[code] ?? `이 행을 옮길 수 없어요. (${code})`);
      }
    }
  }

  const records = normalized.records as Record<string, readonly Readonly<Record<string, unknown>>[]>;
  const balances = new Map((records.accounts ?? []).map(account => [String(account.studentId), Number(account.balance)]));
  const studentPlans: XlsxStudentPlan[] = (records.students ?? []).map(student => ({
    studentId: String(student.studentId), name: String(student.name).trim(),
    balance: balances.get(String(student.studentId)) ?? 0, status: student.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
  }));
  const rowOf = (table: { headers: string[]; rows: TabRow[] } | undefined, column: string, id: string) => {
    const index = table ? headerIndexOf(table.headers, column) : -1;
    return index < 0 ? null : table!.rows.find(row => row.cells[index] === id)?.sourceRow ?? null;
  };
  for (const student of studentPlans) {
    if (UNSAFE_ID.test(student.studentId)) issues.error('Students', rowOf(students, 'studentId', student.studentId), "학생 ID에는 '|' 기호를 쓸 수 없어요.");
  }
  const productPlans: XlsxProductPlan[] = (records.products ?? []).map(product => ({
    productId: String(product.productId), name: String(product.name).trim(), price: Number(product.price), stock: Number(product.stock),
    isActive: product.isActive === true, sortOrder: Number(product.sortOrder),
    ...(typeof product.imageUrl === 'string' && product.imageUrl.trim() ? { imageUrl: product.imageUrl.trim() } : {}),
    ...(typeof product.category === 'string' && product.category.trim() ? { category: product.category.trim() } : {}),
  }));
  for (const product of productPlans) {
    if (product.sortOrder < -2147483648 || product.sortOrder > 2147483647) {
      issues.error('Products', rowOf(tables.Products, 'productId', product.productId), '정렬(sortOrder) 값이 너무 커요.');
    }
  }
  const linkRecords = records.promotion_products ?? [];
  const promotionPlans: XlsxPromotionPlan[] = [];
  for (const promotion of records.promotions ?? []) {
    const promotionId = String(promotion.promotionId);
    const definition = promotionDefinition(promotion);
    if (!definition) {
      issues.error('Promotions', rowOf(promotionsTable, 'promotionId', promotionId), '행사 이름·기간(시작이 끝보다 빨라야 해요)·할인 값을 확인해 주세요.');
      continue;
    }
    promotionPlans.push({ promotionId, definition,
      productIds: dedupeSorted(linkRecords.filter(link => link.promotionId === promotionId).map(link => String(link.productId))) });
  }
  const settings = settingsFrom(settingRows, keyIndex, valueIndex, issues);

  // ---- Tasks and their current cycle, projected the way the Sheets app displayed them ----
  const activeStudentIds = new Set(studentPlans.filter(student => student.status === 'ACTIVE').map(student => student.studentId));
  const rawTasks = readTab(grid, 'Tasks')!;
  const rawTaskIndex = createHeaderIndex(rawTasks.headers.map(header => header.trim()));
  const parsedTasks = new Map<string, ClassTask>();
  for (const row of rawTasks.rows) {
    try {
      const task = parseTaskRow(row.cells, rawTaskIndex);
      if (task && !parsedTasks.has(task.taskId)) parsedTasks.set(task.taskId, task);
    } catch { /* reported by the normalizer */ }
  }
  const history = <T>(tab: 'TaskAssignments' | 'TaskCompletions', parse: (row: string[], index: ReturnType<typeof createHeaderIndex>) => T | null) => {
    const table = readTab(grid, tab);
    if (!table) return [] as T[];
    const index = createHeaderIndex(table.headers.map(header => header.trim()));
    let skipped = 0;
    const events = table.rows.flatMap(row => {
      let event: T | null = null;
      try { event = parse(row.cells, index); } catch { event = null; }
      if (!event) skipped += 1;
      return event ? [event] : [];
    });
    if (skipped) issues.warning(tab, null, `'${label(tab)}' 시트의 ${skipped}개 행은 읽지 못해 현재 과제 상태를 계산할 때 뺐어요.`);
    return events;
  };
  const assignments = history<TaskAssignment>('TaskAssignments', parseTaskAssignmentRow);
  const completions = history<TaskCompletion>('TaskCompletions', parseTaskCompletionRow);
  const padletIndex = headerIndexOf(tasksTable.headers, 'padletBoardId');
  const maxCompletionsIndex = headerIndexOf(tasksTable.headers, 'maxCompletionsPerStudent');
  const taskRecords = records.tasks ?? [];
  const activeByTaskId = new Map(taskRecords.map(task => [String(task.taskId), task.isActive === true]));
  let skippedInactiveStudents = 0;
  const taskPlans: XlsxTaskPlan[] = [];
  for (const record of taskRecords) {
    const taskId = String(record.taskId);
    const sourceRow = rowOf(tasksTable, 'taskId', taskId);
    const tableRow = tasksTable.rows.find(row => row.sourceRow === sourceRow);
    if (UNSAFE_ID.test(taskId)) { issues.error('Tasks', sourceRow, "과제 ID에는 '|' 기호를 쓸 수 없어요."); continue; }
    const current = asSchedule(record.currentSchedule);
    if (!current) { issues.error('Tasks', sourceRow, '반복 설정을 읽지 못했어요.'); continue; }
    const pending = asSchedule(record.pendingSchedule);
    let effective: TaskSchedule;
    try { effective = resolveTaskSchedule({ currentSchedule: current, pendingSchedule: pending, now }); } catch {
      issues.error('Tasks', sourceRow, '반복 설정을 읽지 못했어요.'); continue;
    }
    if (pending && effective !== pending) {
      issues.warning('Tasks', sourceRow, `예약된 반복 설정 변경(${scheduleText(pending)}, ${pending.effectiveFrom.slice(0, 10)}부터)은 옮기지 않아요. 필요하면 다시 설정해 주세요.`);
    }
    if (effective.timeZone !== TIME_ZONE) issues.warning('Tasks', sourceRow, '반복 시간은 한국 시간(Asia/Seoul) 기준으로 옮겨요.');
    let prerequisiteTaskId = typeof record.prerequisiteTaskId === 'string' && record.prerequisiteTaskId ? record.prerequisiteTaskId : null;
    if (prerequisiteTaskId && record.isActive === true && activeByTaskId.get(prerequisiteTaskId) !== true) {
      issues.warning('Tasks', sourceRow, `선행 과제 '${prerequisiteTaskId}'가 숨김 상태라 선행 과제 없이 옮겨요.`);
      prerequisiteTaskId = null;
    }
    let padletBoardId: string | null = null;
    const padletCell = padletIndex >= 0 && tableRow ? (tableRow.cells[padletIndex] ?? '').trim() : '';
    if (padletCell) {
      if (PADLET_BOARD_ID.test(padletCell)) padletBoardId = padletCell;
      else issues.warning('Tasks', sourceRow, '패들렛 보드 ID(padletBoardId)를 읽지 못해 연결하지 않았어요.');
    }
    const maxCompletions = maxCompletionsIndex >= 0 && tableRow ? (tableRow.cells[maxCompletionsIndex] ?? '').trim() : '';
    if (maxCompletions && maxCompletions !== '1') {
      issues.warning('Tasks', sourceRow, '새 학급 보상 시스템에서는 과제를 회차마다 한 번씩 완료할 수 있어요. (maxCompletionsPerStudent는 옮기지 않아요)');
    }
    const ready = new Set<string>(), completed = new Set<string>(), completedUnassigned = new Set<string>();
    const parsed = parsedTasks.get(taskId);
    let projected = false;
    if (parsed?.taskInstanceId && parsed.schedule) {
      try {
        const state = projectTaskCycleState({ task: parsed, now, assignments, completions });
        for (const [studentId, student] of Object.entries(state.students)) {
          if (!student.assigned && !student.completed) continue;
          if (!activeStudentIds.has(studentId)) { skippedInactiveStudents += 1; continue; }
          if (student.completed) {
            completed.add(studentId);
            if (!student.assigned) completedUnassigned.add(studentId);
          } else ready.add(studentId);
        }
        projected = true;
      } catch { projected = false; }
    }
    if (!projected) {
      const allowed = Array.isArray(record.allowedStudentIds) ? record.allowedStudentIds.map(String) : [];
      for (const studentId of allowed) {
        if (activeStudentIds.has(studentId)) ready.add(studentId); else skippedInactiveStudents += 1;
      }
      issues.warning('Tasks', sourceRow, '이번 회차의 완료 기록을 계산하지 못해 부여 학생만 옮겨요.');
    }
    taskPlans.push({
      taskId, title: String(record.title).trim(), description: String(record.description ?? '').trim(),
      reward: Number(record.reward), isActive: record.isActive === true, sortOrder: Number(record.sortOrder),
      availableFrom: typeof record.availableFrom === 'string' ? record.availableFrom : null,
      dueAt: typeof record.dueAt === 'string' ? record.dueAt : null,
      prerequisiteTaskId, padletBoardId,
      schedule: { recurrence: effective.recurrence, timeZone: TIME_ZONE,
        resetCompletionOnCycle: effective.resetCompletionOnCycle, resetAssignmentOnCycle: effective.resetAssignmentOnCycle },
      readyStudentIds: dedupeSorted(ready), completedStudentIds: dedupeSorted(completed),
      completedUnassignedStudentIds: dedupeSorted(completedUnassigned),
    });
  }
  if (skippedInactiveStudents) {
    issues.warning('Tasks', null, `비활성이거나 학생 시트에 없는 학생의 과제 상태 ${skippedInactiveStudents}건은 옮기지 않아요.`);
  }
  for (const task of taskPlans) {
    if (task.sortOrder < -2147483648 || task.sortOrder > 2147483647) issues.error('Tasks', rowOf(tasksTable, 'taskId', task.taskId), '정렬(sortOrder) 값이 너무 커요.');
  }
  // Creation order: prerequisites first (cycles were already rejected by the normalizer).
  const ordered: XlsxTaskPlan[] = [];
  const byId = new Map(taskPlans.map(task => [task.taskId, task]));
  const visit = (task: XlsxTaskPlan, depth: number) => {
    if (ordered.includes(task) || depth > taskPlans.length) return;
    const prerequisite = task.prerequisiteTaskId ? byId.get(task.prerequisiteTaskId) : undefined;
    if (prerequisite) visit(prerequisite, depth + 1);
    if (!ordered.includes(task)) ordered.push(task);
  };
  for (const task of taskPlans) visit(task, 0);

  const summary: XlsxImportSummary = {
    students: studentPlans.length, activeStudents: studentPlans.filter(s => s.status === 'ACTIVE').length,
    totalBalance: studentPlans.reduce((sum, s) => sum + s.balance, 0),
    products: productPlans.length, activeProducts: productPlans.filter(p => p.isActive).length,
    totalStock: productPlans.reduce((sum, p) => sum + p.stock, 0),
    promotions: promotionPlans.length, tasks: ordered.length, activeTasks: ordered.filter(t => t.isActive).length,
    readyAssignments: ordered.reduce((sum, t) => sum + t.readyStudentIds.length, 0),
    completedAssignments: ordered.reduce((sum, t) => sum + t.completedStudentIds.length, 0),
    history: historyCounts, settings,
  };
  if (!studentPlans.length && !issues.hasErrors) issues.error('Students', null, "학생 시트에 학생이 한 명도 없어요.");
  const historyRows = historyCounts.transactions + historyCounts.adjustments + historyCounts.taskAssignments + historyCounts.taskCompletions;
  if (historyRows) {
    issues.warning(null, null, '잔액은 그대로 옮기고, 이전 거래·과제 기록은 옮기지 않아요. 이전 기록은 올린 원본 파일에 그대로 남아 있어요.');
  }
  return {
    fileDigest: options.fileDigest, settings, students: studentPlans, products: productPlans, promotions: promotionPlans,
    tasks: ordered, summary, issues: issues.result(), canImport: !issues.hasErrors,
  };
}
