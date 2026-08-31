'use client';

/* eslint-disable @next/next/no-img-element */

import { FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import type { ClassTask, Product, Student, TaskAssignmentStatus, TaskAssignmentStudentStatus } from '@/domain/types';
import { SettingsForm } from './SettingsForm';
import { QrScanner } from './QrScanner';
import { TransactionsPanel } from './TransactionsPage';
import { getFontFamilyCss, type FontFamily } from '@/lib/fontSettings';
import { normalizeAdminTask, resolveEffectiveAdminTaskSchedule, scheduleDtoToForm, scheduleFormToPayload, type NormalizedAdminTask, type TaskRecurrenceForm } from './taskRecurrenceEditor';
import { TaskRecurrenceFields, TaskScheduleProjection } from './tasks/TaskRecurrenceFields';
import { TaskHistoryDialog, type TaskHistoryDialogState } from './tasks/TaskHistoryDialog';
import { createTaskDialogTarget, taskTargetSummary, type TaskDialogTarget } from './tasks/taskTargetSummary';
import { normalizeTaskAssignmentStatus, reconcileTaskAssignmentProjection } from './taskAssignmentProjection';
import { PromotionAdminPanel } from './promotions/PromotionAdminPanel';
import { normalizeThemeColor, themeStyles, type ThemeColor } from './uiTheme';
import { classifyTaskAvailability } from '@/domain/taskAvailability';

type StudentDraft = Student;
type ProductDraft = Product;
type TaskDraft = NormalizedAdminTask;
type AdminTab = 'settings' | 'students' | 'products' | 'tasks' | 'transactions' | 'currency';
type StoreTab = 'inventory' | 'promotions';
type BulkMode = 'set' | 'add' | 'subtract';
type CurrencyMode = 'add' | 'subtract';

type Settings = { currencyUnit?: string; appTitle?: string; bankTitle?: string; themeColor?: ThemeColor; fontFamily?: FontFamily; qrManualInputEnabled?: boolean };
const disabledActionClass = 'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none';
const storeTabs: StoreTab[] = ['inventory', 'promotions'];
type CurrencyResult = {
  status: 'success' | 'failure';
  mode: CurrencyMode;
  studentId: string;
  amount: number;
  message: string;
};

type QrTaskAssignmentResult = {
  status: 'success' | 'failure';
  taskId: string;
  message: string;
};


type NewStudentDraft = {
  studentId: string;
  name: string;
  balance: number;
  status: Student['status'];
};

type NewProductDraft = {
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  imageUrl: string;
  category: string;
  sortOrder: number;
};

const EMPTY_STUDENT: NewStudentDraft = { studentId: '', name: '', balance: 0, status: 'ACTIVE' };
const EMPTY_PRODUCT: NewProductDraft = { name: '', price: 0, stock: 0, isActive: true, imageUrl: '', category: '', sortOrder: 1 };
const EMPTY_TASK: Omit<TaskDraft, 'taskId'> = { title: '', description: '', reward: 0, isActive: true, sortOrder: 1, allowedStudentIds: [] };

function isoToSeoulLocal(value?: string) {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function seoulLocalToIso(value: string) {
  return value ? new Date(`${value}:00+09:00`).toISOString() : '';
}

function taskAvailabilityLabel(task: TaskDraft) {
  if (!task.isActive) return '수동 비활성';
  const state = classifyTaskAvailability(task);
  return state === 'UPCOMING' ? '시작 전' : state === 'EXPIRED' ? '기한 만료' : '진행 중';
}

function reconcileTaskProjections(
  current: TaskDraft[],
  serverRows: TaskDraft[],
  targetTaskIds: string[],
  freshTaskIds: string[] = [],
): TaskDraft[] {
  const currentById = new Map(current.map((task) => [task.taskId, task]));
  const targetIds = new Set(targetTaskIds);
  const freshIds = new Set(freshTaskIds);

  return serverRows.map((row) => {
    const serverTask = normalizeAdminTask(row);
    const localTask = currentById.get(serverTask.taskId);
    if (!localTask) return serverTask;
    if (freshIds.has(serverTask.taskId)) return serverTask;
    if (!targetIds.has(serverTask.taskId)) return localTask;

    return {
      ...localTask,
      taskInstanceId: serverTask.taskInstanceId,
      schedule: serverTask.schedule,
      pendingSchedule: serverTask.pendingSchedule,
      availableFrom: serverTask.availableFrom,
      dueAt: serverTask.dueAt,
      prerequisiteTaskId: serverTask.prerequisiteTaskId,
      scheduleReadWarnings: serverTask.scheduleReadWarnings,
      currentCycle: serverTask.currentCycle,
    };
  });
}

const tabs: Array<{ id: AdminTab; label: string }> = [
  { id: 'settings', label: '시스템 설정' },
  { id: 'students', label: '학생 관리' },
  { id: 'products', label: '매점 관리' },

  { id: 'tasks', label: '과제 설정' },
  { id: 'transactions', label: '거래 내역 확인' },
  { id: 'currency', label: '화폐 지급/회수' },
];

export function AdminManagePage() {
  const [activeTab, setActiveTab] = useState<AdminTab>('settings');
  const adminTabRefs = useRef<Partial<Record<AdminTab, HTMLButtonElement | null>>>({});
  const [storeTab, setStoreTab] = useState<StoreTab>('inventory');
  const [hasOpenedPromotions, setHasOpenedPromotions] = useState(false);
  const [hasOpenedTransactions, setHasOpenedTransactions] = useState(false);
  const storeTabRefs = useRef<Record<StoreTab, HTMLButtonElement | null>>({ inventory: null, promotions: null });
  const [students, setStudents] = useState<StudentDraft[]>([]);
  const [products, setProducts] = useState<ProductDraft[]>([]);
  const [tasks, setTasks] = useState<TaskDraft[]>([]);
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [bulkMode, setBulkMode] = useState<BulkMode>('set');
  const [bulkAmount, setBulkAmount] = useState(0);
  const bulkBalanceAttempt = useRef<{ semanticKey: string; operationId: string } | null>(null);
  const bulkBalanceInFlight = useRef(false);
  const [message, setMessage] = useState('학생/상품 목록을 불러오는 중입니다.');
  const [newStudent, setNewStudent] = useState<NewStudentDraft>(EMPTY_STUDENT);
  const [newProduct, setNewProduct] = useState<NewProductDraft>(EMPTY_PRODUCT);
  const [newTask, setNewTask] = useState<Omit<TaskDraft, 'taskId'>>(EMPTY_TASK);
  const [imageEditor, setImageEditor] = useState<{ productId: string; value: string } | null>(null);
  const [taskDescriptionEditor, setTaskDescriptionEditor] = useState<{ taskId: string; value: string } | null>(null);
  const [taskScheduleEditor, setTaskScheduleEditor] = useState<{ taskId: string | null; target: TaskDialogTarget; form: TaskRecurrenceForm; explicit: boolean; opener: HTMLElement | null; availableFrom: string; dueAt: string; prerequisiteTaskId: string; availabilityExplicit: boolean } | null>(null);
  const [dirtyTaskScheduleIds, setDirtyTaskScheduleIds] = useState<string[]>([]);
  const [isSavingTaskSchedule, setIsSavingTaskSchedule] = useState(false);
  const taskScheduleSession = useRef<{ id: number; taskId: string | null }>({ id: 0, taskId: null });
  const [taskHistory, setTaskHistory] = useState<TaskHistoryDialogState | null>(null);
  const historyOpenerRef = useRef<HTMLElement | null>(null);
  const [taskDeleteConfirmation, setTaskDeleteConfirmation] = useState<{ taskId: string; title: string; opener: HTMLElement; deleting: boolean; error: string } | null>(null);
  const historyRequestId = useRef(0);
  const assignmentRequest = useRef<{ id: number; taskId: string | null }>({ id: 0, taskId: null });
  const [taskAssignmentEditor, setTaskAssignmentEditor] = useState<{
    taskId: string | null;
    target: TaskDialogTarget;
    opener: HTMLElement | null;
    operations: Record<string, { assigned?: boolean; completed?: boolean }>;
    retryTargets?: Array<{ taskId: string; operations: Array<{ studentId: string; assigned?: boolean; completed?: boolean; source: 'ADMIN' }> }>;
    selectedIds: string[];
    assignedIds: string[];
    completedIds: string[];
    initialAssignedIds: string[];
    initialCompletedIds: string[];
    statusRows: TaskAssignmentStudentStatus[];
    isLoading?: boolean;
  } | null>(null);
  const [taskResetConfirmation, setTaskResetConfirmation] = useState<{ target: TaskDialogTarget; opener: HTMLElement; operationId: string; resetting: boolean; error: string } | null>(null);
  const [qrPrintStudents, setQrPrintStudents] = useState<StudentDraft[] | null>(null);
  const [currencyMode, setCurrencyMode] = useState<CurrencyMode>('add');
  const [currencyAmount, setCurrencyAmount] = useState(0);
  const [currencyScannerOpen, setCurrencyScannerOpen] = useState(false);
  const [currencyManualId, setCurrencyManualId] = useState('');
  const [currencyResult, setCurrencyResult] = useState<CurrencyResult | null>(null);
  const [currencyLoading, setCurrencyLoading] = useState(false);
  const currencyAttempt = useRef<{ semanticKey: string; operationId: string } | null>(null);
  const currencyInFlight = useRef(false);
  const [qrTaskPickerOpen, setQrTaskPickerOpen] = useState(false);
  const [qrTaskScan, setQrTaskScan] = useState<{ taskId: string; manualId: string } | null>(null);
  const [qrTaskLoading, setQrTaskLoading] = useState(false);
  const [qrTaskResult, setQrTaskResult] = useState<QrTaskAssignmentResult | null>(null);
  const [settings, setSettings] = useState<Settings>({ currencyUnit: '원', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white', fontFamily: 'default', qrManualInputEnabled: false });
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isSavingChanges, setIsSavingChanges] = useState(false);
  const [isRefreshingLists, setIsRefreshingLists] = useState(false);

  const loadLinkedSheetData = useCallback(async (options: { silent?: boolean; shouldApply?: () => boolean } = {}) => {
    const shouldApply = options.shouldApply ?? (() => true);

    if (!options.silent && shouldApply()) {
      setIsInitialLoading(true);
      setMessage('학생/상품 목록을 불러오는 중입니다.');
    }

    try {
      const [studentResponse, productResponse, taskResponse, settingsResponse] = await Promise.all([
        fetch('/api/students', { cache: 'no-store' }),
        fetch('/api/products?includeInactive=1', { cache: 'no-store' }),
        fetch('/api/tasks?includeInactive=1', { cache: 'no-store' }),
        fetch('/api/settings', { cache: 'no-store' }),
      ]);
      const [studentPayload, productPayload, taskPayload, settingsPayload] = await Promise.all([studentResponse.json(), productResponse.json(), taskResponse.json(), settingsResponse.json().catch(() => null)]);

      if (!studentResponse.ok) throw new Error(studentPayload.error ?? '학생 목록을 불러오지 못했습니다.');
      if (!productResponse.ok) throw new Error(productPayload.error ?? '상품 목록을 불러오지 못했습니다.');
      if (!taskResponse.ok) throw new Error(taskPayload.error ?? '과제 목록을 불러오지 못했습니다.');

      if (!shouldApply()) return;
      setSettings({
        currencyUnit: settingsPayload?.currencyUnit ?? '원',
        appTitle: settingsPayload?.appTitle ?? '학급 매점',
        bankTitle: settingsPayload?.bankTitle ?? '학급 은행',
        themeColor: normalizeThemeColor(settingsPayload?.themeColor),
        fontFamily: settingsPayload?.fontFamily ?? 'default',
        qrManualInputEnabled: Boolean(settingsPayload?.qrManualInputEnabled),
      });
      setStudents(studentPayload);
      setProducts(productPayload);
      setTasks((taskPayload as TaskDraft[]).map(normalizeAdminTask));
      setSelectedStudentIds((ids) => ids.filter((id) => studentPayload.some((student: Student) => student.studentId === id)));
      setSelectedProductIds((ids) => ids.filter((id) => productPayload.some((product: Product) => product.productId === id)));
      setSelectedTaskIds((ids) => ids.filter((id) => taskPayload.some((task: ClassTask) => task.taskId === id)));
      setMessage('');
      setIsInitialLoading(false);
    } catch (error) {
      if (!shouldApply()) return;
      setStudents([]);
      setProducts([]);
      setTasks([]);
      setMessage(error instanceof Error ? error.message : '목록을 불러오지 못했습니다.');
      setIsInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;

    void Promise.resolve().then(() => loadLinkedSheetData({ shouldApply: () => !ignore }));

    return () => {
      ignore = true;
    };
  }, [loadLinkedSheetData]);

  const summary = useMemo(() => {
    const activeProducts = products.filter((product) => product.isActive).length;
    const totalStock = products.reduce((sum, product) => sum + product.stock, 0);
    const activeTasks = tasks.filter((task) => task.isActive).length;
    return { students: students.length, activeProducts, totalStock, activeTasks };
  }, [products, students, tasks]);
  const allStudentsSelected = students.length > 0 && selectedStudentIds.length === students.length;
  const allProductsSelected = products.length > 0 && selectedProductIds.length === products.length;

  useEffect(() => {
    document.body.classList.toggle('qr-selection-printing', Boolean(qrPrintStudents));
    return () => document.body.classList.remove('qr-selection-printing');
  }, [qrPrintStudents]);
  const allTasksSelected = tasks.length > 0 && selectedTaskIds.length === tasks.length;

  function updateStudent(studentId: string, patch: Partial<StudentDraft>) {
    setStudents((current) => current.map((student) => (student.studentId === studentId ? { ...student, ...patch } : student)));
  }

  function updateProduct(productId: string, patch: Partial<ProductDraft>) {
    setProducts((current) => current.map((product) => (product.productId === productId ? { ...product, ...patch } : product)));
  }

  function updateTask(taskId: string, patch: Partial<TaskDraft>) {
    setTasks((current) => current.map((task) => (task.taskId === taskId ? { ...task, ...patch } : task)));
  }

  function openTaskScheduleEditor(task: TaskDraft | null, opener: HTMLElement | null = null) {
    const taskId = task?.taskId ?? null;
    const schedule = task ? resolveEffectiveAdminTaskSchedule(task) : newTask.schedule;
    taskScheduleSession.current = { id: taskScheduleSession.current.id + 1, taskId };
    setIsSavingTaskSchedule(false);
    setTaskScheduleEditor({
      taskId,
      target: task ? createTaskDialogTarget('single', [task]) : createTaskDialogTarget('new'),
      form: scheduleDtoToForm(schedule, { taskInstanceId: task?.taskInstanceId }),
      explicit: true,
      opener,
      availableFrom: isoToSeoulLocal(task ? task.availableFrom : newTask.availableFrom),
      dueAt: isoToSeoulLocal(task ? task.dueAt : newTask.dueAt),
      prerequisiteTaskId: (task ? task.prerequisiteTaskId : newTask.prerequisiteTaskId) ?? '',
      availabilityExplicit: false,
    });
  }

  function openBulkTaskScheduleEditor(opener: HTMLElement) {
    const selected = tasks.filter((task) => selectedTaskIds.includes(task.taskId));
    taskScheduleSession.current = { id: taskScheduleSession.current.id + 1, taskId: null };
    setIsSavingTaskSchedule(false);
    setTaskScheduleEditor({
      taskId: null,
      target: createTaskDialogTarget('bulk', selected),
      form: { ...scheduleDtoToForm(), type: '' as TaskRecurrenceForm['type'], time: '', weekdays: [], dayOfMonth: '' },
      explicit: false,
      opener,
      availableFrom: '',
      dueAt: '',
      prerequisiteTaskId: '',
      availabilityExplicit: false,
    });
  }

  function closeTaskScheduleEditor() {
    taskScheduleSession.current = { id: taskScheduleSession.current.id + 1, taskId: null };
    setIsSavingTaskSchedule(false);
    setTaskScheduleEditor(null);
  }

  async function applyTaskScheduleEditor() {
    if (!taskScheduleEditor) return;
    if (!taskScheduleEditor.explicit) return;
    const session = { ...taskScheduleSession.current };
    const isCurrentSession = () => taskScheduleSession.current.id === session.id
      && taskScheduleSession.current.taskId === session.taskId;
    const parsed = scheduleFormToPayload(taskScheduleEditor.form);
    if (!parsed.ok) return notify(parsed.error);
    if (taskScheduleEditor.target.kind === 'bulk') {
      const taskIds = taskScheduleEditor.target.tasks.map((task) => task.taskId);
      setIsSavingTaskSchedule(true);
      try {
        const response = await fetch('/api/tasks/schedules/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskIds,
            schedule: parsed.payload,
            ...(taskScheduleEditor.availabilityExplicit ? {
              availableFrom: seoulLocalToIso(taskScheduleEditor.availableFrom) || null,
              dueAt: seoulLocalToIso(taskScheduleEditor.dueAt) || null,
            } : {}),
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!isCurrentSession()) return;
        if (!response.ok) throw new Error(payload.error ?? '반복 설정을 저장하지 못했습니다.');
        try {
          const taskResponse = await fetch('/api/tasks?includeInactive=1', { cache: 'no-store' });
          const taskPayload = await taskResponse.json().catch(() => null);
          if (!isCurrentSession()) return;
          if (!taskResponse.ok || !Array.isArray(taskPayload)) throw new Error('refresh failed');
          setTasks((current) => reconcileTaskProjections(current, taskPayload, taskIds));
          setIsSavingTaskSchedule(false);
          closeTaskScheduleEditor();
        } catch {
          if (!isCurrentSession()) return;
          setIsSavingTaskSchedule(false);
          closeTaskScheduleEditor();
          notify('반복 설정 저장은 완료됐지만 목록 새로고침 실패. 과제 설정의 새로고침 버튼을 눌러 주세요.');
        }
      } catch (error) {
        if (isCurrentSession()) notify(error instanceof Error ? error.message : '반복 설정을 저장하지 못했습니다.');
      } finally {
        if (isCurrentSession()) setIsSavingTaskSchedule(false);
      }
      return;
    }
    if (taskScheduleEditor.taskId) {
      const task = tasks.find((item) => item.taskId === taskScheduleEditor.taskId);
      if (!task) return notify('과제를 찾을 수 없습니다.');
      setIsSavingTaskSchedule(true);
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(task.taskId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schedule: parsed.payload,
            availableFrom: seoulLocalToIso(taskScheduleEditor.availableFrom) || null,
            dueAt: seoulLocalToIso(taskScheduleEditor.dueAt) || null,
            prerequisiteTaskId: taskScheduleEditor.prerequisiteTaskId || null,
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? '반복 설정을 저장하지 못했습니다.');
        try {
          const taskResponse = await fetch('/api/tasks?includeInactive=1', { cache: 'no-store' });
          const taskPayload = await taskResponse.json().catch(() => null);
          if (!isCurrentSession()) return;
          if (!taskResponse.ok || !Array.isArray(taskPayload)) throw new Error('refresh failed');
          setTasks((current) => reconcileTaskProjections(current, taskPayload, [task.taskId]));
          setDirtyTaskScheduleIds((current) => current.filter((id) => id !== task.taskId));
          setIsSavingTaskSchedule(false);
          closeTaskScheduleEditor();
        } catch {
          if (!isCurrentSession()) return;
          setIsSavingTaskSchedule(false);
          closeTaskScheduleEditor();
          notify('반복 설정 저장은 완료됐지만 목록 새로고침 실패. 과제 설정의 새로고침 버튼을 눌러 주세요.');
        }
      } catch (error) {
        if (isCurrentSession()) notify(error instanceof Error ? error.message : '반복 설정을 저장하지 못했습니다.');
      } finally {
        if (isCurrentSession()) setIsSavingTaskSchedule(false);
      }
      return;
    }
    setNewTask((current) => ({ ...current,
      availableFrom: seoulLocalToIso(taskScheduleEditor.availableFrom),
      dueAt: seoulLocalToIso(taskScheduleEditor.dueAt),
      prerequisiteTaskId: taskScheduleEditor.prerequisiteTaskId,
      schedule: {
      ruleVersion: 1,
      effectiveFrom: '',
      ...parsed.payload,
    } }));
    closeTaskScheduleEditor();
  }

  async function openTaskHistory(task: TaskDraft, opener: HTMLElement) {
    const requestId = ++historyRequestId.current;
    historyOpenerRef.current = opener;
    setTaskDeleteConfirmation(null);
    setTaskHistory({ taskId: task.taskId, title: task.title, loading: true, error: '', detail: null });
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.taskId)}/history`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '과제 기록을 불러오지 못했습니다.');
      if (historyRequestId.current !== requestId) return;
      setTaskHistory({ taskId: task.taskId, title: task.title, loading: false, error: '', detail: payload });
    } catch (error) {
      if (historyRequestId.current !== requestId) return;
      setTaskHistory({ taskId: task.taskId, title: task.title, loading: false, error: error instanceof Error ? error.message : '과제 기록을 불러오지 못했습니다.', detail: null });
    }
  }

  function closeTaskHistory() {
    historyRequestId.current += 1;
    setTaskHistory(null);
  }

  function requestTaskDelete(task: TaskDraft, opener: HTMLElement) {
    closeTaskHistory();
    setTaskDeleteConfirmation({ taskId: task.taskId, title: task.title, opener, deleting: false, error: '' });
  }

  function cancelTaskDelete() {
    if (taskDeleteConfirmation?.deleting) return;
    setTaskDeleteConfirmation(null);
  }

  function notify(messageText: string) {
    window.alert(messageText);
  }

  async function refreshStudents() {
    setIsRefreshingLists(true);
    try {
      const [studentResponse, settingsResponse] = await Promise.all([
        fetch('/api/students', { cache: 'no-store' }),
        fetch('/api/settings', { cache: 'no-store' }),
      ]);
      const [studentPayload, settingsPayload] = await Promise.all([studentResponse.json(), settingsResponse.json().catch(() => null)]);
      if (!studentResponse.ok) throw new Error(studentPayload.error ?? '학생 목록을 불러오지 못했습니다.');
      setStudents(studentPayload);
      setSelectedStudentIds((ids) => ids.filter((id) => studentPayload.some((student: Student) => student.studentId === id)));
      setSettings({
        currencyUnit: settingsPayload?.currencyUnit ?? '원',
        appTitle: settingsPayload?.appTitle ?? '학급 매점',
        bankTitle: settingsPayload?.bankTitle ?? '학급 은행',
        themeColor: normalizeThemeColor(settingsPayload?.themeColor),
        fontFamily: settingsPayload?.fontFamily ?? 'default',
        qrManualInputEnabled: Boolean(settingsPayload?.qrManualInputEnabled),
      });
      setMessage('');
    } catch (error) {
      notify(error instanceof Error ? error.message : '학생 목록을 불러오지 못했습니다.');
    } finally {
      setIsRefreshingLists(false);
    }
  }

  async function refreshProducts() {
    setIsRefreshingLists(true);
    try {
      const [productResponse, settingsResponse] = await Promise.all([
        fetch('/api/products?includeInactive=1', { cache: 'no-store' }),
        fetch('/api/settings', { cache: 'no-store' }),
      ]);
      const [productPayload, settingsPayload] = await Promise.all([productResponse.json(), settingsResponse.json().catch(() => null)]);
      if (!productResponse.ok) throw new Error(productPayload.error ?? '상품 목록을 불러오지 못했습니다.');
      setProducts(productPayload);
      setSelectedProductIds((ids) => ids.filter((id) => productPayload.some((product: Product) => product.productId === id)));
      setSettings({
        currencyUnit: settingsPayload?.currencyUnit ?? '원',
        appTitle: settingsPayload?.appTitle ?? '학급 매점',
        bankTitle: settingsPayload?.bankTitle ?? '학급 은행',
        themeColor: normalizeThemeColor(settingsPayload?.themeColor),
        fontFamily: settingsPayload?.fontFamily ?? 'default',
        qrManualInputEnabled: Boolean(settingsPayload?.qrManualInputEnabled),
      });
      setMessage('');
    } catch (error) {
      notify(error instanceof Error ? error.message : '상품 목록을 불러오지 못했습니다.');
    } finally {
      setIsRefreshingLists(false);
    }
  }

  async function refreshTasks() {
    setIsRefreshingLists(true);
    try {
      const [taskResponse, settingsResponse] = await Promise.all([
        fetch('/api/tasks?includeInactive=1', { cache: 'no-store' }),
        fetch('/api/settings', { cache: 'no-store' }),
      ]);
      const [taskPayload, settingsPayload] = await Promise.all([taskResponse.json(), settingsResponse.json().catch(() => null)]);
      if (!taskResponse.ok) throw new Error(taskPayload.error ?? '과제 목록을 불러오지 못했습니다.');
      setTasks((taskPayload as TaskDraft[]).map(normalizeAdminTask));
      setSelectedTaskIds((ids) => ids.filter((id) => taskPayload.some((task: ClassTask) => task.taskId === id)));
      setSettings({
        currencyUnit: settingsPayload?.currencyUnit ?? '원',
        appTitle: settingsPayload?.appTitle ?? '학급 매점',
        bankTitle: settingsPayload?.bankTitle ?? '학급 은행',
        themeColor: normalizeThemeColor(settingsPayload?.themeColor),
        fontFamily: settingsPayload?.fontFamily ?? 'default',
        qrManualInputEnabled: Boolean(settingsPayload?.qrManualInputEnabled),
      });
      setMessage('');
    } catch (error) {
      notify(error instanceof Error ? error.message : '과제 목록을 불러오지 못했습니다.');
    } finally {
      setIsRefreshingLists(false);
    }
  }

  function toggleStudent(studentId: string) {
    setSelectedStudentIds((current) => current.includes(studentId) ? current.filter((id) => id !== studentId) : [...current, studentId]);
  }

  function toggleProduct(productId: string) {
    setSelectedProductIds((current) => current.includes(productId) ? current.filter((id) => id !== productId) : [...current, productId]);
  }

  function toggleTask(taskId: string) {
    setSelectedTaskIds((current) => current.includes(taskId) ? current.filter((id) => id !== taskId) : [...current, taskId]);
  }

  function sortStudentsById(list: StudentDraft[]) {
    return [...list].sort((a, b) => a.studentId.localeCompare(b.studentId, 'ko-KR', { numeric: true }) || a.name.localeCompare(b.name));
  }

  async function loadTaskAssignmentStatus(taskId: string) {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/assignments`, { cache: 'no-store' });
    const payload = await response.json() as TaskAssignmentStatus & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? '과제 부여 상태를 불러오지 못했습니다.');
    return normalizeTaskAssignmentStatus(payload);
  }


  function openTaskAssignmentEditor(taskId: string | null, assignedIds: string[], opener: HTMLElement | null = null) {
    const requestId = assignmentRequest.current.id + 1;
    assignmentRequest.current = { id: requestId, taskId };
    setIsSavingChanges(false);
    setTaskAssignmentEditor({
      taskId,
      target: taskId
        ? createTaskDialogTarget('single', tasks.filter((task) => task.taskId === taskId))
        : createTaskDialogTarget('new'),
      opener,
      operations: {},
      selectedIds: [],
      assignedIds: [...assignedIds],
      completedIds: [],
      initialAssignedIds: [...assignedIds],
      initialCompletedIds: [],
      statusRows: [],
      isLoading: Boolean(taskId),
    });
    if (!taskId) return;

    void loadTaskAssignmentStatus(taskId)
      .then((status) => {
        if (assignmentRequest.current.id !== requestId || assignmentRequest.current.taskId !== taskId) return;
        const { assignedIds: loadedAssignedIds, completedIds: loadedCompletedIds, statusRows } = status;
        setTasks((current) => reconcileTaskAssignmentProjection(current, taskId, status));
        setTaskAssignmentEditor((current) => current?.taskId === taskId ? {
          ...current,
          selectedIds: [],
          assignedIds: loadedAssignedIds,
          completedIds: loadedCompletedIds,
          initialAssignedIds: loadedAssignedIds,
          initialCompletedIds: loadedCompletedIds,
          statusRows,
          isLoading: false,
        } : current);
      })
      .catch((error) => {
        if (assignmentRequest.current.id !== requestId || assignmentRequest.current.taskId !== taskId) return;
        notify(error instanceof Error ? error.message : '과제 부여 상태를 불러오지 못했습니다.');
        setTaskAssignmentEditor((current) => current?.taskId === taskId ? { ...current, isLoading: false } : current);
      });
  }

  function openBulkTaskAssignmentEditor(opener: HTMLElement) {
    const selected = tasks.filter((task) => selectedTaskIds.includes(task.taskId));
    assignmentRequest.current = { id: assignmentRequest.current.id + 1, taskId: null };
    setIsSavingChanges(false);
    setTaskAssignmentEditor({
      taskId: null,
      target: createTaskDialogTarget('bulk', selected),
      opener,
      operations: {},
      selectedIds: [],
      assignedIds: [],
      completedIds: [],
      initialAssignedIds: [],
      initialCompletedIds: [],
      statusRows: [],
      isLoading: false,
    });
  }

  function setBulkAssignmentOperation(studentId: string, field: 'assigned' | 'completed', value: string) {
    setTaskAssignmentEditor((current) => {
      if (!current || current.target.kind !== 'bulk') return current;
      const operation = { ...current.operations[studentId] };
      if (value === '') delete operation[field];
      else operation[field] = value === (field === 'assigned' ? 'assigned' : 'completed');
      const operations = { ...current.operations };
      if (Object.keys(operation).length) operations[studentId] = operation;
      else delete operations[studentId];
      return { ...current, operations, retryTargets: undefined };
    });
  }

  function closeTaskAssignmentEditor() {
    assignmentRequest.current = { id: assignmentRequest.current.id + 1, taskId: null };
    setIsSavingChanges(false);
    setTaskAssignmentEditor(null);
  }

  function toggleTaskAssignmentStudent(studentId: string) {
    setTaskAssignmentEditor((current) => {
      if (!current) return current;
      const isSelected = current.selectedIds.includes(studentId);
      const selectedIds = isSelected ? current.selectedIds.filter((id) => id !== studentId) : [...current.selectedIds, studentId];
      return { ...current, selectedIds };
    });
  }


  function toggleTaskAssignmentAssigned(studentId: string) {
    setTaskAssignmentEditor((current) => {
      if (!current) return current;
      const isAssigned = current.assignedIds.includes(studentId);
      const assignedIds = isAssigned ? current.assignedIds.filter((id) => id !== studentId) : [...current.assignedIds, studentId];
      return { ...current, assignedIds };
    });
  }

  function toggleTaskAssignmentCompleted(studentId: string) {
    setTaskAssignmentEditor((current) => {
      if (!current) return current;
      const isCompleted = current.completedIds.includes(studentId);
      const completedIds = isCompleted ? current.completedIds.filter((id) => id !== studentId) : [...current.completedIds, studentId];
      return { ...current, completedIds };
    });
  }

  function setSelectedTaskAssignmentAssigned(status: 'assigned' | 'unassigned') {
    setTaskAssignmentEditor((current) => {
      if (!current) return current;
      if (current.target.kind === 'bulk') {
        const operations = { ...current.operations };
        for (const studentId of current.selectedIds) operations[studentId] = { ...operations[studentId], assigned: status === 'assigned' };
        return { ...current, operations, retryTargets: undefined };
      }
      if (status === 'assigned') {
        return { ...current, assignedIds: Array.from(new Set([...current.assignedIds, ...current.selectedIds])) };
      }
      return { ...current, assignedIds: current.assignedIds.filter((id) => !current.selectedIds.includes(id)) };
    });
  }

  function setSelectedTaskAssignmentCompletion(status: 'completed' | 'incomplete') {
    setTaskAssignmentEditor((current) => {
      if (!current) return current;
      if (current.target.kind === 'bulk') {
        const operations = { ...current.operations };
        for (const studentId of current.selectedIds) operations[studentId] = { ...operations[studentId], completed: status === 'completed' };
        return { ...current, operations, retryTargets: undefined };
      }
      if (status === 'completed') {
        return { ...current, completedIds: Array.from(new Set([...current.completedIds, ...current.selectedIds])) };
      }
      return { ...current, completedIds: current.completedIds.filter((id) => !current.selectedIds.includes(id)) };
    });
  }


  async function saveTaskAssignment() {
    if (!taskAssignmentEditor || isSavingChanges) return;
    if (taskAssignmentEditor.target.kind === 'bulk') {
      const session = { ...assignmentRequest.current };
      const isCurrentSession = () => assignmentRequest.current.id === session.id
        && assignmentRequest.current.taskId === session.taskId;
      const operations = Object.entries(taskAssignmentEditor.operations).map(([studentId, operation]) => ({ studentId, ...operation, source: 'ADMIN' as const }));
      if (operations.length === 0) return;
      const targets = taskAssignmentEditor.retryTargets ?? taskAssignmentEditor.target.tasks.map((task) => ({ taskId: task.taskId, operations }));
      setIsSavingChanges(true);
      try {
        const response = await fetch('/api/tasks/assignments/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targets }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!isCurrentSession()) return;
        if (!response.ok) throw new Error(payload.error ?? '과제 부여 내용을 저장하지 못했습니다.');
        const failures = Array.isArray(payload.failures) ? payload.failures as Array<{ taskId?: string; studentId?: string; code?: string }> : [];
        const notAttempted = Array.isArray(payload.notAttempted) ? payload.notAttempted as Array<{ taskId?: string; studentId?: string }> : [];
        const warnings = Array.isArray(payload.warnings) ? payload.warnings as Array<{ taskId?: string; code?: string }> : [];
        const aborted = payload.aborted === true;
        if (failures.length === 0 && notAttempted.length === 0 && !aborted) {
          try {
            const taskResponse = await fetch('/api/tasks?includeInactive=1', { cache: 'no-store' });
            const taskPayload = await taskResponse.json().catch(() => null);
            if (!isCurrentSession()) return;
            if (!taskResponse.ok || !Array.isArray(taskPayload)) throw new Error('refresh failed');
            setTasks((taskPayload as TaskDraft[]).map(normalizeAdminTask));
            setIsSavingChanges(false);
            closeTaskAssignmentEditor();
            if (warnings.length > 0) {
              notify(`과제 부여 저장은 완료됐지만 기존 호환 목록 반영에 실패했습니다 (${formatTaskWarnings(warnings, tasks)}). 새로고침 후 확인해 주세요.`);
            } else {
              notify('과제 부여 저장 완료');
            }
          } catch {
            if (!isCurrentSession()) return;
            setIsSavingChanges(false);
            closeTaskAssignmentEditor();
            const warningText = warnings.length > 0 ? ` 기존 호환 목록 반영 실패: ${formatTaskWarnings(warnings, tasks)}.` : '';
            notify(`과제 부여 저장은 완료됐지만 목록 새로고침 실패.${warningText} 과제 설정의 새로고침 버튼을 눌러 주세요.`);
          }
          return;
        }
        const pendingPairs = new Set([...failures, ...notAttempted].flatMap((item) =>
          item.taskId && item.studentId ? [`${item.taskId}\u0000${item.studentId}`] : []));
        const retryTargets = pendingPairs.size ? targets.flatMap((target) => {
          const pending = target.operations.filter((operation) => pendingPairs.has(`${target.taskId}\u0000${operation.studentId}`));
          return pending.length ? [{ taskId: target.taskId, operations: pending }] : [];
        }) : targets;
        setTaskAssignmentEditor((current) => current?.target.kind === 'bulk' ? {
          ...current,
          retryTargets,
        } : current);
        const retryItems = [
          ...failures,
          ...notAttempted.map((item) => ({ ...item, code: 'NOT_ATTEMPTED' })),
        ];
        const warningText = warnings.length > 0 ? ` 기존 호환 목록 반영 실패: ${formatTaskWarnings(warnings, tasks)}.` : '';
        notify(`${aborted ? '과제 부여 처리가 중단되었습니다. ' : '과제 부여 일부 저장 실패. '}다시 시도 대상: ${formatAssignmentFailures(retryItems, tasks, students)}.${warningText}`);
      } catch (error) {
        if (isCurrentSession()) notify(error instanceof Error ? error.message : '과제 부여 내용을 저장하지 못했습니다.');
      } finally {
        if (isCurrentSession()) setIsSavingChanges(false);
      }
      return;
    }
    if (!taskAssignmentEditor.taskId) {
      setNewTask((current) => ({ ...current, allowedStudentIds: taskAssignmentEditor.assignedIds }));
      closeTaskAssignmentEditor();
      return;
    }

    const taskId = taskAssignmentEditor.taskId;
    const task = tasks.find((item) => item.taskId === taskId);
    if (!task) {
      notify('과제를 찾을 수 없습니다.');
      closeTaskAssignmentEditor();
      return;
    }

    type AssignmentCommand = { studentId: string; assigned?: boolean; completed?: boolean; source: 'ADMIN' };
    const commands: AssignmentCommand[] = students.flatMap((student) => {
      const wasAssigned = taskAssignmentEditor.initialAssignedIds.includes(student.studentId);
      const wasCompleted = taskAssignmentEditor.initialCompletedIds.includes(student.studentId);
      const assigned = taskAssignmentEditor.assignedIds.includes(student.studentId);
      const completed = taskAssignmentEditor.completedIds.includes(student.studentId);
      if (wasAssigned === assigned && wasCompleted === completed) return [];
      return [{
        studentId: student.studentId,
        ...(wasAssigned !== assigned ? { assigned } : {}),
        ...(wasCompleted !== completed ? { completed } : {}),
        source: 'ADMIN' as const,
      }];
    });

    if (commands.length === 0) {
      closeTaskAssignmentEditor();
      notify('과제 부여 저장 완료');
      return;
    }

    let authoritativeAssignedIds = [...taskAssignmentEditor.initialAssignedIds];
    let authoritativeCompletedIds = [...taskAssignmentEditor.initialCompletedIds];
    const failures: Array<{ command: AssignmentCommand; message: string }> = [];
    let reconciliationFailureMessage = '';
    setIsSavingChanges(true);
    try {
      for (const command of commands) {
        try {
          const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/assignments`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(command),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error ?? '과제 부여 내용을 저장하지 못했습니다.');
          if (Array.isArray(payload.students)) {
            const status = normalizeTaskAssignmentStatus(payload as TaskAssignmentStatus);
            authoritativeAssignedIds = status.assignedIds;
            authoritativeCompletedIds = status.completedIds;
            setTasks((current) => reconcileTaskAssignmentProjection(current, taskId, status));
            setTaskAssignmentEditor((current) => current?.taskId === taskId ? { ...current, statusRows: status.statusRows } : current);
          } else {
            if (typeof command.assigned === 'boolean') {
              authoritativeAssignedIds = command.assigned
                ? Array.from(new Set([...authoritativeAssignedIds, command.studentId]))
                : authoritativeAssignedIds.filter((id) => id !== command.studentId);
            }
            if (typeof command.completed === 'boolean') {
              authoritativeCompletedIds = command.completed
                ? Array.from(new Set([...authoritativeCompletedIds, command.studentId]))
                : authoritativeCompletedIds.filter((id) => id !== command.studentId);
            }
          }
        } catch (error) {
          failures.push({ command, message: error instanceof Error ? error.message : '과제 부여 내용을 저장하지 못했습니다.' });
        }
      }

      if (failures.length > 0) {
        try {
          const reconciledStatus = await loadTaskAssignmentStatus(taskId);
          authoritativeAssignedIds = reconciledStatus.assignedIds;
          authoritativeCompletedIds = reconciledStatus.completedIds;
          setTasks((current) => reconcileTaskAssignmentProjection(current, taskId, reconciledStatus));
          setTaskAssignmentEditor((current) => current?.taskId === taskId ? { ...current, statusRows: reconciledStatus.statusRows } : current);
        } catch (error) {
          reconciliationFailureMessage = error instanceof Error
            ? `, 최신 부여 상태 확인 실패: ${error.message}`
            : ', 최신 부여 상태를 확인하지 못했습니다.';
        }
      }

      setTasks((current) => current.map((item) => item.taskId === taskId ? { ...item, allowedStudentIds: authoritativeAssignedIds } : item));
      if (failures.length === 0) {
        closeTaskAssignmentEditor();
        notify('과제 부여 저장 완료');
        return;
      }

      let retryAssignedIds = [...authoritativeAssignedIds];
      let retryCompletedIds = [...authoritativeCompletedIds];
      for (const { command } of failures) {
        if (typeof command.assigned === 'boolean') {
          retryAssignedIds = command.assigned
            ? Array.from(new Set([...retryAssignedIds, command.studentId]))
            : retryAssignedIds.filter((id) => id !== command.studentId);
        }
        if (typeof command.completed === 'boolean') {
          retryCompletedIds = command.completed
            ? Array.from(new Set([...retryCompletedIds, command.studentId]))
            : retryCompletedIds.filter((id) => id !== command.studentId);
        }
      }
      setTaskAssignmentEditor((current) => current?.taskId === taskId ? {
        ...current,
        assignedIds: retryAssignedIds,
        completedIds: retryCompletedIds,
        initialAssignedIds: authoritativeAssignedIds,
        initialCompletedIds: authoritativeCompletedIds,
      } : current);
      notify(`과제 부여 일부 저장 실패 (${commands.length - failures.length}/${commands.length}건 저장): ${failures.map((failure) => failure.message).join(', ')}${reconciliationFailureMessage}`);
    } finally {
      setIsSavingChanges(false);
    }
  }

  function openQrTaskScan(taskId: string) {
    setQrTaskPickerOpen(false);
    setQrTaskResult(null);
    setQrTaskScan({ taskId, manualId: '' });
  }

  function returnToQrTaskPicker() {
    setQrTaskResult(null);
    setQrTaskScan(null);
    setQrTaskPickerOpen(true);
  }

  async function assignTaskByQr(decodedText: string) {
    const studentId = decodedText.trim();
    const taskId = qrTaskScan?.taskId;
    if (!studentId || !taskId) return;
    setQrTaskScan(null);
    setQrTaskLoading(true);
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    const task = tasks.find((item) => item.taskId === taskId);
    const student = students.find((item) => item.studentId === studentId && item.status === 'ACTIVE');
    if (!task) {
      setQrTaskResult({ status: 'failure', taskId, message: '과제를 찾을 수 없습니다.' });
      setQrTaskLoading(false);
      return;
    }
    if (!student) {
      setQrTaskResult({ status: 'failure', taskId, message: '잘못된 QR입니다.' });
      setQrTaskLoading(false);
      return;
    }
    if ((task.allowedStudentIds ?? []).includes(student.studentId)) {
      setQrTaskResult({ status: 'failure', taskId, message: '이미 이 과제가 부여된 학생입니다.' });
      setQrTaskLoading(false);
      return;
    }

    const fallbackAssignedIds = [...(task.allowedStudentIds ?? []), student.studentId];

    setQrTaskLoading(false);
    setIsSavingChanges(true);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.taskId)}/assignments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: student.studentId, assigned: true, source: 'QR' }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '과제 부여 내용을 저장하지 못했습니다.');
      const assignedStudentIds = Array.isArray(payload.students)
        ? payload.students.filter((row: { assigned?: boolean }) => row.assigned).map((row: { studentId: string }) => row.studentId)
        : fallbackAssignedIds;
      if (Array.isArray(payload.students)) setTasks((current) => reconcileTaskAssignmentProjection(current, task.taskId, normalizeTaskAssignmentStatus(payload as TaskAssignmentStatus)));
      else setTasks((current) => current.map((item) => item.taskId === task.taskId ? { ...item, allowedStudentIds: assignedStudentIds } : item));
      setQrTaskResult({ status: 'success', taskId, message: '과제가 부여되었습니다.' });
    } catch (error) {
      setQrTaskResult({ status: 'failure', taskId, message: error instanceof Error ? error.message : '과제 부여 내용을 저장하지 못했습니다.' });
    } finally {
      setIsSavingChanges(false);
    }
  }

  function buildStudentPayload(list: StudentDraft[]) {
    return list.map((student) => ({ studentId: student.studentId, name: student.name, balance: student.balance, status: student.status }));
  }

  function buildProductPayload(list: ProductDraft[]) {
    return list.map((product) => ({ productId: product.productId, name: product.name, price: product.price, stock: product.stock, isActive: product.isActive, imageUrl: product.imageUrl ?? '', category: product.category ?? '', sortOrder: product.sortOrder }));
  }

  function buildTaskPayload(list: TaskDraft[]) {
    return list.map((task) => {
      const schedule = dirtyTaskScheduleIds.includes(task.taskId) && task.schedule
        ? scheduleFormToPayload(scheduleDtoToForm(task.schedule, { taskInstanceId: task.taskInstanceId }))
        : null;
      return {
        taskId: task.taskId,
        title: task.title,
        description: task.description,
        reward: task.reward,
        isActive: task.isActive,
        sortOrder: task.sortOrder,
        allowedStudentIds: task.allowedStudentIds ?? [],
        availableFrom: task.availableFrom ?? null,
        dueAt: task.dueAt ?? null,
        prerequisiteTaskId: task.prerequisiteTaskId ?? null,
        ...(schedule?.ok ? { schedule: schedule.payload } : {}),
      };
    });
  }

  function nextPrefixedId(existingIds: string[], prefix: 'P' | 'T') {
    const used = new Set(existingIds.map((id) => id.trim().toUpperCase()));
    for (let index = 1; index < 10000; index += 1) {
      const candidate = `${prefix}${String(index).padStart(3, '0')}`;
      if (!used.has(candidate)) return candidate;
    }
    return `${prefix}${Date.now()}`;
  }

  async function saveSelectedStudents() {
    if (selectedStudentIds.length === 0) return;
    await saveStudentRows(students.filter((student) => selectedStudentIds.includes(student.studentId)), '선택 학생');
  }

  async function saveAllStudents() {
    await saveStudentRows(students, '학생 명단');
  }

  async function saveStudentRows(rows: StudentDraft[], label: string) {
    setIsSavingChanges(true);
    try {
      const response = await fetch('/api/students/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ students: buildStudentPayload(rows) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '학생 명단을 저장하지 못했습니다.');
      const savedStudents = payload as StudentDraft[];
      const savedMap = new Map(savedStudents.map((student) => [student.studentId, student]));
      setStudents((current) => current.map((student) => savedMap.has(student.studentId) ? { ...student, ...savedMap.get(student.studentId) } : student));
      notify(`${label} ${rows.length}명 저장 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '학생 명단을 저장하지 못했습니다.');
    } finally {
      setIsSavingChanges(false);
    }
  }

  async function saveSelectedProducts() {
    if (selectedProductIds.length === 0) return;
    await saveProductRows(products.filter((product) => selectedProductIds.includes(product.productId)), '선택 상품');
  }

  async function saveAllProducts() {
    await saveProductRows(products, '매점 목록');
  }

  async function saveProductRows(rows: ProductDraft[], label: string) {
    setIsSavingChanges(true);
    try {
      const response = await fetch('/api/products/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products: buildProductPayload(rows) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '매점 목록을 저장하지 못했습니다.');
      const savedProducts = payload as ProductDraft[];
      const savedMap = new Map(savedProducts.map((product) => [product.productId, product]));
      setProducts((current) => current.map((product) => savedMap.has(product.productId) ? { ...product, ...savedMap.get(product.productId) } : product));
      notify(`${label} ${rows.length}개 저장 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '매점 목록을 저장하지 못했습니다.');
    } finally {
      setIsSavingChanges(false);
    }
  }

  async function saveSelectedTasks() {
    if (selectedTaskIds.length === 0) return;
    await saveTaskRows(tasks.filter((task) => selectedTaskIds.includes(task.taskId)), '선택 과제');
  }

  async function saveAllTasks() {
    await saveTaskRows(tasks, '과제 목록');
  }

  async function saveTaskRows(rows: TaskDraft[], label: string) {
    setIsSavingChanges(true);
    try {
      const response = await fetch('/api/tasks/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: buildTaskPayload(rows) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '과제 목록을 저장하지 못했습니다.');
      const savedTasks = payload as TaskDraft[];
      const savedMap = new Map(savedTasks.map((task) => [task.taskId, task]));
      setTasks((current) => current.map((task) => savedMap.has(task.taskId) ? { ...task, ...savedMap.get(task.taskId) } : task).sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title)));
      setDirtyTaskScheduleIds((current) => current.filter((id) => !savedMap.has(id)));
      notify(`${label} ${rows.length}개 저장 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '과제 목록을 저장하지 못했습니다.');
    } finally {
      setIsSavingChanges(false);
    }
  }

  async function deleteStudentRow(studentId: string, options: { silent?: boolean } = {}) {
    try {
      const response = await fetch(`/api/students/${encodeURIComponent(studentId)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '학생을 삭제하지 못했습니다.');
      setStudents((current) => current.filter((student) => student.studentId !== studentId));
      setSelectedStudentIds((current) => current.filter((id) => id !== studentId));
      if (!options.silent) notify(`${studentId} 삭제 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '학생을 삭제하지 못했습니다.');
    }
  }

  async function deleteSelectedStudents() {
    if (selectedStudentIds.length === 0) return notify('선택된 학생이 없습니다.');
    const idsToDelete = [...selectedStudentIds];
    try {
      const response = await fetch('/api/students/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: idsToDelete }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '학생을 삭제하지 못했습니다.');
      const deletedIds = Array.isArray(payload.studentIds) ? payload.studentIds : idsToDelete;
      setStudents((current) => current.filter((student) => !deletedIds.includes(student.studentId)));
      setSelectedStudentIds((current) => current.filter((id) => !deletedIds.includes(id)));
      notify(`선택 학생 ${deletedIds.length}명 삭제 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '학생을 삭제하지 못했습니다.');
    }
  }

  async function applyBulkStudentBalance() {
    if (selectedStudentIds.length === 0) {
      notify('선택된 학생이 없습니다.');
      return;
    }
    if (bulkBalanceInFlight.current) return;
    const studentIds = selectedStudentIds.map((id) => id.trim()).sort();
    const semanticKey = JSON.stringify({ studentIds, mode: bulkMode, amount: bulkAmount });
    if (bulkBalanceAttempt.current?.semanticKey !== semanticKey) {
      bulkBalanceAttempt.current = { semanticKey, operationId: crypto.randomUUID() };
    }
    const operationId = bulkBalanceAttempt.current.operationId;
    bulkBalanceInFlight.current = true;
    try {
      const response = await fetch('/api/students/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds, mode: bulkMode, amount: bulkAmount, operationId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '선택 학생 재화를 수정하지 못했습니다.');
      const balanceMap = new Map((payload as Array<{ studentId: string; balance: number }>).map((item) => [item.studentId, item.balance]));
      setStudents((current) => current.map((student) => balanceMap.has(student.studentId) ? { ...student, balance: balanceMap.get(student.studentId)! } : student));
      bulkBalanceAttempt.current = null;
      notify(`선택 학생 ${payload.length}명 수정 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '선택 학생 재화를 수정하지 못했습니다.');
    } finally {
      bulkBalanceInFlight.current = false;
    }
  }

  async function deleteProductRow(productId: string, options: { silent?: boolean } = {}) {
    try {
      const response = await fetch(`/api/products/${encodeURIComponent(productId)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '상품을 삭제하지 못했습니다.');
      setProducts((current) => current.filter((product) => product.productId !== productId));
      setSelectedProductIds((current) => current.filter((id) => id !== productId));
      if (!options.silent) notify(`${productId} 삭제 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '상품을 삭제하지 못했습니다.');
    }
  }

  async function deleteSelectedProducts() {
    if (selectedProductIds.length === 0) return notify('선택된 상품이 없습니다.');
    const idsToDelete = [...selectedProductIds];
    try {
      const response = await fetch('/api/products/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: idsToDelete }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '상품을 삭제하지 못했습니다.');
      const deletedIds = Array.isArray(payload.productIds) ? payload.productIds : idsToDelete;
      setProducts((current) => current.filter((product) => !deletedIds.includes(product.productId)));
      setSelectedProductIds((current) => current.filter((id) => !deletedIds.includes(id)));
      notify(`선택 상품 ${deletedIds.length}개 삭제 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '상품을 삭제하지 못했습니다.');
    }
  }

  async function createNewTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const body = {
        taskId: nextPrefixedId(tasks.map((task) => task.taskId), 'T'),
        title: newTask.title,
        description: newTask.description,
        reward: newTask.reward,
        isActive: newTask.isActive,
        sortOrder: newTask.sortOrder,
        allowedStudentIds: newTask.allowedStudentIds ?? [],
        availableFrom: newTask.availableFrom ?? '',
        dueAt: newTask.dueAt ?? '',
        prerequisiteTaskId: newTask.prerequisiteTaskId ?? '',
        ...(newTask.schedule ? (() => {
          const schedule = scheduleFormToPayload(scheduleDtoToForm(newTask.schedule));
          return schedule.ok ? { schedule: schedule.payload } : {};
        })() : {}),
      };
      const response = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '과제를 추가하지 못했습니다.');
      const createdTask = normalizeAdminTask(payload as TaskDraft);
      setTasks((current) => [...current, createdTask].sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title)));
      setNewTask(EMPTY_TASK);
      notify(`${createdTask.taskId} 과제 추가 완료`);
      if (createdTask.schedule?.recurrence.type !== 'NONE') {
        try {
          const taskResponse = await fetch('/api/tasks?includeInactive=1', { cache: 'no-store' });
          const taskPayload = await taskResponse.json();
          if (!taskResponse.ok || !Array.isArray(taskPayload)) throw new Error(taskPayload?.error ?? '최신 과제 회차를 불러오지 못했습니다.');
          if (!taskPayload.some((task: ClassTask) => task.taskId === createdTask.taskId)) throw new Error('생성한 과제의 최신 회차가 아직 조회되지 않습니다.');
          setTasks((current) => reconcileTaskProjections(current, taskPayload, [createdTask.taskId], [createdTask.taskId]));
        } catch (error) {
          notify(`${createdTask.taskId} 과제는 추가되었지만 회차 정보를 새로고침하지 못했습니다: ${error instanceof Error ? error.message : '최신 과제 회차를 불러오지 못했습니다.'}`);
          return;
        }
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '과제를 추가하지 못했습니다.');
    }
  }

  async function confirmTaskDelete() {
    if (!taskDeleteConfirmation || taskDeleteConfirmation.deleting) return;
    const { taskId } = taskDeleteConfirmation;
    setTaskDeleteConfirmation((current) => current ? { ...current, deleting: true, error: '' } : current);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '과제를 삭제하지 못했습니다.');
      setTasks((current) => current.filter((task) => task.taskId !== taskId));
      setSelectedTaskIds((current) => current.filter((id) => id !== taskId));
      setTaskDeleteConfirmation(null);
      notify(`${taskId} 과제 삭제 완료`);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : '과제를 삭제하지 못했습니다.';
      setTaskDeleteConfirmation((current) => current?.taskId === taskId ? { ...current, deleting: false, error: messageText } : current);
      notify(messageText);
    }
  }

  async function deleteSelectedTasks() {
    if (selectedTaskIds.length === 0) return notify('선택된 과제가 없습니다.');
    const idsToDelete = [...selectedTaskIds];
    try {
      const response = await fetch('/api/tasks/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: idsToDelete }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '과제를 삭제하지 못했습니다.');
      const deletedIds = Array.isArray(payload.taskIds) ? payload.taskIds : idsToDelete;
      setTasks((current) => current.filter((task) => !deletedIds.includes(task.taskId)));
      setSelectedTaskIds((current) => current.filter((id) => !deletedIds.includes(id)));
      notify(`선택 과제 ${deletedIds.length}개 삭제 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '과제를 삭제하지 못했습니다.');
    }
  }

  function requestTaskCompletionReset(target: TaskDialogTarget, opener: HTMLElement) {
    if (target.tasks.length === 0) return notify('선택된 과제가 없습니다.');
    setTaskResetConfirmation({ target, opener, operationId: crypto.randomUUID(), resetting: false, error: '' });
  }

  async function confirmTaskCompletionReset() {
    if (!taskResetConfirmation || taskResetConfirmation.resetting) return;
    const { target, operationId } = taskResetConfirmation;
    const taskIds = target.tasks.map((task) => task.taskId);
    setTaskResetConfirmation((current) => current ? { ...current, resetting: true, error: '' } : current);
    try {
      const response = await fetch('/api/tasks/completions/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds, operationId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '과제 완료 기록을 초기화하지 못했습니다.');
      let taskPayload: unknown;
      try {
        const taskResponse = await fetch('/api/tasks?includeInactive=1', { cache: 'no-store' });
        taskPayload = await taskResponse.json().catch(() => null);
        if (!taskResponse.ok || !Array.isArray(taskPayload)) throw new Error('refresh failed');
      } catch {
        setTaskResetConfirmation(null);
        closeTaskAssignmentEditor();
        notify('초기화는 완료됐지만 목록 새로고침 실패. 과제 설정의 새로고침 버튼을 눌러 주세요.');
        return;
      }
      setTasks((current) => reconcileTaskProjections(current, taskPayload, taskIds));
      if (target.kind === 'single' && taskAssignmentEditor?.taskId === taskIds[0]) {
        try {
          const status = await loadTaskAssignmentStatus(taskIds[0]);
          setTaskAssignmentEditor((current) => current?.taskId === taskIds[0] ? {
            ...current,
            assignedIds: status.assignedIds,
            completedIds: status.completedIds,
            initialAssignedIds: status.assignedIds,
            initialCompletedIds: status.completedIds,
            statusRows: status.statusRows,
          } : current);
        } catch {
          // The task list refresh is authoritative; assignment details can be reloaded by reopening.
        }
      }
      setTaskResetConfirmation(null);
      notify(`완료 기록 ${Number(payload.deletedCount ?? 0)}건 초기화 완료`);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : '과제 완료 기록을 초기화하지 못했습니다.';
      setTaskResetConfirmation((current) => current ? { ...current, resetting: false, error: errorText } : current);
      notify(errorText);
    }
  }

  async function createNewStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const body = { studentId: newStudent.studentId, name: newStudent.name, balance: newStudent.balance, status: newStudent.status };
      const response = await fetch('/api/students', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '학생을 추가하지 못했습니다.');
      setStudents((current) => sortStudentsById([...current, payload]));
      setNewStudent(EMPTY_STUDENT);
      notify(`${payload.studentId} 추가 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '학생을 추가하지 못했습니다.');
    }
  }

  async function createNewProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const body = {
        productId: nextPrefixedId(products.map((product) => product.productId), 'P'),
        name: newProduct.name,
        price: newProduct.price,
        stock: newProduct.stock,
        isActive: newProduct.isActive,
        imageUrl: newProduct.imageUrl,
        category: newProduct.category,
        sortOrder: newProduct.sortOrder,
      };
      const response = await fetch('/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '상품을 추가하지 못했습니다.');
      setProducts((current) => [...current, payload].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)));
      setNewProduct(EMPTY_PRODUCT);
      notify(`${payload.productId} 추가 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '상품을 추가하지 못했습니다.');
    }
  }

  async function applyCurrencyToStudent(decodedText: string, retry?: { mode: CurrencyMode; amount: number }) {
    const studentId = decodedText.trim();
    if (!studentId) return;
    if (currencyInFlight.current) return;
    const mode = retry?.mode ?? currencyMode;
    const amount = retry?.amount ?? currencyAmount;
    const semanticKey = JSON.stringify({ studentIds: [studentId], mode, amount });
    if (currencyAttempt.current?.semanticKey !== semanticKey) {
      currencyAttempt.current = { semanticKey, operationId: crypto.randomUUID() };
    }
    const operationId = currencyAttempt.current.operationId;
    currencyInFlight.current = true;
    setCurrencyScannerOpen(false);
    setCurrencyLoading(true);
    try {
      const response = await fetch('/api/students/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: [studentId], mode, amount, operationId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '화폐를 조정하지 못했습니다.');
      const updatedBalance = Array.isArray(payload) ? payload.find((item: { studentId: string }) => item.studentId === studentId)?.balance : undefined;
      if (typeof updatedBalance === 'number') {
        updateStudent(studentId, { balance: updatedBalance });
      }
      setCurrencyResult({
        status: 'success',
        mode,
        studentId,
        amount,
        message: `${studentId} 학생에게 ${amount} ${mode === 'add' ? '지급' : '회수'} 완료`,
      });
      currencyAttempt.current = null;
    } catch (error) {
      setCurrencyResult({
        status: 'failure',
        mode,
        studentId,
        amount,
        message: error instanceof Error ? error.message : '화폐를 조정하지 못했습니다.',
      });
    } finally {
      currencyInFlight.current = false;
      setCurrencyLoading(false);
    }
  }

  function retryCurrencyScan() {
    if (currencyResult?.status === 'failure') {
      const failed = currencyResult;
      setCurrencyResult(null);
      void applyCurrencyToStudent(failed.studentId, { mode: failed.mode, amount: failed.amount });
      return;
    }
    setCurrencyResult(null);
    setCurrencyManualId('');
    setCurrencyScannerOpen(true);
  }

  function selectAdminTab(nextTab: AdminTab, focus = false) {
    setActiveTab(nextTab);
    if (nextTab === 'transactions') setHasOpenedTransactions(true);
    if (focus) adminTabRefs.current[nextTab]?.focus();
  }

  function handleAdminTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, currentTab: AdminTab) {
    const currentIndex = tabs.findIndex((tab) => tab.id === currentTab);
    let nextTab: AdminTab | undefined;
    if (event.key === 'ArrowRight') nextTab = tabs[(currentIndex + 1) % tabs.length].id;
    if (event.key === 'ArrowLeft') nextTab = tabs[(currentIndex - 1 + tabs.length) % tabs.length].id;
    if (event.key === 'Home') nextTab = tabs[0].id;
    if (event.key === 'End') nextTab = tabs[tabs.length - 1].id;
    if (!nextTab) return;
    event.preventDefault();
    selectAdminTab(nextTab, true);
  }

  function selectStoreTab(nextTab: StoreTab, focus = false) {
    setStoreTab(nextTab);
    if (nextTab === 'promotions') setHasOpenedPromotions(true);
    if (focus) storeTabRefs.current[nextTab]?.focus();
  }

  function handleStoreTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, currentTab: StoreTab) {
    const currentIndex = storeTabs.indexOf(currentTab);
    let nextTab: StoreTab | undefined;
    if (event.key === 'ArrowRight') nextTab = storeTabs[(currentIndex + 1) % storeTabs.length];
    if (event.key === 'ArrowLeft') nextTab = storeTabs[(currentIndex - 1 + storeTabs.length) % storeTabs.length];
    if (event.key === 'Home') nextTab = storeTabs[0];
    if (event.key === 'End') nextTab = storeTabs[storeTabs.length - 1];
    if (!nextTab) return;
    event.preventDefault();
    selectStoreTab(nextTab, true);
  }

  const currencyActionLabel = currencyMode === 'add' ? '지급' : '회수';
  const themeColor = normalizeThemeColor(settings.themeColor);
  const semantic = themeStyles(themeColor);
  const theme = {
    shell: semantic.shell,
    pageText: semantic.text,
    accentText: semantic.accentText,
    accentBg: semantic.accentSolid,
    actionText: semantic.accentOnSolid,
    selectedTab: `${semantic.accentSolid} ${semantic.accentOnSolid}`,
    idleTab: `${semantic.accentSoft} ${semantic.text} ${semantic.hover} ${semantic.hoverText}`,
    statBg: semantic.surfaceRaised,
    logoColor: 'bg-[var(--theme-accent-text)]',
    softBg: semantic.surfaceRaised,
    softText: semantic.mutedText,
  };
  const fontFamilyCss = getFontFamilyCss(settings.fontFamily);
  const rootStyle = { ...semantic.variables, ...(fontFamilyCss ? { fontFamily: fontFamilyCss } : {}) };

  if (isInitialLoading) {
    return <LoadingScreen title="시트 정보 불러오는 중" message="관리자 데이터와 테마 설정을 불러오는 중입니다." />;
  }

  return (
    <main data-testid="admin-shell" style={rootStyle} className={`min-h-screen ${theme.shell} ${theme.pageText} p-2 sm:p-3 lg:p-5`}>
      <div data-testid="admin-background" inert={taskHistory || taskDeleteConfirmation || taskScheduleEditor || taskAssignmentEditor || taskResetConfirmation ? true : undefined} aria-hidden={taskHistory || taskDeleteConfirmation || taskScheduleEditor || taskAssignmentEditor || taskResetConfirmation ? true : undefined}>
      <section className="mx-auto flex w-full max-w-[1280px] flex-col gap-3 lg:gap-4">
        <header data-testid="admin-header" className={`rounded-[1.25rem] border ${semantic.border} ${semantic.surface} px-4 py-4 text-center ${semantic.text} shadow-sm sm:rounded-[1.75rem] md:px-6`}>
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <span className="inline-flex h-16 w-16 shrink-0 items-center justify-center">
              <span role="img" aria-label="학급 보상 시스템 로고" className={`h-16 w-16 ${theme.logoColor} [mask-image:url('/class-reward-system-icon.png')] [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain]`} />
            </span>
            <div>
              <h1 className={`text-3xl font-black tracking-tight ${semantic.text} sm:text-4xl md:text-5xl`}>학급 보상 시스템</h1>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <SummaryCard label="학생" value={`${summary.students}명`} toneClass={theme.statBg} accentClass={theme.accentText} />
            <SummaryCard label="판매 상품" value={`${summary.activeProducts}개`} toneClass={theme.statBg} accentClass={theme.accentText} />
            <SummaryCard label="전체 재고" value={`${summary.totalStock}개`} toneClass={theme.statBg} accentClass={theme.accentText} />
            <SummaryCard label="활성 과제" value={`${summary.activeTasks}개`} toneClass={theme.statBg} accentClass={theme.accentText} />
          </div>
          {message ? <p className="mt-3 rounded-2xl bg-rose-100 p-3 text-sm font-bold text-rose-700">{message}</p> : null}
        </header>

        <nav data-testid="admin-tabs" role="tablist" aria-label="관리자 메뉴" className={`grid grid-cols-2 gap-2 rounded-[1.5rem] border ${semantic.border} ${semantic.surface} p-2 shadow-sm sm:grid-cols-4 lg:grid-cols-8`}>
          {tabs.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                ref={(node) => { adminTabRefs.current[tab.id] = node; }}
                key={tab.id}
                id={`admin-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-controls={`admin-panel-${tab.id}`}
                aria-selected={selected}
                aria-label={tab.label}
                tabIndex={selected ? 0 : -1}
                onKeyDown={(event) => handleAdminTabKeyDown(event, tab.id)}
                onClick={() => selectAdminTab(tab.id)}
                className={`rounded-[1rem] px-2 py-3 text-left transition ${selected ? `${theme.selectedTab} shadow-sm` : theme.idleTab}`}
              >
                <span className="block text-sm font-black sm:text-base">{tab.label}</span>
              </button>
            );
          })}
          <AdminNavLink href="/" title="매점 바로가기" className={theme.idleTab} />
          <AdminNavLink href="/bank" title="은행 바로가기" className={theme.idleTab} />
        </nav>

        {activeTab === 'settings' ? (
          <section id="admin-panel-settings" role="tabpanel" aria-labelledby="admin-tab-settings" aria-label="시스템 설정" className="grid gap-3">
            <SettingsForm
              linkedStudentCount={students.length}
              linkedProductCount={products.length}
              onSettingsSaved={() => loadLinkedSheetData({ silent: true })}
            />
          </section>
        ) : null}

        {activeTab === 'students' ? (
          <section id="admin-panel-students" role="tabpanel" aria-labelledby="admin-tab-students" aria-label="학생 관리" className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
            <SectionCard title="새 학생 추가" description="관리자 화면에서는 초기 잔액을 음수로도 지정할 수 있습니다." compact>
              <form onSubmit={createNewStudent} className="space-y-2">
                <TextInput label="새 학생 ID" value={newStudent.studentId} onChange={(value) => setNewStudent((current) => ({ ...current, studentId: value }))} compact />
                <TextInput label="새 학생 이름" value={newStudent.name} onChange={(value) => setNewStudent((current) => ({ ...current, name: value }))} compact />
                <NumberInput label="새 학생 잔액" value={newStudent.balance} onChange={(value) => setNewStudent((current) => ({ ...current, balance: value }))} compact />
                <button className={`w-full rounded-xl ${theme.accentBg} py-3 font-black ${theme.actionText} shadow-sm`} type="submit">새 학생 추가</button>
              </form>
            </SectionCard>

            <SectionCard
              title="학생 명단"
              action={(
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" aria-label="학생 명단 새로고침" onClick={refreshStudents} className={`rounded-xl border ${semantic.border} ${semantic.surfaceRaised} px-4 py-2 text-sm font-black ${semantic.text} shadow-sm`}>새로고침</button>
                  <button type="button" onClick={saveAllStudents} className={`rounded-xl ${theme.accentBg} px-4 py-2 text-sm font-black ${theme.actionText} shadow-sm`}>전체 저장</button>
                </div>
              )}
              compact
            >
              <div className={`mb-3 rounded-2xl border ${semantic.border} ${theme.softBg} p-3`}>
                <div className="flex flex-wrap items-center gap-2">
                  <label className={`flex items-center gap-2 rounded-xl ${semantic.surface} px-3 py-2 text-sm font-black`}>
                    <input aria-label="전체 학생 선택" checked={allStudentsSelected} onChange={(event) => setSelectedStudentIds(event.target.checked ? students.map((student) => student.studentId) : [])} type="checkbox" />
                    전체 선택 ({selectedStudentIds.length}/{students.length})
                  </label>
                  <select aria-label="선택 학생 작업" value={bulkMode} onChange={(event) => setBulkMode(event.target.value as BulkMode)} className={`rounded-xl border ${semantic.border} ${semantic.input} px-3 py-2 text-sm font-bold ${semantic.text}`}>
                    <option value="set">특정 값으로 설정</option>
                    <option value="add">금액 추가</option>
                    <option value="subtract">금액 제거</option>
                  </select>
                  <input aria-label="선택 학생 금액" value={bulkAmount} onChange={(event) => setBulkAmount(Number(event.target.value))} type="number" className={`w-28 rounded-xl border ${semantic.border} ${semantic.input} px-3 py-2 text-sm font-bold ${semantic.text}`} />
                  <span className="text-xs font-bold text-[var(--theme-muted-text)]">회수 후 음수 잔액 가능</span>
                  <button type="button" disabled={selectedStudentIds.length === 0} onClick={applyBulkStudentBalance} className={`rounded-xl bg-slate-950 px-4 py-2 text-sm font-black text-white ${disabledActionClass}`}>화폐 수정</button>
                  <button type="button" disabled={selectedStudentIds.length === 0} onClick={deleteSelectedStudents} className={`rounded-xl bg-rose-500 px-4 py-2 text-sm font-black text-white ${disabledActionClass}`}>삭제</button>
                  <button type="button" disabled={selectedStudentIds.length === 0} onClick={saveSelectedStudents} className={`rounded-xl ${theme.accentBg} px-4 py-2 text-sm font-black ${theme.actionText} ${disabledActionClass}`}>선택 저장</button>
                  <button
                    type="button"
                    disabled={selectedStudentIds.length === 0}
                    onClick={() => setQrPrintStudents(students.filter((student) => selectedStudentIds.includes(student.studentId)))}
                    className="rounded-xl bg-amber-100 px-4 py-2 text-sm font-black text-amber-900 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    선택 학생 QR 발급
                  </button>
                </div>
              </div>

              <div data-testid="student-list" className={`overflow-hidden rounded-2xl border ${semantic.border} ${semantic.surface} divide-y ${semantic.divider}`}>
                <div data-testid="student-header-row" className={`grid grid-cols-[24px_56px_minmax(4rem,1fr)_78px_52px_42px] items-center gap-0.5 ${semantic.surfaceRaised} px-1.5 py-1 text-[10px] font-black ${semantic.mutedText}`}>
                  <span>선택</span>
                  <span>ID</span>
                  <span>이름</span>
                  <span>잔액</span>
                  <span>상태</span>
                  <span>삭제</span>
                </div>
                {students.map((student) => (
                  <div data-testid="student-row" className="grid grid-cols-[24px_56px_minmax(4rem,1fr)_78px_52px_42px] items-center gap-0.5 px-1.5 py-1 text-[11px]" key={student.studentId}>
                    <label className="flex items-center justify-center">
                      <input aria-label={`${student.studentId} 선택`} checked={selectedStudentIds.includes(student.studentId)} onChange={() => toggleStudent(student.studentId)} type="checkbox" />
                      <span className="sr-only">선택</span>
                    </label>
                    <p className={`min-w-0 truncate font-black ${theme.accentText}`}>{student.studentId}</p>
                    <TextInput dataTestId="student-name-field" label={`${student.studentId} 이름`} value={student.name} onChange={(value) => updateStudent(student.studentId, { name: value })} dense />
                    <NumberInput label={`${student.studentId} 잔액`} value={student.balance} onChange={(value) => updateStudent(student.studentId, { balance: value })} dense />
                    <label className={`block min-w-0 text-xs font-bold ${semantic.mutedText}`}>
                      <span className="sr-only">상태</span>
                      <select aria-label={`${student.studentId} 상태`} className={`h-8 w-full rounded-lg border ${semantic.border} ${semantic.input} px-1 text-xs ${semantic.text}`} onChange={(event) => updateStudent(student.studentId, { status: event.target.value as Student['status'] })} value={student.status ?? 'ACTIVE'}>
                        <option value="ACTIVE">활성</option>
                        <option value="INACTIVE">비활성</option>
                      </select>
                    </label>
                    <button aria-label={`${student.studentId} 학생 삭제`} className="h-8 rounded-lg bg-rose-100 px-1 text-xs font-black text-rose-700" onClick={() => deleteStudentRow(student.studentId)} type="button">
                      삭제
                    </button>
                  </div>
                ))}
              </div>
            </SectionCard>
          </section>
        ) : null}

        {activeTab === 'products' ? (
          <section id="admin-panel-products" role="tabpanel" aria-labelledby="admin-tab-products" aria-label="매점 관리" className="grid gap-3">
            <div role="tablist" aria-label="매점 관리 메뉴" className={`grid grid-cols-2 gap-2 rounded-2xl border ${semantic.border} ${semantic.surface} p-2 shadow-sm`}>
              <button ref={(node) => { storeTabRefs.current.inventory = node; }} id="admin-store-tab-inventory" type="button" role="tab" aria-controls="admin-store-panel-inventory" aria-selected={storeTab === 'inventory'} tabIndex={storeTab === 'inventory' ? 0 : -1} onKeyDown={(event) => handleStoreTabKeyDown(event, 'inventory')} onClick={() => selectStoreTab('inventory')} className={`rounded-xl px-4 py-3 font-black ${storeTab === 'inventory' ? `${theme.selectedTab} shadow-sm` : theme.idleTab}`}>상품·재고</button>
              <button ref={(node) => { storeTabRefs.current.promotions = node; }} id="admin-store-tab-promotions" type="button" role="tab" aria-controls="admin-store-panel-promotions" aria-selected={storeTab === 'promotions'} tabIndex={storeTab === 'promotions' ? 0 : -1} onKeyDown={(event) => handleStoreTabKeyDown(event, 'promotions')} onClick={() => selectStoreTab('promotions')} className={`rounded-xl px-4 py-3 font-black ${storeTab === 'promotions' ? `${theme.selectedTab} shadow-sm` : theme.idleTab}`}>행사 관리</button>
            </div>
            <div id="admin-store-panel-inventory" role="tabpanel" aria-labelledby="admin-store-tab-inventory" hidden={storeTab !== 'inventory'} className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
            <SectionCard title="새 상품 추가" description="상품과 가격, 재고를 등록합니다." compact>
              <form onSubmit={createNewProduct} className="space-y-2">
                <TextInput label="새 상품명" value={newProduct.name} onChange={(value) => setNewProduct((current) => ({ ...current, name: value }))} compact />
                <div className="grid grid-cols-2 gap-2">
                  <NumberInput label="새 상품 가격" value={newProduct.price} onChange={(value) => setNewProduct((current) => ({ ...current, price: value }))} compact />
                  <NumberInput label="새 상품 재고" value={newProduct.stock} onChange={(value) => setNewProduct((current) => ({ ...current, stock: value }))} compact />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <TextInput label="새 상품 카테고리" value={newProduct.category} onChange={(value) => setNewProduct((current) => ({ ...current, category: value }))} compact />
                  <TextInput label="새 상품 이미지 주소" value={newProduct.imageUrl} onChange={(value) => setNewProduct((current) => ({ ...current, imageUrl: value }))} compact />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <NumberInput label="새 상품 정렬" value={newProduct.sortOrder} onChange={(value) => setNewProduct((current) => ({ ...current, sortOrder: value }))} compact />
                </div>
                <button className={`w-full rounded-xl ${theme.accentBg} py-3 font-black ${theme.actionText} shadow-sm`} type="submit">새 상품 추가</button>
              </form>
            </SectionCard>

            <SectionCard title="상품 · 재고 관리" action={(
              <div className="flex flex-wrap gap-2">
                <button type="button" aria-label="상품 · 재고 관리 새로고침" onClick={refreshProducts} className={`rounded-xl ${semantic.surfaceRaised} px-4 py-2 text-sm font-black ${semantic.text} shadow-sm`}>새로고침</button>
                <button type="button" onClick={saveAllProducts} className={`rounded-xl ${theme.accentBg} px-4 py-2 text-sm font-black ${theme.actionText} shadow-sm`}>전체 저장</button>
              </div>
            )} compact>
              <div className={`mb-3 rounded-2xl border ${semantic.border} ${theme.softBg} p-3`}>
                <label className={`flex w-fit items-center gap-2 rounded-xl ${semantic.surface} px-3 py-2 text-sm font-black`}>
                  <input aria-label="전체 상품 선택" checked={allProductsSelected} onChange={(event) => setSelectedProductIds(event.target.checked ? products.map((product) => product.productId) : [])} type="checkbox" />
                  전체 선택 ({selectedProductIds.length}/{products.length})
                </label>
                <button type="button" disabled={selectedProductIds.length === 0} onClick={deleteSelectedProducts} className={`mt-2 rounded-xl bg-rose-500 px-4 py-2 text-sm font-black text-white ${disabledActionClass}`}>삭제</button>
                <button type="button" disabled={selectedProductIds.length === 0} onClick={saveSelectedProducts} className={`ml-2 mt-2 rounded-xl ${theme.accentBg} px-4 py-2 text-sm font-black ${theme.actionText} ${disabledActionClass}`}>선택 저장</button>
              </div>
              <div data-testid="product-list" className={`overflow-hidden rounded-2xl border ${semantic.border} ${semantic.surface} divide-y ${semantic.divider}`}>
                <div data-testid="product-header-row" className={`grid grid-cols-[24px_minmax(3rem,1fr)_56px_48px_36px_minmax(3rem,0.8fr)_40px_30px_34px] items-center gap-0.5 ${semantic.surfaceRaised} px-1.5 py-1 text-[10px] font-black ${semantic.mutedText}`}>
                  <span>선택</span>
                  <span>상품명</span>
                  <span>가격</span>
                  <span>재고</span>
                  <span>분류</span>
                  <span>이미지</span>
                  <span>순서</span>
                  <span>판매</span>
                  <span>삭제</span>
                </div>
                {products.map((product) => (
                  <div data-testid="product-row" className="grid grid-cols-[24px_minmax(3rem,1fr)_56px_48px_36px_minmax(3rem,0.8fr)_40px_30px_34px] items-center gap-0.5 px-1.5 py-1 text-[11px]" key={product.productId}>
                    <label className="flex items-center justify-center">
                      <input aria-label={`${product.productId} 선택`} checked={selectedProductIds.includes(product.productId)} onChange={() => toggleProduct(product.productId)} type="checkbox" />
                      <span className="sr-only">선택</span>
                    </label>
                    <TextInput dataTestId="product-name-field" label={`${product.productId} 상품명`} value={product.name} onChange={(value) => updateProduct(product.productId, { name: value })} dense />
                    <NumberInput label={`${product.productId} 가격`} value={product.price} onChange={(value) => updateProduct(product.productId, { price: value })} dense />
                    <NumberInput label={`${product.productId} 재고`} value={product.stock} onChange={(value) => updateProduct(product.productId, { stock: value })} dense />
                    <TextInput label={`${product.productId} 카테고리`} value={product.category ?? ''} onChange={(value) => updateProduct(product.productId, { category: value })} dense />
                    <button
                      aria-label={`${product.productId} 이미지 주소 편집`}
                      className={`h-8 min-w-0 truncate rounded-lg border ${semantic.border} ${semantic.input} px-1 text-left text-[10px] font-bold ${semantic.mutedText}`}
                      onClick={() => setImageEditor({ productId: product.productId, value: product.imageUrl ?? '' })}
                      type="button"
                    >
                      {product.imageUrl ? 'URL' : '이미지'}
                    </button>
                    <NumberInput label={`${product.productId} 정렬`} value={product.sortOrder} onChange={(value) => updateProduct(product.productId, { sortOrder: value })} dense />
                    <label className={`flex h-8 items-center justify-center rounded-lg ${theme.softBg} text-[10px] font-bold ${theme.softText}`}>
                      <input aria-label={`${product.productId} 판매중`} checked={Boolean(product.isActive)} onChange={(event) => updateProduct(product.productId, { isActive: event.target.checked })} type="checkbox" />
                    </label>
                    <button aria-label={`${product.productId} 상품 삭제`} className="h-8 rounded-lg bg-rose-100 px-1 text-[10px] font-black text-rose-700" onClick={() => deleteProductRow(product.productId)} type="button">
                      삭제
                    </button>
                  </div>
                ))}
              </div>
            </SectionCard>
            </div>
            <section id="admin-store-panel-promotions" role="tabpanel" aria-labelledby="admin-store-tab-promotions" hidden={storeTab !== 'promotions'}>
              {hasOpenedPromotions ? (
                <PromotionAdminPanel
                  products={products}
                  currencyUnit={settings.currencyUnit ?? '원'}
                  timeZone="Asia/Seoul"
                  themeColor={themeColor}
                />
              ) : null}
            </section>
          </section>
        ) : null}

        {activeTab === 'tasks' ? (
          <section id="admin-panel-tasks" data-testid="task-panel" role="tabpanel" aria-labelledby="admin-tab-tasks" aria-label="과제 설정" className="grid min-w-0 gap-3 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
            <div data-testid="new-task-card" className="min-w-0">
            <SectionCard title="새 과제 추가" description="은행 페이지에서 학생이 완료할 보상 과제를 등록합니다." compact>
              <form onSubmit={createNewTask} className="space-y-2">
                <TextInput label="새 과제명" value={newTask.title} onChange={(value) => setNewTask((current) => ({ ...current, title: value }))} compact />
                <label className={`block text-xs font-bold ${semantic.mutedText}`}>
                  <span>새 과제 설명</span>
                  <textarea aria-label="새 과제 설명" value={newTask.description} onChange={(event) => setNewTask((current) => ({ ...current, description: event.target.value }))} className={`mt-1 min-h-24 w-full rounded-xl border ${semantic.border} ${semantic.input} px-2 py-2 text-sm ${semantic.text} outline-none transition ${semantic.ring} focus:ring-2`} />
                </label>
                <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
                  <NumberInput label="새 과제 보상" value={newTask.reward} onChange={(value) => setNewTask((current) => ({ ...current, reward: value }))} compact />
                  <NumberInput label="새 과제 정렬" value={newTask.sortOrder} onChange={(value) => setNewTask((current) => ({ ...current, sortOrder: value }))} compact />
                </div>
                <label className={`flex items-center gap-2 rounded-xl ${theme.softBg} px-3 py-2 text-sm font-black ${theme.softText}`}>
                  <input aria-label="새 과제 활성" checked={newTask.isActive} onChange={(event) => setNewTask((current) => ({ ...current, isActive: event.target.checked }))} type="checkbox" />
                  은행 페이지에 표시
                </label>
                <button type="button" aria-label="새 과제 기한 설정" onClick={(event) => openTaskScheduleEditor(null, event.currentTarget)} className={`w-full rounded-xl ${theme.softBg} py-3 font-black ${theme.accentText}`}>기한 설정</button>
                <button type="button" aria-label="새 과제 과제 부여" onClick={(event) => openTaskAssignmentEditor(null, newTask.allowedStudentIds ?? [], event.currentTarget)} className="w-full rounded-xl bg-sky-100 py-3 font-black text-sky-800">과제 부여{newTask.allowedStudentIds.length ? ` (${newTask.allowedStudentIds.length}명)` : ''}</button>
                <button className={`w-full rounded-xl ${theme.accentBg} py-3 font-black ${theme.actionText} shadow-sm`} type="submit">새 과제 추가</button>
              </form>
            </SectionCard>
            </div>

            <div data-testid="task-list-card" className="min-w-0">
            <SectionCard title="과제 설정" action={(
              <div className="flex flex-wrap gap-2">
                <button type="button" aria-label="과제 설정 새로고침" onClick={refreshTasks} className={`rounded-xl ${semantic.surfaceRaised} px-4 py-2 text-sm font-black ${semantic.text} shadow-sm`}>새로고침</button>
                <button type="button" onClick={() => { setQrTaskResult(null); setQrTaskScan(null); setQrTaskPickerOpen(true); }} className="rounded-xl bg-sky-100 px-4 py-2 text-sm font-black text-sky-800 shadow-sm">QR 과제 부여</button>
                <button type="button" onClick={saveAllTasks} className={`rounded-xl ${theme.accentBg} px-4 py-2 text-sm font-black ${theme.actionText} shadow-sm`}>전체 저장</button>
              </div>
            )} compact>
              <div className={`mb-3 rounded-2xl border ${semantic.border} ${theme.softBg} p-3`}>
                <div data-testid="task-bulk-actions" className="flex flex-wrap items-center gap-2">
                <label className={`flex w-fit items-center gap-2 rounded-xl ${semantic.surface} px-3 py-2 text-sm font-black`}>
                  <input aria-label="전체 과제 선택" checked={allTasksSelected} onChange={(event) => setSelectedTaskIds(event.target.checked ? tasks.map((task) => task.taskId) : [])} type="checkbox" />
                  전체 선택 ({selectedTaskIds.length}/{tasks.length})
                </label>
                <button type="button" aria-label="선택 과제 기한" disabled={selectedTaskIds.length === 0} onClick={(event) => openBulkTaskScheduleEditor(event.currentTarget)} className={`rounded-xl ${theme.softBg} px-4 py-2 text-sm font-black ${theme.accentText} ${disabledActionClass}`}>기한</button>
                <button type="button" aria-label="선택 과제 과제 부여" disabled={selectedTaskIds.length === 0} onClick={(event) => openBulkTaskAssignmentEditor(event.currentTarget)} className={`rounded-xl bg-sky-100 px-4 py-2 text-sm font-black text-sky-800 ${disabledActionClass}`}>과제 부여</button>
                <button type="button" disabled={selectedTaskIds.length === 0} onClick={deleteSelectedTasks} className={`rounded-xl bg-rose-500 px-4 py-2 text-sm font-black text-white ${disabledActionClass}`}>삭제</button>
                <button type="button" disabled={selectedTaskIds.length === 0} onClick={saveSelectedTasks} className={`rounded-xl ${theme.accentBg} px-4 py-2 text-sm font-black ${theme.actionText} ${disabledActionClass}`}>선택 저장</button>
                </div>
              </div>
              <div data-testid="task-list-scroll" className={`overflow-x-auto rounded-2xl border ${semantic.border} ${semantic.surface}`}>
                <div className={`min-w-[720px] divide-y ${semantic.divider}`}>
                <div data-testid="task-header-row" className={`grid grid-cols-[24px_minmax(5rem,1fr)_64px_48px_38px_minmax(3rem,0.7fr)_minmax(180px,auto)] items-center gap-0.5 ${semantic.surfaceRaised} px-1.5 py-1 text-[10px] font-black ${semantic.mutedText}`}>
                  <span>선택</span><span>과제명</span><span>보상</span><span>순서</span><span>활성</span><span>상세</span><span>작업</span>
                </div>
                {tasks.map((task) => (
                  <div data-testid="task-row" key={task.taskId} className="grid grid-cols-[24px_minmax(5rem,1fr)_64px_48px_38px_minmax(3rem,0.7fr)_minmax(180px,auto)] items-center gap-0.5 px-1.5 py-1 text-[11px]">
                    <label className="flex items-center justify-center">
                      <input aria-label={`${task.taskId} 선택`} checked={selectedTaskIds.includes(task.taskId)} onChange={() => toggleTask(task.taskId)} type="checkbox" />
                      <span className="sr-only">선택</span>
                    </label>
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="shrink-0 whitespace-nowrap rounded-full bg-[var(--theme-surface-raised)] px-2 py-0.5 text-[9px] font-black text-[var(--theme-muted-text)]">{taskAvailabilityLabel(task)}</span>
                      <div data-testid="task-title-input-wrapper" className="min-w-0 flex-1">
                        <TextInput label={`${task.taskId} 과제명`} value={task.title} onChange={(value) => updateTask(task.taskId, { title: value })} dense />
                      </div>
                    </div>
                    <NumberInput label={`${task.taskId} 보상`} value={task.reward} onChange={(value) => updateTask(task.taskId, { reward: value })} dense />
                    <NumberInput label={`${task.taskId} 정렬`} value={task.sortOrder} onChange={(value) => updateTask(task.taskId, { sortOrder: value })} dense />
                    <label className={`flex h-8 items-center justify-center rounded-lg ${theme.softBg} text-[10px] font-bold ${theme.softText}`}>
                      <input aria-label={`${task.taskId} 활성`} checked={Boolean(task.isActive)} onChange={(event) => updateTask(task.taskId, { isActive: event.target.checked })} type="checkbox" />
                    </label>

                    <button
                      aria-label={`${task.taskId} 상세 설정 편집`}
                      className={`h-8 min-w-0 truncate rounded-lg border ${semantic.border} ${semantic.input} px-1 text-left text-[10px] font-bold ${semantic.mutedText}`}
                      onClick={() => setTaskDescriptionEditor({ taskId: task.taskId, value: task.description })}
                      type="button"
                    >
                      {task.description ? '상세 있음' : '상세'}
                    </button>
                    <div data-testid="task-row-actions" className="flex flex-wrap justify-end gap-1">
                      <button type="button" aria-label={`${task.taskId} 기한 설정`} onClick={(event) => openTaskScheduleEditor(task, event.currentTarget)} className={`h-8 rounded-lg border ${semantic.border} ${theme.softBg} px-2 text-[10px] font-black ${theme.accentText} outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--theme-surface)]`}>기한</button>
                      <button type="button" aria-label={`${task.taskId} 기록 보기`} onClick={(event) => void openTaskHistory(task, event.currentTarget)} className={`h-8 rounded-lg border ${semantic.border} ${semantic.surfaceRaised} px-2 text-[10px] font-black ${semantic.text} outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--theme-surface)]`}>기록</button>
                      <button type="button" aria-label={`${task.taskId} 과제 부여`} onClick={(event) => openTaskAssignmentEditor(task.taskId, task.allowedStudentIds ?? [], event.currentTarget)} className="h-8 rounded-lg border border-sky-500 bg-sky-100 px-2 text-[10px] font-black text-sky-800 outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--theme-surface)]">과제 부여</button>
                      <button type="button" aria-label={`${task.taskId} 과제 삭제`} onClick={(event) => requestTaskDelete(task, event.currentTarget)} className="h-8 rounded-lg border border-rose-500 bg-rose-100 px-2 text-[10px] font-black text-rose-800 outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--theme-surface)]">삭제</button>
                    </div>
                  </div>
                ))}
                </div>
              </div>
            </SectionCard>
            </div>
          </section>
        ) : null}

        <section id="admin-panel-transactions" role="tabpanel" aria-labelledby="admin-tab-transactions" aria-label="거래 내역 확인" hidden={activeTab !== 'transactions'}>
          {hasOpenedTransactions ? <TransactionsPanel embedded summaryToneClass={theme.statBg} summaryAccentClass={theme.accentText} /> : null}
        </section>

        {activeTab === 'currency' ? (
          <section id="admin-panel-currency" role="tabpanel" aria-labelledby="admin-tab-currency" aria-label="화폐 지급/회수" className="mx-auto grid w-full max-w-5xl gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
            <SectionCard title="화폐 지급/회수" compact>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setCurrencyMode('add')} className={`rounded-2xl px-4 py-4 text-xl font-black ${currencyMode === 'add' ? `${theme.accentBg} ${theme.actionText}` : `${theme.softBg} ${theme.softText}`}`}>지급</button>
                <button type="button" onClick={() => setCurrencyMode('subtract')} className={`rounded-2xl px-4 py-4 text-xl font-black ${currencyMode === 'subtract' ? 'bg-rose-500 text-white' : 'bg-rose-50 text-slate-700'}`}>회수</button>
              </div>
              <label className={`mt-3 block text-sm font-black ${semantic.mutedText}`}>
                <span>금액</span>
                <input aria-label="지급/회수 금액" value={currencyAmount} onChange={(event) => setCurrencyAmount(Number(event.target.value))} type="number" min="0" className={`mt-2 w-full rounded-2xl border ${semantic.border} ${semantic.input} px-4 py-4 text-2xl font-black ${semantic.text} outline-none focus:ring-2 ${semantic.ring}`} />
              </label>
              <button type="button" onClick={() => { setCurrencyResult(null); setCurrencyManualId(''); setCurrencyScannerOpen(true); }} className="mt-3 w-full rounded-2xl bg-slate-950 py-4 text-xl font-black text-white">
                QR 인식 시작
              </button>
            </SectionCard>
            <SectionCard title="이용 안내" compact>
              <ul className="space-y-3 text-sm font-bold leading-relaxed text-[var(--theme-muted-text)] sm:text-base">
                <li>• QR코드를 인식하여 화폐를 지급하거나 회수할 수 있습니다.</li>
                <li>• 회수하는 금액이 잔액보다 큰 경우, 차액만큼 잔액이 음수로 표시됩니다. (예: 잔액 10인 학생에게 15만큼 회수하는 경우 잔액이 -5로 기록됨)</li>
              </ul>
            </SectionCard>
          </section>
        ) : null}
        {tabs.filter((tab) => tab.id !== activeTab && tab.id !== 'transactions').map((tab) => (
          <section key={`inactive-${tab.id}`} id={`admin-panel-${tab.id}`} role="tabpanel" aria-labelledby={`admin-tab-${tab.id}`} hidden />
        ))}
      </section>
      </div>
      {isSavingChanges ? <LoadingDialog title="변경 사항 저장 중" message="변경 사항을 저장하는 중입니다." /> : null}
      {isSavingTaskSchedule ? <LoadingDialog title="기한 설정 저장 중" message="기한과 반복 설정을 저장하고 최신 과제 목록을 불러오는 중입니다." /> : null}
      {taskResetConfirmation?.resetting ? <LoadingDialog title="완료 기록 초기화 중" message="완료 기록을 초기화하고 최신 과제 목록을 불러오는 중입니다." restoreFocus={false} /> : null}
      {isRefreshingLists ? <LoadingDialog title="새로고침 중" message="새로고침하는 중입니다." /> : null}
      {imageEditor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-label="상품 이미지 등록" className="w-full max-w-xl rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-surface)] p-4 text-[var(--theme-text)] shadow-2xl">
            <h2 className="text-xl font-black">상품 이미지 등록</h2>
            <div className="mt-2 space-y-1 rounded-2xl bg-[var(--theme-surface-raised)] p-3 text-sm font-bold leading-relaxed text-[var(--theme-muted-text)]">
              <p>※ 상품 이미지 등록하는 방법</p>
              <p>① 구글 이미지 검색 등으로 원하는 상품 이미지를 찾습니다.</p>
              <p>② 원하는 이미지를 마우스로 우클릭(모바일에서는 꾹 누르기)하고 &apos;이미지 주소 복사&apos;를 선택합니다.</p>
              <p>③ 복사한 이미지 주소를 아래 창에 붙여넣고 &apos;상품 이미지 적용&apos; 버튼을 누릅니다.</p>
              <p>④ &apos;전체 저장&apos;을 눌러 상품 이미지를 저장 및 적용합니다.</p>
            </div>
            <label className="mt-4 block text-sm font-bold text-[var(--theme-muted-text)]">
              <span>이미지 주소 전체 입력</span>
              <textarea
                aria-label="이미지 주소 전체 입력"
                className="mt-2 min-h-32 w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] p-3 text-sm text-[var(--theme-text)] outline-none focus:ring-2 focus:ring-[var(--theme-focus-ring)]"
                value={imageEditor.value}
                onChange={(event) => setImageEditor((current) => current ? { ...current, value: event.target.value } : current)}
              />
            </label>
            <div className="mt-4 flex gap-2">
              <button type="button" className="flex-1 rounded-xl bg-slate-200 py-3 font-black text-slate-700" onClick={() => setImageEditor(null)}>취소</button>
              <button
                type="button"
                className={`flex-1 rounded-xl ${theme.accentBg} py-3 font-black ${theme.actionText}`}
                onClick={() => {
                  updateProduct(imageEditor.productId, { imageUrl: imageEditor.value });
                  setImageEditor(null);
                }}
              >
                상품 이미지 적용
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {qrPrintStudents ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 print:hidden">
          <section role="dialog" aria-modal="true" aria-label="선택 학생 QR 발급" className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-surface)] p-4 text-[var(--theme-text)] shadow-2xl">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-xl font-black">선택 학생 QR 발급</h2>
                <p className="mt-1 text-sm font-bold text-[var(--theme-muted-text)]">선택한 학생 {qrPrintStudents.length}명의 QR만 출력합니다.</p>
              </div>
              <div className="flex gap-2">
                <button type="button" className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-black text-white" onClick={() => window.print()}>인쇄</button>
                <button type="button" className="rounded-xl bg-slate-200 px-4 py-2 text-sm font-black text-slate-700" onClick={() => setQrPrintStudents(null)}>닫기</button>
              </div>
            </div>
            <div className="mt-4 grid gap-4 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
              {qrPrintStudents.map((student) => <StudentQrCard key={student.studentId} student={student} />)}
            </div>
          </section>
        </div>
      ) : null}
      {qrPrintStudents ? (
        <section data-qr-print-document aria-label="선택 학생 QR 인쇄 영역">
          <div data-qr-print-grid className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3 print:gap-3">
            {qrPrintStudents.map((student) => <StudentQrCard key={`print-${student.studentId}`} student={student} />)}
          </div>
        </section>
      ) : null}

      {qrTaskPickerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-label="QR 과제 부여" className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-surface)] p-4 text-[var(--theme-text)] shadow-2xl">
            <h2 className="text-xl font-black">QR 과제 부여</h2>
            <p className="mt-1 text-sm font-bold text-[var(--theme-muted-text)]">QR로 부여할 과제를 선택해 주세요.</p>
            <div className="mt-4 max-h-80 space-y-2 overflow-y-auto">
              {tasks.map((task) => (
                <button key={task.taskId} type="button" aria-label={`${task.title} 과제 선택`} onClick={() => openQrTaskScan(task.taskId)} className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-left font-black text-slate-800 hover:bg-sky-50">
                  <span className="block text-base">{task.title}</span>
                  <span className="mt-1 block text-xs font-bold text-slate-500">부여 학생 {(task.allowedStudentIds ?? []).length}명 · 보상 {task.reward}{settings.currencyUnit ?? '원'}</span>
                </button>
              ))}
            </div>
            <button type="button" className="mt-4 w-full rounded-xl bg-slate-200 py-3 font-black text-slate-700" onClick={() => setQrTaskPickerOpen(false)}>닫기</button>
          </section>
        </div>
      ) : null}
      {qrTaskScan ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-label={`${tasks.find((task) => task.taskId === qrTaskScan.taskId)?.title ?? '과제'} QR 과제 부여`} className="w-full max-w-xl rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-surface)] p-4 text-[var(--theme-text)] shadow-2xl">
            <h2 className="text-xl font-black">학생 QR 인식</h2>
            <p className="mt-1 rounded-2xl bg-sky-50 p-3 text-sm font-bold text-sky-800"><strong>{tasks.find((task) => task.taskId === qrTaskScan.taskId)?.title ?? '선택한 과제'}</strong> 과제를 부여 중입니다.</p>
            <div className="mt-4 flex justify-center">
              <QrScanner onScan={assignTaskByQr} />
            </div>
            <label className="mt-4 block text-sm font-bold text-[var(--theme-muted-text)]">
              <span>학생 QR 직접 입력</span>
              <input aria-label="과제 부여 학생 QR 직접 입력" value={qrTaskScan.manualId} onChange={(event) => setQrTaskScan((current) => current ? { ...current, manualId: event.target.value } : current)} className="mt-2 w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] p-3 text-sm text-[var(--theme-text)] outline-none focus:ring-2 focus:ring-[var(--theme-focus-ring)]" placeholder="S001" />
            </label>
            <div className="mt-4 flex gap-2">
              <button type="button" className="flex-1 rounded-xl bg-slate-200 py-3 font-black text-slate-700" onClick={returnToQrTaskPicker}>취소</button>
              <button type="button" className={`flex-1 rounded-xl ${theme.accentBg} py-3 font-black ${theme.actionText}`} onClick={() => assignTaskByQr(qrTaskScan.manualId)}>직접 입력 적용</button>
            </div>
          </section>
        </div>
      ) : null}
      {qrTaskLoading ? <LoadingDialog title="QR 인식 중" message="QR을 인식했습니다. 과제를 부여하는 중입니다." /> : null}
      {qrTaskResult ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-label={`QR 과제 부여 ${qrTaskResult.status === 'success' ? '성공' : '실패'}`} className="w-full max-w-md rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-surface)] p-5 text-center text-[var(--theme-text)] shadow-2xl">
            <h2 className={`inline-block rounded-xl px-3 py-2 text-2xl font-black text-white ${qrTaskResult.status === 'success' ? 'bg-emerald-700' : 'bg-rose-700'}`}>QR 과제 부여 {qrTaskResult.status === 'success' ? '성공' : '실패'}</h2>
            <p className="mt-3 rounded-2xl bg-[var(--theme-surface-raised)] p-4 text-sm font-bold text-[var(--theme-text)]">{qrTaskResult.message}</p>
            <div className="mt-4 flex gap-2">
              <button type="button" className="flex-1 rounded-xl bg-slate-950 py-3 font-black text-white" onClick={() => openQrTaskScan(qrTaskResult.taskId)}>{qrTaskResult.status === 'success' ? '다시 찍기' : '다시 시도'}</button>
              <button type="button" className="flex-1 rounded-xl bg-slate-200 py-3 font-black text-slate-700" onClick={returnToQrTaskPicker}>{qrTaskResult.status === 'success' ? '닫기' : '취소'}</button>
            </div>
          </section>
        </div>
      ) : null}
      {taskScheduleEditor ? (
        <TaskDialogFrame title="과제 기한 설정" target={taskScheduleEditor.target} opener={taskScheduleEditor.opener} mutation={isSavingTaskSchedule} onClose={closeTaskScheduleEditor}>
            <h2 className="text-xl font-black">기한 설정</h2>
            <TaskTargetSummary target={taskScheduleEditor.target} />
            <div className="mt-3 grid min-w-0 max-w-full gap-2 sm:grid-cols-2">
              <label className="block min-w-0 max-w-full text-sm font-bold">시작 시각<input aria-label="시작 시각" type="datetime-local" value={taskScheduleEditor.availableFrom} onChange={(event) => setTaskScheduleEditor((current) => current ? { ...current, availableFrom: event.target.value, availabilityExplicit: true } : current)} className="mt-1 min-w-0 w-full max-w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] p-3 text-base" /></label>
              <label className="block min-w-0 max-w-full text-sm font-bold">기한<input aria-label="기한" type="datetime-local" value={taskScheduleEditor.dueAt} onChange={(event) => setTaskScheduleEditor((current) => current ? { ...current, dueAt: event.target.value, availabilityExplicit: true } : current)} className="mt-1 min-w-0 w-full max-w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] p-3 text-base" /></label>
            </div>
            {taskScheduleEditor.target.kind === 'bulk' ? <p className="mt-2 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-900">선행 과제는 개별 과제 기한 설정에서만 변경할 수 있습니다.</p> : <label className="mt-3 block text-sm font-bold">선행 과제<select aria-label="선행 과제" value={taskScheduleEditor.prerequisiteTaskId} onChange={(event) => setTaskScheduleEditor((current) => current ? { ...current, prerequisiteTaskId: event.target.value } : current)} className="mt-1 w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] p-3"><option value="">없음</option>{tasks.filter((task) => task.isActive && task.taskId !== taskScheduleEditor.taskId).map((task) => <option key={task.taskId} value={task.taskId}>{task.title}</option>)}</select></label>}
            {taskScheduleEditor.target.kind === 'bulk' ? (
              <p className="mt-1 rounded-xl bg-sky-50 p-3 text-xs font-bold text-sky-900">선택한 모든 과제에 같은 반복 설정이 일괄 적용됩니다. 기존 반복 설정은 불러오지 않습니다.</p>
            ) : null}
            <p className="mt-1 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-900">반복 규칙 변경은 즉시 적용됩니다. 직전 완료 상태는 보상 없이 새 회차에 승계되고 자연 초기화는 다음 경계부터 시작됩니다.</p>
            {taskScheduleEditor.taskId ? (
              <TaskScheduleProjection
                task={tasks.find((task) => task.taskId === taskScheduleEditor.taskId) ?? {}}
                className={`${theme.softBg} ${theme.softText}`}
              />
            ) : null}
            <div data-testid="task-recurrence-mobile-fields" className="min-w-0 max-w-full [&_input]:min-w-0 [&_input]:max-w-full [&_input]:text-base">
              {taskScheduleEditor.target.kind === 'bulk' ? (
                <BulkTaskRecurrenceFields
                  form={taskScheduleEditor.form}
                  onChange={(form) => setTaskScheduleEditor((current) => current ? { ...current, form, explicit: Boolean(form.type) } : current)}
                />
              ) : (
                <TaskRecurrenceFields
                  form={taskScheduleEditor.form}
                  onChange={(form) => setTaskScheduleEditor((current) => current ? { ...current, form, explicit: true } : current)}
                  styles={{ detail: theme.softText, preview: theme.accentText }}
                />
              )}
            </div>
            <div className="mt-4 flex gap-2">
              <button type="button" disabled={isSavingTaskSchedule} className="flex-1 rounded-xl bg-slate-200 py-3 font-black text-slate-700 disabled:opacity-50" onClick={closeTaskScheduleEditor}>취소</button>
              <button type="button" aria-label={taskScheduleEditor.target.kind === 'new' ? '기한 설정 적용' : '기한 설정 저장'} disabled={isSavingTaskSchedule || !taskScheduleEditor.explicit || !scheduleFormToPayload(taskScheduleEditor.form).ok} className={`flex-1 rounded-xl ${theme.accentBg} py-3 font-black ${theme.actionText} disabled:opacity-60`} onClick={() => void applyTaskScheduleEditor()}>{isSavingTaskSchedule ? '기한 설정 저장 중...' : taskScheduleEditor.target.kind === 'new' ? '기한 설정 적용' : '기한 설정 저장'}</button>
            </div>
        </TaskDialogFrame>
      ) : null}
      {taskHistory ? <TaskHistoryDialog history={taskHistory} onClose={closeTaskHistory} opener={historyOpenerRef.current} themeColor={themeColor} /> : null}
      {taskDeleteConfirmation ? (
        <TaskDeleteConfirmDialog
          confirmation={taskDeleteConfirmation}
          onCancel={cancelTaskDelete}
          onConfirm={() => void confirmTaskDelete()}
        />
      ) : null}
      {taskAssignmentEditor ? (
        <TaskDialogFrame title="과제 부여" target={taskAssignmentEditor.target} opener={taskAssignmentEditor.opener} mutation={isSavingChanges} obscured={Boolean(taskResetConfirmation)} onClose={closeTaskAssignmentEditor} maxWidth="max-w-xl">
            <h2 className="text-xl font-black">과제 부여</h2>
            <TaskTargetSummary target={taskAssignmentEditor.target} />
            {taskAssignmentEditor.target.kind === 'bulk' ? (
              <p className="mt-1 rounded-xl bg-sky-50 p-3 text-xs font-bold text-sky-900">선택한 모든 과제에 같은 과제 부여 변경이 일괄 적용됩니다. 기존 설정은 불러오지 않으며, 명시한 항목만 변경됩니다.</p>
            ) : null}
            {taskAssignmentEditor.taskId ? <p className="mt-1 text-xs font-black text-[var(--theme-accent-text)]">현재 회차 부여·완료 상태 {tasks.find((task) => task.taskId === taskAssignmentEditor.taskId)?.currentCycle?.transition === 'PERMANENT' ? '(상시 과제)' : ''}</p> : null}
            <p className="mt-1 rounded-2xl bg-sky-50 p-3 text-sm font-bold text-sky-800">선택된 학생만 이 과제를 완료할 수 있습니다. 아무 학생도 선택하지 않으면 아무도 완료할 수 없습니다.</p>
            <p className="mt-1 rounded-xl bg-amber-50 p-2 text-xs font-bold text-amber-900">관리자 완료는 보상 없이 표시됩니다.</p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-100 px-3 py-2 text-sm font-black">
              <label className="flex items-center gap-2">
                <input aria-label="전체 학생 행 선택" checked={students.length > 0 && taskAssignmentEditor.selectedIds.length === students.length} onChange={(event) => setTaskAssignmentEditor((current) => current ? { ...current, selectedIds: event.target.checked ? students.map((student) => student.studentId) : [] } : current)} type="checkbox" />
                행 선택 ({taskAssignmentEditor.selectedIds.length}/{students.length})
              </label>
              <div className="flex flex-wrap gap-2">
                <select
                  aria-label="선택 학생 부여 상태 일괄 변경"
                  className={`h-9 rounded-full border ${semantic.border} ${semantic.input} px-3 text-xs font-black ${semantic.text} shadow-sm outline-none disabled:cursor-not-allowed disabled:opacity-50`}
                  disabled={taskAssignmentEditor.selectedIds.length === 0}
                  onChange={(event) => {
                    if (event.target.value === 'assigned' || event.target.value === 'unassigned') setSelectedTaskAssignmentAssigned(event.target.value);
                  }}
                  value=""
                >
                  <option value="">부여 상태 변경</option>
                  <option value="assigned">선택 학생 부여</option>
                  <option value="unassigned">선택 학생 미부여</option>
                </select>
                <select
                  aria-label="선택 학생 완료 여부 일괄 변경"
                  className={`h-9 rounded-full border ${semantic.border} ${semantic.input} px-3 text-xs font-black ${semantic.text} shadow-sm outline-none disabled:cursor-not-allowed disabled:opacity-50`}
                  disabled={taskAssignmentEditor.selectedIds.length === 0}
                  onChange={(event) => {
                    if (event.target.value === 'completed' || event.target.value === 'incomplete') setSelectedTaskAssignmentCompletion(event.target.value);
                  }}
                  value=""
                >
                  <option value="">완료 상태 변경</option>
                  <option value="completed">선택 학생 완료</option>
                  <option value="incomplete">선택 학생 미완료</option>
                </select>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-[auto_1fr_auto_auto] gap-3 px-3 text-xs font-black text-[var(--theme-muted-text)]">
              <span>선택</span>
              <span>학생</span>
              <span>부여 여부</span>
              <span>완료 여부</span>
            </div>
            <div className="relative mt-2 max-h-72 space-y-1 overflow-y-auto rounded-2xl border border-slate-200 p-2">
              {taskAssignmentEditor.isLoading ? (
                <div role="status" aria-label="과제 부여 상태 불러오는 중" className="absolute inset-2 z-10 flex items-center justify-center rounded-2xl bg-[var(--theme-surface-raised)] p-4 text-center text-sm font-black text-[var(--theme-muted-text)] shadow-sm">
                  부여·완료 정보를 불러오는 중입니다.
                </div>
              ) : null}
              {sortStudentsById(students).map((student) => {
                const selected = taskAssignmentEditor.selectedIds.includes(student.studentId);
                const assigned = taskAssignmentEditor.assignedIds.includes(student.studentId);
                const completed = taskAssignmentEditor.completedIds.includes(student.studentId);
                const assignmentClass = assigned
                  ? 'border-green-600 bg-green-600 text-white'
                  : 'border-slate-200 bg-slate-200 text-slate-700';
                const completionClass = completed
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-slate-200 bg-slate-200 text-slate-700';
                return (
                  <div key={student.studentId} data-testid={`task-assignment-row-${student.studentId}`} className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 rounded-xl px-3 py-2 text-sm font-bold hover:bg-[var(--theme-hover)] hover:text-[var(--theme-hover-text)]">
                    <input aria-label={`${student.studentId} ${student.name} 행 선택`} checked={selected} onChange={() => toggleTaskAssignmentStudent(student.studentId)} type="checkbox" />
                    <span className="min-w-0"><span className="font-black">{student.studentId}</span> <span>{student.name}</span>{(() => { const state = taskAssignmentEditor.statusRows.find((row) => row.studentId === student.studentId); return state ? <span className="block text-[10px] text-[var(--theme-muted-text)]">부여 {assignmentSourceLabel(state.assignmentOrigin ?? 'DEFAULT', state.assignmentSource)} · 완료 {originLabel(state.completionOrigin ?? 'DEFAULT')}</span> : null; })()}</span>
                    {taskAssignmentEditor.target.kind === 'bulk' ? (
                      <>
                        <select aria-label={`${student.studentId} ${student.name} 부여 작업`} value={typeof taskAssignmentEditor.operations[student.studentId]?.assigned === 'boolean' ? (taskAssignmentEditor.operations[student.studentId].assigned ? 'assigned' : 'unassigned') : ''} onChange={(event) => setBulkAssignmentOperation(student.studentId, 'assigned', event.target.value)} className={`h-9 rounded-full border ${semantic.border} ${semantic.input} px-2 text-xs font-black ${semantic.text}`}>
                          <option value="">변경 안 함</option><option value="assigned">부여</option><option value="unassigned">미부여</option>
                        </select>
                        <select aria-label={`${student.studentId} ${student.name} 완료 작업`} value={typeof taskAssignmentEditor.operations[student.studentId]?.completed === 'boolean' ? (taskAssignmentEditor.operations[student.studentId].completed ? 'completed' : 'incomplete') : ''} onChange={(event) => setBulkAssignmentOperation(student.studentId, 'completed', event.target.value)} className={`h-9 rounded-full border ${semantic.border} ${semantic.input} px-2 text-xs font-black ${semantic.text}`}>
                          <option value="">변경 안 함</option><option value="completed">완료</option><option value="incomplete">미완료</option>
                        </select>
                      </>
                    ) : (
                      <>
                        <button type="button" aria-label={`${student.studentId} ${student.name} 부여 상태`} className={`h-9 min-w-16 rounded-full border px-3 text-xs font-black shadow-sm transition ${assignmentClass}`} onClick={() => toggleTaskAssignmentAssigned(student.studentId)}>{assigned ? '부여' : '미부여'}</button>
                        <button type="button" aria-label={`${student.studentId} ${student.name} 완료 상태`} className={`h-9 min-w-16 rounded-full border px-3 text-xs font-black shadow-sm transition ${completionClass}`} onClick={() => toggleTaskAssignmentCompleted(student.studentId)}>{completed ? '완료' : '미완료'}</button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {taskAssignmentEditor.target.kind !== 'new' ? <button type="button" disabled={isSavingChanges} className="flex-1 rounded-xl bg-amber-100 py-3 font-black text-amber-900 disabled:opacity-50" onClick={(event) => requestTaskCompletionReset(taskAssignmentEditor.target, event.currentTarget)}>완료 기록 초기화</button> : null}
              <button type="button" disabled={isSavingChanges} className="flex-1 rounded-xl bg-slate-200 py-3 font-black text-slate-700 disabled:opacity-50" onClick={closeTaskAssignmentEditor}>취소</button>
              <button type="button" disabled={Boolean(taskAssignmentEditor.isLoading) || isSavingChanges || (taskAssignmentEditor.target.kind === 'bulk' && Object.keys(taskAssignmentEditor.operations).length === 0)} className={`flex-1 rounded-xl ${theme.accentBg} py-3 font-black ${theme.actionText} disabled:cursor-not-allowed disabled:opacity-50`} onClick={saveTaskAssignment}>과제 부여 저장</button>
            </div>
        </TaskDialogFrame>
      ) : null}
      {taskResetConfirmation ? (
        <TaskResetConfirmDialog
          confirmation={taskResetConfirmation}
          onCancel={() => { if (!taskResetConfirmation.resetting) setTaskResetConfirmation(null); }}
          onConfirm={() => void confirmTaskCompletionReset()}
        />
      ) : null}
      {taskDescriptionEditor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-label="과제 상세 설정 편집" className="w-full max-w-xl rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-surface)] p-4 text-[var(--theme-text)] shadow-2xl">
            <h2 className="text-xl font-black">과제 상세 설정 편집</h2>
            <p className="mt-1 text-sm font-bold text-[var(--theme-muted-text)]">긴 설명은 여기에서 편하게 입력하고 수정합니다.</p>
            <label className="mt-4 block text-sm font-bold text-[var(--theme-muted-text)]">
              <span>과제 상세 설정 전체 입력</span>
              <textarea
                aria-label="과제 상세 설정 전체 입력"
                className="mt-2 min-h-40 w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] p-3 text-sm text-[var(--theme-text)] outline-none focus:ring-2 focus:ring-[var(--theme-focus-ring)]"
                value={taskDescriptionEditor.value}
                onChange={(event) => setTaskDescriptionEditor((current) => current ? { ...current, value: event.target.value } : current)}
              />
            </label>
            <div className="mt-4 flex gap-2">
              <button type="button" className="flex-1 rounded-xl bg-slate-200 py-3 font-black text-slate-700" onClick={() => setTaskDescriptionEditor(null)}>취소</button>
              <button
                type="button"
                className={`flex-1 rounded-xl ${theme.accentBg} py-3 font-black ${theme.actionText}`}
                onClick={() => {
                  updateTask(taskDescriptionEditor.taskId, { description: taskDescriptionEditor.value });
                  setTaskDescriptionEditor(null);
                }}
              >
                상세 설정 적용
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {currencyLoading ? (
        <LoadingDialog title={`화폐 ${currencyActionLabel} 처리 중`} message={`QR을 인식했습니다. 화폐를 ${currencyActionLabel}하는 중입니다.`} />
      ) : null}
      {currencyScannerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-label="학생 QR 인식" className="w-full max-w-xl rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-surface)] p-4 text-[var(--theme-text)] shadow-2xl">
            <h2 className="text-xl font-black">학생 QR 인식</h2>
            <p className="mt-1 text-sm font-bold text-[var(--theme-muted-text)]">{currencyAmount} {currencyActionLabel}할 학생 QR을 인식합니다.</p>
            <div className="mt-4 flex justify-center">
              <QrScanner onScan={applyCurrencyToStudent} />
            </div>
            <label className="mt-4 block text-sm font-bold text-[var(--theme-muted-text)]">
              <span>학생 QR 직접 입력</span>
              <input aria-label="학생 QR 직접 입력" value={currencyManualId} onChange={(event) => setCurrencyManualId(event.target.value)} className="mt-2 w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] p-3 text-sm text-[var(--theme-text)] outline-none focus:ring-2 focus:ring-[var(--theme-focus-ring)]" placeholder="S001" />
            </label>
            <div className="mt-4 flex gap-2">
              <button type="button" className="flex-1 rounded-xl bg-slate-200 py-3 font-black text-slate-700" onClick={() => setCurrencyScannerOpen(false)}>취소</button>
              <button type="button" className={`flex-1 rounded-xl ${theme.accentBg} py-3 font-black ${theme.actionText}`} onClick={() => applyCurrencyToStudent(currencyManualId)}>직접 입력 적용</button>
            </div>
          </section>
        </div>
      ) : null}
      {currencyResult ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-label={`화폐 ${currencyResult.mode === 'add' ? '지급' : '회수'} ${currencyResult.status === 'success' ? '성공' : '실패'}`} className="w-full max-w-md rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-surface)] p-5 text-center text-[var(--theme-text)] shadow-2xl">
            <h2 className={`inline-block rounded-xl px-3 py-2 text-2xl font-black text-white ${currencyResult.status === 'success' ? 'bg-emerald-700' : 'bg-rose-700'}`}>화폐 {currencyResult.mode === 'add' ? '지급' : '회수'} {currencyResult.status === 'success' ? '성공' : '실패'}</h2>
            <p className="mt-3 rounded-2xl bg-[var(--theme-surface-raised)] p-4 text-sm font-bold text-[var(--theme-text)]">{currencyResult.message}</p>
            <div className="mt-4 flex gap-2">
              <button type="button" className="flex-1 rounded-xl bg-slate-950 py-3 font-black text-white" onClick={retryCurrencyScan}>다시 시도</button>
              <button type="button" className="flex-1 rounded-xl bg-slate-200 py-3 font-black text-slate-700" onClick={() => setCurrencyResult(null)}>{currencyResult.status === 'success' ? '닫기' : '취소'}</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function BulkTaskRecurrenceFields({ form, onChange }: { form: TaskRecurrenceForm; onChange: (form: TaskRecurrenceForm) => void }) {
  return (
    <div className="mt-4 space-y-3">
      <label className="block text-sm font-bold"><span>반복 주기</span><select aria-label="반복 주기" value={form.type} onChange={(event) => onChange({ ...form, type: event.target.value as TaskRecurrenceForm['type'], weekdays: event.target.value === 'WEEKLY' ? ['1'] : [], dayOfMonth: '' })} className="mt-1 w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] p-3">
        <option value="">선택해 주세요</option><option value="NONE">반복 없음</option><option value="DAILY">매일</option><option value="WEEKLY">매주</option><option value="MONTHLY">매월</option>
      </select></label>
      {form.type && form.type !== 'NONE' ? <label className="block text-sm font-bold"><span>실행 시간</span><input aria-label="반복 시간" type="time" value={form.time} onChange={(event) => onChange({ ...form, time: event.target.value })} className="mt-1 w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] p-3" /></label> : null}
      {form.type === 'WEEKLY' ? <fieldset aria-label="반복 요일"><legend className="text-sm font-bold">요일</legend><div className="mt-1 flex flex-wrap gap-2">{[{ label: '일', iso: 7 }, { label: '월', iso: 1 }, { label: '화', iso: 2 }, { label: '수', iso: 3 }, { label: '목', iso: 4 }, { label: '금', iso: 5 }, { label: '토', iso: 6 }].map(({ label, iso }) => { const selected = form.weekdays.includes(String(iso)); return <button key={iso} type="button" aria-label={`${label}요일`} aria-pressed={selected} onClick={() => { if (selected && form.weekdays.length === 1) return; const weekdays = (selected ? form.weekdays.filter((day) => day !== String(iso)) : [...form.weekdays, String(iso)]).sort((a, b) => Number(a) - Number(b)); onChange({ ...form, weekdays }); }} className={`h-11 w-11 rounded-full border font-black ${selected ? 'border-[var(--theme-accent-text)] bg-[var(--theme-accent-solid)]' : 'border-[var(--theme-border)] bg-[var(--theme-input)]'}`}>{label}</button>; })}</div></fieldset> : null}
      {form.type === 'MONTHLY' ? <label className="block text-sm font-bold"><span>날짜</span><input aria-label="반복 날짜" type="number" min="1" max="31" value={form.dayOfMonth} onChange={(event) => onChange({ ...form, dayOfMonth: event.target.value })} className="mt-1 w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] p-3" /></label> : null}
      <div className="grid gap-2 sm:grid-cols-2"><label className="flex gap-2 rounded-xl bg-[var(--theme-surface-raised)] p-3 text-sm font-bold"><input aria-label="회차마다 완료 초기화" type="checkbox" checked={form.resetCompletionOnCycle} onChange={(event) => onChange({ ...form, resetCompletionOnCycle: event.target.checked })} />완료 초기화</label><label className="flex gap-2 rounded-xl bg-[var(--theme-surface-raised)] p-3 text-sm font-bold"><input aria-label="회차마다 부여 초기화" type="checkbox" checked={form.resetAssignmentOnCycle} onChange={(event) => onChange({ ...form, resetAssignmentOnCycle: event.target.checked })} />부여 초기화</label></div>
    </div>
  );
}

function TaskTargetSummary({ target }: { target: TaskDialogTarget }) {
  const summary = taskTargetSummary(target);
  return <p title={summary.full} className="mt-1 truncate text-sm font-black text-[var(--theme-accent-text)]">대상: {summary.short}</p>;
}

function TaskDialogFrame({ title, target, opener, mutation, obscured = false, onClose, maxWidth = 'max-w-lg', children }: {
  title: string;
  target: TaskDialogTarget;
  opener: HTMLElement | null;
  mutation: boolean;
  obscured?: boolean;
  onClose: () => void;
  maxWidth?: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const descriptionId = useId();
  const summary = taskTargetSummary(target);
  useEffect(() => {
    const first = dialogRef.current?.querySelector<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled])');
    first?.focus();
    return () => opener?.focus();
  }, [opener]);
  function onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && !mutation) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled])') ?? []);
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} aria-describedby={descriptionId} aria-hidden={obscured || mutation ? true : undefined} inert={obscured || mutation} onKeyDown={onKeyDown} className={`max-h-[calc(100dvh-2rem)] min-w-0 w-full max-w-full ${maxWidth} overflow-x-hidden overflow-y-auto overscroll-contain rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-surface)] p-4 text-[var(--theme-text)] shadow-2xl`}>
        <span id={descriptionId} className="sr-only">대상 과제: {summary.full}</span>
        {children}
      </section>
    </div>
  );
}

function TaskResetConfirmDialog({ confirmation, onCancel, onConfirm }: {
  confirmation: { target: TaskDialogTarget; opener: HTMLElement; resetting: boolean; error: string };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    return () => {
      window.queueMicrotask(() => {
        if (confirmation.opener.isConnected) confirmation.opener.focus();
      });
    };
  }, [confirmation.opener]);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
      <section role="dialog" aria-modal="true" aria-label="완료 기록 초기화 확인" aria-hidden={confirmation.resetting ? true : undefined} inert={confirmation.resetting} onKeyDown={(event) => {
        if (event.key === 'Escape' && !confirmation.resetting) { event.preventDefault(); onCancel(); }
        if (event.key === 'Tab') {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
          if (buttons.length && ((!event.shiftKey && document.activeElement === buttons.at(-1)) || (event.shiftKey && document.activeElement === buttons[0]))) {
            event.preventDefault();
            (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus();
          }
        }
      }} className="w-full max-w-md rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-surface)] p-5 text-[var(--theme-text)] shadow-2xl">
        <h2 className="text-xl font-black">완료 기록을 초기화할까요?</h2>
        <TaskTargetSummary target={confirmation.target} />
        <p className="mt-3 rounded-xl bg-amber-100 p-3 text-sm font-bold text-amber-950">과거 지급 보상은 회수되지 않습니다. 같은 회차에서 은행으로 다시 완료하면 재보상될 수 있습니다.</p>
        {confirmation.error ? <p role="alert" className="mt-3 rounded-xl bg-rose-100 p-3 text-sm font-bold text-rose-800">{confirmation.error}</p> : null}
        <div className="mt-4 flex gap-2">
          <button ref={confirmRef} type="button" aria-label="완료 기록 초기화 확인" disabled={confirmation.resetting} onClick={onConfirm} className="flex-1 rounded-xl bg-amber-500 py-3 font-black text-amber-950 disabled:opacity-50">{confirmation.resetting ? '초기화 중...' : '초기화'}</button>
          <button type="button" disabled={confirmation.resetting} onClick={onCancel} className="flex-1 rounded-xl bg-[var(--theme-surface-raised)] py-3 font-black disabled:opacity-50">취소</button>
        </div>
      </section>
    </div>
  );
}

function TaskDeleteConfirmDialog({
  confirmation,
  onCancel,
  onConfirm,
}: {
  confirmation: { taskId: string; title: string; opener: HTMLElement; deleting: boolean; error: string };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    return () => confirmation.opener.focus();
  }, [confirmation.opener]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && !confirmation.deleting) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-label={`${confirmation.title} 과제 삭제 확인`} onKeyDown={handleKeyDown} className="w-full max-w-md rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-surface)] p-5 text-[var(--theme-text)] shadow-2xl">
        <h2 className="text-xl font-black">과제를 삭제할까요?</h2>
        <p className="mt-3 rounded-xl bg-[var(--theme-surface-raised)] p-4 font-bold"><strong>{confirmation.title}</strong> ({confirmation.taskId}) 과제를 삭제합니다.</p>
        {confirmation.error ? <p role="alert" className="mt-3 rounded-xl border border-rose-500 bg-rose-100 p-3 text-sm font-bold text-rose-800">{confirmation.error}</p> : null}
        <div className="mt-4 flex gap-2">
          <button ref={confirmRef} type="button" aria-label="과제 삭제 확인" disabled={confirmation.deleting} onClick={onConfirm} className="flex-1 rounded-xl bg-rose-600 py-3 font-black text-white disabled:cursor-not-allowed disabled:opacity-60">{confirmation.deleting ? '삭제 중...' : '삭제'}</button>
          <button type="button" aria-label="과제 삭제 취소" disabled={confirmation.deleting} onClick={onCancel} className="flex-1 rounded-xl bg-[var(--theme-surface-raised)] py-3 font-black text-[var(--theme-text)] disabled:cursor-not-allowed disabled:opacity-60">취소</button>
        </div>
      </section>
    </div>
  );
}

function formatAssignmentFailures(
  failures: Array<{ taskId?: string; studentId?: string; code?: string }>,
  tasks: TaskDraft[],
  students: StudentDraft[],
) {
  return failures.map((failure) => {
    const task = tasks.find((candidate) => candidate.taskId === failure.taskId);
    const student = students.find((candidate) => candidate.studentId === failure.studentId);
    const taskLabel = task ? `${task.title} (${task.taskId})` : failure.taskId ?? '알 수 없는 과제';
    const studentLabel = student ? `${student.name} (${student.studentId})` : failure.studentId ?? '알 수 없는 학생';
    const reason = failure.code === 'OPERATION_FAILED'
      ? '작업 실패'
      : failure.code === 'NOT_ATTEMPTED' ? '미처리' : `작업 실패 (${failure.code ?? 'UNKNOWN'})`;
    return `${taskLabel} · ${studentLabel}: ${reason}`;
  }).join(', ');
}

function formatTaskWarnings(warnings: Array<{ taskId?: string; code?: string }>, tasks: TaskDraft[]) {
  return warnings.map((warning) => {
    const task = tasks.find((candidate) => candidate.taskId === warning.taskId);
    const label = task ? `${task.title} (${task.taskId})` : warning.taskId ?? '알 수 없는 과제';
    return warning.code === 'LEGACY_MIRROR_UPDATE_FAILED' ? label : `${label}: ${warning.code ?? 'UNKNOWN'}`;
  }).join(', ');
}

function originLabel(origin: string) {
  return ({ EVENT: '현재 기록', CARRY: '이월', LEGACY: '기존 설정', DEFAULT: '기본값' } as Record<string, string>)[origin] ?? origin;
}

function assignmentSourceLabel(origin: string, source?: TaskAssignmentStudentStatus['assignmentSource']) {
  const sourceLabel = source ? ({ ADMIN: '관리자', QR: 'QR', LEGACY_SEED: '기존 설정', CARRY_FORWARD: '이월' } as const)[source] : undefined;
  if (!sourceLabel) return originLabel(origin);
  return origin === 'CARRY' ? `${originLabel(origin)} · ${sourceLabel}` : sourceLabel;
}

function LoadingScreen({ title, message }: { title: string; message: string }) {
  const loadingTheme = themeStyles('white');
  return (
    <main style={loadingTheme.variables} className="flex min-h-screen items-center justify-center bg-[var(--theme-shell)] p-4 text-[var(--theme-text)]">
      <section role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-surface)] p-6 text-center text-[var(--theme-text)] shadow-2xl">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-[var(--theme-border)] border-t-[var(--theme-focus-ring)]" aria-hidden="true" />
        <h1 className="mt-4 text-2xl font-black">{title}</h1>
        <p className="mt-2 rounded-2xl bg-[var(--theme-surface-raised)] p-4 text-sm font-bold text-[var(--theme-muted-text)]">{message}</p>
      </section>
    </main>
  );
}

function LoadingDialog({ title, message, restoreFocus = true }: { title: string; message: string; restoreFocus?: boolean }) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      if (!restoreFocus) return;
      window.queueMicrotask(() => {
        if (previous?.isConnected) previous.focus();
      });
    };
  }, [restoreFocus]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={(event) => {
        if (event.key === 'Tab') event.preventDefault();
      }} className="w-full max-w-md rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-surface)] p-6 text-center text-[var(--theme-text)] shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-[var(--theme-border)] border-t-[var(--theme-focus-ring)]" aria-hidden="true" />
        <h2 className="mt-4 text-2xl font-black">{title}</h2>
        <p className="mt-2 rounded-2xl bg-[var(--theme-surface-raised)] p-4 text-sm font-bold text-[var(--theme-muted-text)]">{message}</p>
      </section>
    </div>
  );
}

function AdminNavLink({ href, title, className }: { href: string; title: string; className: string }) {
  return (
    <Link aria-label={`${title} 새 탭 열림`} target="_blank" rel="noopener noreferrer" className={`rounded-[1rem] px-2 py-3 text-left transition ${className}`} href={href}>
      <span className="flex items-center gap-1 text-sm font-black sm:text-base">{title}<span aria-hidden="true">↗</span></span>
    </Link>
  );
}

function StudentQrCard({ student }: { student: Student }) {
  return (
    <article className="break-inside-avoid rounded-3xl border-2 border-slate-200 bg-white p-5 text-center text-slate-950 shadow-sm print:rounded-2xl print:border print:p-4 print:shadow-none">
      <div className="mx-auto mb-4 flex h-48 w-48 items-center justify-center rounded-3xl border border-slate-100 bg-white p-3 print:h-40 print:w-40">
        <img alt={`${student.name} QR 코드`} className="h-full w-full" src={`/api/qrcode?value=${encodeURIComponent(student.studentId)}`} />
      </div>
      <h3 className="text-2xl font-black">{student.name}</h3>
      <p className="mt-1 text-lg font-bold text-slate-600">{student.studentId}</p>
      <p className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900 print:bg-white print:p-0 print:text-slate-700">
        학급 은행 및 매점에서<br />
        이 QR을 스캔해 주세요.
      </p>
    </article>
  );
}

function SummaryCard({ label, value, toneClass, accentClass }: { label: string; value: string; toneClass: string; accentClass: string }) {
  return (
    <div className={`rounded-2xl ${toneClass} px-3 py-2 text-left sm:px-4 sm:py-3`}>
      <p className="text-[11px] font-black text-[var(--theme-muted-text)] sm:text-xs">{label}</p>
      <p className={`mt-1 text-xl font-black ${accentClass} sm:text-2xl`}>{value}</p>
    </div>
  );
}

function SectionCard({ title, description, action, children, compact = false }: { title: string; description?: string; action?: ReactNode; children: ReactNode; compact?: boolean }) {
  return (
    <section className={`min-w-0 overflow-hidden rounded-[1.25rem] border border-[var(--theme-border)] bg-[var(--theme-surface)] text-[var(--theme-text)] shadow-sm sm:rounded-[1.75rem] ${compact ? 'p-3 md:p-4' : 'p-4 md:p-5'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-black text-[var(--theme-text)] sm:text-2xl">{title}</h2>
        {action}
      </div>
      {description ? <p className="mt-1 text-xs font-bold text-[var(--theme-muted-text)] sm:text-sm">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function TextInput({ label, value, onChange, compact = false, dense = false, dataTestId }: { label: string; value?: string; onChange: (value: string) => void; compact?: boolean; dense?: boolean; dataTestId?: string }) {
  const visibleLabel = label.replace(/^새 |^[SP]\d+ /, '');
  const inputClass = dense
    ? 'h-8 w-full rounded-lg border border-[var(--theme-border)] bg-[var(--theme-input)] px-1 text-[11px] text-[var(--theme-text)] outline-none transition focus:ring-2 focus:ring-[var(--theme-focus-ring)]'
    : `mt-1 w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] px-2 text-[var(--theme-text)] outline-none transition focus:ring-2 focus:ring-[var(--theme-focus-ring)] ${compact ? 'py-2 text-sm' : 'py-3'}`;

  return (
    <label className="block min-w-0 text-xs font-bold text-[var(--theme-muted-text)]">
      <span data-testid={dataTestId} className={dense ? 'sr-only' : undefined}>{visibleLabel}</span>
      <input aria-label={label} className={inputClass} onChange={(event) => onChange(event.target.value)} value={value ?? ''} />
    </label>
  );
}

function NumberInput({ label, value, onChange, compact = false, dense = false }: { label: string; value?: number; onChange: (value: number) => void; compact?: boolean; dense?: boolean }) {
  const visibleLabel = label.replace(/^새 |^[SP]\d+ /, '');
  const inputClass = dense
    ? 'h-8 w-full rounded-lg border border-[var(--theme-border)] bg-[var(--theme-input)] px-1 text-[11px] text-[var(--theme-text)] outline-none transition focus:ring-2 focus:ring-[var(--theme-focus-ring)]'
    : `mt-1 w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] px-2 text-[var(--theme-text)] outline-none transition focus:ring-2 focus:ring-[var(--theme-focus-ring)] ${compact ? 'py-2 text-sm' : 'py-3'}`;
  const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : 0;

  return (
    <label className="block min-w-0 text-xs font-bold text-[var(--theme-muted-text)]">
      <span className={dense ? 'sr-only' : undefined}>{visibleLabel}</span>
      <input aria-label={label} className={inputClass} onChange={(event) => onChange(Number(event.target.value))} type="number" value={safeValue} />
    </label>
  );
}
