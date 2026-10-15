'use client';

import { StudentBulkImport } from './bulkImport/StudentBulkImport';
import { ProductBulkImport } from './bulkImport/ProductBulkImport';
import styles from './classroom.module.css';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Product, TaskAssignmentStatus } from '@/domain/types';
import { SettingsForm } from './SettingsForm';
import { QrScanner } from './QrScanner';
import dynamic from 'next/dynamic';
import { getFontFamilyCss } from '@/lib/fontSettings';
import { useQrObjectUrls } from '@/lib/qrCodeClient';
import { tenantApiPath, tenantFetch, tenantPagePath } from '@/lib/tenantApiPath';
import { formatRecurrenceSummary, normalizeAdminTask, resolveEffectiveAdminTaskSchedule, scheduleDtoToForm, scheduleFormToPayload, type TaskRecurrenceForm } from './taskRecurrenceEditor';
import { TaskRecurrenceFields, TaskScheduleProjection } from './tasks/TaskRecurrenceFields';
import { TaskHistoryDialog, type TaskHistoryDialogState } from './tasks/TaskHistoryDialog';
import { createTaskDialogTarget, taskTargetSummary, type TaskDialogTarget } from './tasks/taskTargetSummary';
import { normalizeTaskAssignmentStatus, reconcileTaskAssignmentProjection } from './taskAssignmentProjection';
import { normalizeThemeColor, themeStyles } from './uiTheme';
import {
  Badge, Button, Callout, Card, CardHeader, Checkbox, EmptyState, Field, Icon, IconButton, Input, LoadingOverlay, Modal,
  PageHeader, ProgressBar, SearchInput, SegmentedControl, SelectionBar, SelectionBarButton, Sheet, StatCard, Switch,
  Textarea, buttonClass, cx, type IconName,
} from './ui';
import { classifyTaskAvailability } from '@/domain/taskAvailability';
import { TaskLedgerHomeCard, TaskLedgerOverlays, TaskLedgerPanel, isTaskLedgerMode, ledgerTaskSummary, useTaskLedger } from './tasks/ledger';
import type {
  StudentDraft, ProductDraft, TaskDraft, TaskDeleteConfirmation, TaskAssignmentDraft,
  TaskSheetTab, TaskSheetState, EntitySheetState, ConfirmState, AssignmentFilter,
  BulkMode, CurrencyMode, Settings, CurrencyResult, QrTaskAssignmentResult,
  NewStudentDraft, NewProductDraft, ProductDeleteAttempt, ProductDeleteConfirmation
} from './admin/adminTypes';
import { tabs, storeTabs, useAdminNavigation } from './admin/useAdminNavigation';
import { isRecord } from './admin/adminResponse';
import { studentEditorPath, studentEditorSnapshot, isCreatedStudent } from './admin/studentAdminResponse';
import { parseProductAdminEnvelope, getProductExpectedVersion, isCanonicalOperationId, parseProductDeleteResult, isCreatedProduct, type ProductAdminState } from './admin/productAdminResponse';
import { parseAssignmentBatchResult, buildTaskCreationBody, canonicalTaskCreationBody, isCreatedTask, isCompleteTaskProjection, reconcileTaskProjections, formatAssignmentFailures, formatTaskWarnings } from './admin/taskAdminResponse';
import { formatShortDate, isoToSeoulLocal, seoulLocalToIso } from './admin/adminDates';
import { TaskBasicFields, NewTaskStudentPicker, TaskAssignmentBoard, BulkAssignmentBoard } from './admin/AdminTaskEditors';
import { ProductThumb, ProductFields } from './admin/AdminProductEditor';
import { fetchDigitalProducts, saveDigitalProduct } from './bag/bagClient';
import { DigitalProductFields, EMPTY_DIGITAL_DRAFT, digitalDraftOf, digitalSettingOf, sameDigitalDraft, type DigitalDraft } from './bag/DigitalProductFields';
import { DIGITAL_KIND_LABELS, type DigitalProductDto } from '@/lib/studentBagApi';
import { TaskResetConfirmDialog, TaskDeleteConfirmDialog, ProductDeleteConfirmDialog } from './admin/AdminConfirmDialogs';
import { SidebarLink, SidebarShortcut, SidebarButton, QuickAction, SheetLoading, LoadingScreen, StudentQrCard } from './admin/AdminPresentation';
import { StudentQrReissueNotice, useStudentQrReissue } from './admin/StudentQrReissue';
import { ShareLinkDialog, sharePaths, type ShareTarget } from './admin/ShareLinkDialog';
import { ParentConsentFormDialog } from './admin/ParentConsentFormDialog';
import { TutorialHomeCard, TutorialMenu } from './tutorial/TutorialMenu';
import { TutorialRunner } from './tutorial/TutorialRunner';
import { FIRST_TUTORIAL_ID, tutorialAfter, tutorialById, type Tutorial } from './tutorial/tutorials';
import type { AvatarConfig } from './profile/avatar';
import { GlobalHeader } from './brand/GlobalHeader';

// Retain the existing public parser exports for callers outside the page.
export { parseProductAdminEnvelope, getProductExpectedVersion, type ProductAdminState } from './admin/productAdminResponse';

// Keep the existing mount boundaries while deferring optional feature code until first use.
const TransactionsPanel = dynamic(() => import('./TransactionsPage').then((module) => module.TransactionsPanel), {
  loading: () => <SheetLoading label="거래 내역 불러오는 중" />,
});
const PromotionAdminPanel = dynamic(() => import('./promotions/PromotionAdminPanel').then((module) => module.PromotionAdminPanel), {
  loading: () => <SheetLoading label="프로모션 불러오는 중" />,
});
const BulkGiveDialog = dynamic(() => import('./bag/BulkGiveDialog').then((module) => module.BulkGiveDialog));
const StudentStorageSection = dynamic(() => import('./bag/StudentStorageSection').then((module) => module.StudentStorageSection), {
  loading: () => <SheetLoading label="보관함 여는 중" />,
});
const ClassTreePanel = dynamic(() => import('./classTree/ClassTreePanel').then((module) => module.ClassTreePanel), {
  loading: () => <SheetLoading label="나무 키우기 불러오는 중" />,
});
const PetPanel = dynamic(() => import('./pet/PetPanel').then((module) => module.PetPanel), {
  loading: () => <SheetLoading label="펫 키우기 불러오는 중" />,
});

const TASK_DEFINITION_FIELDS = ['title', 'description', 'reward', 'isActive', 'sortOrder', 'availableFrom', 'dueAt', 'prerequisiteTaskId'] as const;

const EMPTY_STUDENT: NewStudentDraft = { studentId: '', name: '', balance: 0, status: 'ACTIVE' };
const EMPTY_PRODUCT: NewProductDraft = { name: '', price: 0, stock: 0, isActive: true, imageUrl: '', category: '', sortOrder: 1 };
const EMPTY_TASK: Omit<TaskDraft, 'taskId'> = { title: '', description: '', reward: 0, isActive: true, sortOrder: 1, allowedStudentIds: [] };

export function AdminManagePage({ migrationsHref, account }: { migrationsHref?: string; account?: Readonly<{ nickname: string; avatar: AvatarConfig }> } = {}) {
  const { activeTab, storeTab, adminTabRefs, storeTabRefs, hasOpenedPromotions, hasOpenedTransactions, selectAdminTab, selectStoreTab, handleAdminTabKeyDown, handleStoreTabKeyDown } = useAdminNavigation();
  const [students, setStudents] = useState<StudentDraft[]>([]);
  const [productAdminState, setProductAdminState] = useState<ProductAdminState>({
    products: [],
    mutationPreconditions: new Map(),
  });
  const products = productAdminState.products;
  const [tasks, setTasks] = useState<TaskDraft[]>([]);
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [bulkMode, setBulkMode] = useState<BulkMode>('set');
  const [bulkAmount, setBulkAmount] = useState(0);
  const bulkBalanceAttempt = useRef<{ semanticKey: string; operationId: string } | null>(null);
  const bulkBalanceInFlight = useRef(false);
  const studentSaveAttempt = useRef<{ semanticKey: string; operationId: string } | null>(null);
  const studentSaveInFlight = useRef(false);
  const studentStorage = useRef<'sheets' | 'postgresql'>('sheets');
  const productSaveAttempt = useRef<{ semanticKey: string; operationId: string } | null>(null);
  const productBatchDeleteAttempt = useRef<{ semanticKey: string; operationId: string; body: string } | null>(null);
  const productBatchDeleteInFlight = useRef(false);
  const [productBatchDeleteNeedsRefresh, setProductBatchDeleteNeedsRefresh] = useState(false);
  const productSaveInFlight = useRef(false);
  const [message, setMessage] = useState('학생/상품 목록을 불러오는 중이에요.');
  const [newStudent, setNewStudent] = useState<NewStudentDraft>(EMPTY_STUDENT);
  const studentCreationAttempt = useRef<{ semanticKey: string; operationId: string } | null>(null);
  const studentCreationInFlight = useRef(false);
  const [newProduct, setNewProduct] = useState<NewProductDraft>(EMPTY_PRODUCT);
  const productCreationAttempt = useRef<{ semanticKey: string; operationId: string } | null>(null);
  const productCreationInFlight = useRef(false);
  const [productDeleteConfirmation, setProductDeleteConfirmation] = useState<ProductDeleteConfirmation | null>(null);
  const productDeleteAttempt = useRef<ProductDeleteAttempt | null>(null);
  const productDeleteInFlight = useRef(false);
  const productMutationEpoch = useRef(0);
  const [newTask, setNewTask] = useState<Omit<TaskDraft, 'taskId'>>(EMPTY_TASK);
  const taskCreationAttempt = useRef<{ semanticKey: string; operationId: string } | null>(null);
  const taskBatchDeleteInFlight = useRef(false);
  const taskSingleDeleteInFlight = useRef(false);
  const taskDraftsRef = useRef(tasks);
  taskDraftsRef.current = tasks;
  const taskCreationInFlight = useRef(false);
  const [taskDescriptionEditor, setTaskDescriptionEditor] = useState<{ taskId: string; value: string } | null>(null);
  const [taskScheduleEditor, setTaskScheduleEditor] = useState<{ taskId: string | null; target: TaskDialogTarget; form: TaskRecurrenceForm; explicit: boolean; opener: HTMLElement | null; availableFrom: string; dueAt: string; prerequisiteTaskId: string; availabilityExplicit: boolean } | null>(null);
  const [dirtyTaskScheduleIds, setDirtyTaskScheduleIds] = useState<string[]>([]);
  const [isSavingTaskSchedule, setIsSavingTaskSchedule] = useState(false);
  const taskScheduleSession = useRef<{ id: number; taskId: string | null }>({ id: 0, taskId: null });
  const [taskHistory, setTaskHistory] = useState<TaskHistoryDialogState | null>(null);
  const historyOpenerRef = useRef<HTMLElement | null>(null);
  const [taskDeleteConfirmation, setTaskDeleteConfirmation] = useState<TaskDeleteConfirmation | null>(null);
  const historyRequestId = useRef(0);
  const assignmentRequest = useRef<{ id: number; taskId: string | null }>({ id: 0, taskId: null });
  const [taskAssignmentEditor, setTaskAssignmentEditor] = useState<TaskAssignmentDraft | null>(null);
  const [taskResetConfirmation, setTaskResetConfirmation] = useState<{ target: TaskDialogTarget; opener: HTMLElement | null; operationId: string; resetting: boolean; error: string } | null>(null);
  const [qrPrintStudents, setQrPrintStudents] = useState<StudentDraft[] | null>(null);
  const [qrPrintIssue, setQrPrintIssue] = useState(0);
  const qrReissue = useStudentQrReissue(() => setQrPrintIssue((current) => current + 1));
  const qrPrintRequests = useMemo(() => (qrPrintStudents ?? []).map((student) => ({
    key: `${qrPrintIssue}:${student.studentId}`,
    endpoint: tenantApiPath('/api/qrcode'),
    body: { kind: 'student' as const, studentId: student.studentId },
  })), [qrPrintIssue, qrPrintStudents]);
  const qrPrintUrls = useQrObjectUrls(qrPrintRequests);
  const qrPrintUrlFor = (studentId: string) => qrPrintUrls[`${qrPrintIssue}:${studentId}`];
  const allQrPrintUrlsReady = Boolean(qrPrintStudents?.length)
    && qrPrintStudents!.every((student) => Boolean(qrPrintUrlFor(student.studentId)));
  const closeQrPrint = () => { setQrPrintStudents(null); qrReissue.reset(); };
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
  const [taskSheet, setTaskSheet] = useState<TaskSheetState | null>(null);
  const taskSheetRef = useRef(taskSheet);
  taskSheetRef.current = taskSheet;
  const [studentSheet, setStudentSheet] = useState<EntitySheetState<StudentDraft> | null>(null);
  const [productSheet, setProductSheet] = useState<EntitySheetState<ProductDraft> | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [bulkBalanceOpen, setBulkBalanceOpen] = useState(false);
  const [bulkGiveOpener, setBulkGiveOpener] = useState<HTMLElement | null>(null);
  const [shareState, setShareState] = useState<Readonly<{ target: ShareTarget; opener: HTMLElement }> | null>(null);
  const [tutorialMenu, setTutorialMenu] = useState<Readonly<{ opener: HTMLElement | null }> | null>(null);
  const [activeTutorial, setActiveTutorial] = useState<Tutorial | null>(null);
  const [consentFormOpener, setConsentFormOpener] = useState<HTMLElement | null>(null);
  // 디지털 상품: store products whose purchase goes into the buyer's 보관함, by type (PostgreSQL classes).
  const [digitalProducts, setDigitalProductMap] = useState<ReadonlyMap<string, DigitalProductDto>>(() => new Map());
  const setDigitalProducts = useCallback((list: readonly DigitalProductDto[]) => {
    setDigitalProductMap(new Map(list.map((product) => [product.productId, product])));
  }, []);
  const [newProductDigital, setNewProductDigital] = useState<DigitalDraft>(EMPTY_DIGITAL_DRAFT);
  // Unsaved 디지털 상품 settings of the product open in the editor (saved with its 저장 button).
  const [sheetDigitalDraft, setSheetDigitalDraft] = useState<Readonly<{ productId: string; draft: DigitalDraft }> | null>(null);
  useEffect(() => {
    if (tenantApiPath('/api/tasks') === '/api/tasks') return;
    void Promise.resolve().then(async () => {
      const result = await fetchDigitalProducts();
      if (result.ok) setDigitalProducts(result.data);
    });
  }, [setDigitalProducts]);
  const [taskQuery, setTaskQuery] = useState('');
  const [taskFilter, setTaskFilter] = useState<'all' | 'active' | 'hidden'>('all');
  const [studentQuery, setStudentQuery] = useState('');
  const [studentFilter, setStudentFilter] = useState<'all' | 'ACTIVE' | 'INACTIVE'>('all');
  const [productQuery, setProductQuery] = useState('');
  const [productFilter, setProductFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [newTaskRecurrence, setNewTaskRecurrence] = useState<TaskRecurrenceForm>(() => scheduleDtoToForm());
  const [assignmentFilter, setAssignmentFilter] = useState<AssignmentFilter>('all');
  const sheetEditorRequest = useRef('');
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; tone: 'success' | 'warning' }>>([]);
  const toastSeq = useRef(0);
  // PostgreSQL classes (/c/{slug}) use the stage-ledger task screen (src/components/tasks/ledger).
  // There the old task list below never loads; it serves Google Sheets classes only.
  const ledgerMode = isTaskLedgerMode();
  const taskLedger = useTaskLedger({ enabled: ledgerMode, polling: activeTab === 'home' || activeTab === 'tasks' });

  const loadLinkedSheetData = useCallback(async (options: { silent?: boolean; shouldApply?: () => boolean } = {}) => {
    const shouldApply = options.shouldApply ?? (() => true);
    const productEpochAtStart = productMutationEpoch.current;
    const legacyTasks = !isTaskLedgerMode();

    if (!options.silent && shouldApply()) {
      setIsInitialLoading(true);
      setMessage('학생/상품 목록을 불러오는 중이에요.');
    }

    try {
      const [studentResponse, productResponse, taskResponse, settingsResponse] = await Promise.all([
        tenantFetch(studentEditorPath(), { cache: 'no-store' }),
        tenantFetch('/api/products?includeInactive=1', { cache: 'no-store' }),
        legacyTasks ? tenantFetch('/api/tasks?includeInactive=1', { cache: 'no-store' }) : null,
        tenantFetch('/api/settings', { cache: 'no-store' }),
      ]);
      const [studentPayload, productPayload, taskPayload, settingsPayload] = await Promise.all([studentResponse.json(), productResponse.json(), taskResponse ? taskResponse.json() : [], settingsResponse.json().catch(() => null)]);

      if (!studentResponse.ok) throw new Error(studentPayload.error ?? '학생 목록을 불러오지 못했어요.');
      if (!productResponse.ok) throw new Error(productPayload.error ?? '상품 목록을 불러오지 못했어요.');
      if (taskResponse && !taskResponse.ok) throw new Error(taskPayload.error ?? '과제 목록을 불러오지 못했어요.');
      const parsedProducts = parseProductAdminEnvelope(productPayload as unknown);
      const studentSnapshot = studentEditorSnapshot(studentPayload);

      if (!shouldApply()) return;
      setSettings({
        className: typeof settingsPayload?.className === 'string' ? settingsPayload.className : undefined,
        currencyUnit: settingsPayload?.currencyUnit ?? '원',
        appTitle: settingsPayload?.appTitle ?? '학급 매점',
        bankTitle: settingsPayload?.bankTitle ?? '학급 은행',
        themeColor: normalizeThemeColor(settingsPayload?.themeColor),
        fontFamily: settingsPayload?.fontFamily ?? 'default',
        qrManualInputEnabled: Boolean(settingsPayload?.qrManualInputEnabled),
      });
      setStudents(studentSnapshot.students);
      studentStorage.current = studentSnapshot.storage;
      studentSaveAttempt.current = null;
      if (productMutationEpoch.current === productEpochAtStart) {
        setProductAdminState(parsedProducts);
        if (tenantApiPath('/api/products') !== '/api/products') {
          productSaveAttempt.current = null;
          productBatchDeleteAttempt.current = null;
          setProductBatchDeleteNeedsRefresh(false);
        }
        const retainedProductDeleteAttempt = productDeleteAttempt.current;
        if (retainedProductDeleteAttempt
          && parsedProducts.mutationPreconditions.get(retainedProductDeleteAttempt.productId)
            !== retainedProductDeleteAttempt.expectedProductVersion) {
          productDeleteAttempt.current = null;
          productDeleteInFlight.current = false;
          setProductDeleteConfirmation(null);
        }
        setSelectedProductIds((ids) => ids.filter((id) => parsedProducts.products.some((product) => product.productId === id)));
      }
      const loadedTasks = (taskPayload as TaskDraft[]).map(normalizeAdminTask);
      setTasks(loadedTasks);
      setSelectedStudentIds((ids) => ids.filter((id) => studentSnapshot.students.some((student) => student.studentId === id)));
      setSelectedTaskIds((ids) => ids.filter((id) => loadedTasks.some(task => task.taskId === id)));
      setMessage('');
      setIsInitialLoading(false);
    } catch (error) {
      if (!shouldApply()) return;
      setStudents([]);
      setTasks([]);
      setMessage(error instanceof Error ? error.message : '목록을 불러오지 못했어요.');
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

  useEffect(() => {
    if (studentSheet?.mode === 'edit' && !students.some((student) => student.studentId === studentSheet.id)) {
      void Promise.resolve().then(() => setStudentSheet(null));
    }
  }, [studentSheet, students]);

  useEffect(() => {
    if (productSheet?.mode === 'edit' && !products.some((product) => product.productId === productSheet.id)) {
      void Promise.resolve().then(() => setProductSheet(null));
    }
  }, [productSheet, products]);

  function updateStudent(studentId: string, patch: Partial<StudentDraft>) {
    setStudents((current) => current.map((student) => (student.studentId === studentId
      ? { ...student, ...patch, balanceEditRevision: (student.balanceEditRevision ?? 0) + (Object.hasOwn(patch, 'balance') ? 1 : 0) } : student)));
  }

  function updateProduct(productId: string, patch: Partial<ProductDraft>) {
    setProductAdminState((current) => ({
      ...current,
      products: current.products.map((product) => (product.productId === productId
        ? { ...product, ...patch, stockEditRevision: (product.stockEditRevision ?? 0) + (Object.hasOwn(patch, 'stock') ? 1 : 0) } : product)),
    }));
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
    sheetEditorRequest.current = '';
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
        const response = await tenantFetch('/api/tasks/schedules/batch', {
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
        if (!response.ok) throw new Error(payload.error ?? '반복 설정을 저장하지 못했어요.');
        try {
          const taskResponse = await tenantFetch('/api/tasks?includeInactive=1', { cache: 'no-store' });
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
        if (isCurrentSession()) notify(error instanceof Error ? error.message : '반복 설정을 저장하지 못했어요.');
      } finally {
        if (isCurrentSession()) setIsSavingTaskSchedule(false);
      }
      return;
    }
    if (taskScheduleEditor.taskId) {
      const task = tasks.find((item) => item.taskId === taskScheduleEditor.taskId);
      if (!task) return notify('과제를 찾을 수 없어요.');
      setIsSavingTaskSchedule(true);
      try {
        const response = await tenantFetch(`/api/tasks/${encodeURIComponent(task.taskId)}`, {
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
        if (!response.ok) throw new Error(payload.error ?? '반복 설정을 저장하지 못했어요.');
        try {
          const taskResponse = await tenantFetch('/api/tasks?includeInactive=1', { cache: 'no-store' });
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
        if (isCurrentSession()) notify(error instanceof Error ? error.message : '반복 설정을 저장하지 못했어요.');
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
      const response = await tenantFetch(`/api/tasks/${encodeURIComponent(task.taskId)}/history`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '과제 기록을 불러오지 못했어요.');
      if (historyRequestId.current !== requestId) return;
      setTaskHistory({ taskId: task.taskId, title: task.title, loading: false, error: '', detail: payload });
    } catch (error) {
      if (historyRequestId.current !== requestId) return;
      setTaskHistory({ taskId: task.taskId, title: task.title, loading: false, error: error instanceof Error ? error.message : '과제 기록을 불러오지 못했어요.', detail: null });
    }
  }

  function closeTaskHistory() {
    historyRequestId.current += 1;
    setTaskHistory(null);
  }

  function requestTaskDelete(task: TaskDraft, opener: HTMLElement) {
    if (taskSingleDeleteInFlight.current || taskDeleteConfirmation) return;
    if (taskBatchDeleteInFlight.current) return notify('선택 삭제 요청이 남아 있어요. 기존 요청을 다시 시도하거나 거절된 요청을 새로고침해 주세요.');
    closeTaskHistory();
    setTaskDeleteConfirmation({ taskId: task.taskId, title: task.title, opener, deleting: false, error: '' });
  }

  function cancelTaskDelete() {
    if (taskSingleDeleteInFlight.current || taskDeleteConfirmation?.deleting) return;
    setTaskDeleteConfirmation(null);
  }

  function requestProductDelete(product: ProductDraft, opener: HTMLElement) {
    if (productDeleteConfirmation || productDeleteInFlight.current) return;
    productDeleteAttempt.current = null;
    productDeleteInFlight.current = false;
    setProductDeleteConfirmation({
      productId: product.productId,
      name: product.name,
      opener,
      deleting: false,
      error: '',
    });
  }

  function cancelProductDelete() {
    if (productDeleteInFlight.current || productDeleteConfirmation?.deleting) return;
    productDeleteAttempt.current = null;
    setProductDeleteConfirmation(null);
  }

  function notify(messageText: string) {
    const tone = isSuccessNotice(messageText) ? 'success' : 'warning';
    const id = ++toastSeq.current;
    setToasts((current) => [...current.filter((toast) => toast.text !== messageText).slice(-2), { id, text: messageText, tone }]);
    if (tone === 'success') window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4000);
  }

  async function refreshStudents() {
    setIsRefreshingLists(true);
    try {
      const [studentResponse, settingsResponse] = await Promise.all([
        tenantFetch(studentEditorPath(), { cache: 'no-store' }),
        tenantFetch('/api/settings', { cache: 'no-store' }),
      ]);
      const [studentPayload, settingsPayload] = await Promise.all([studentResponse.json(), settingsResponse.json().catch(() => null)]);
      if (!studentResponse.ok) throw new Error(studentPayload.error ?? '학생 목록을 불러오지 못했어요.');
      const snapshot = studentEditorSnapshot(studentPayload);
      setStudents(snapshot.students);
      studentStorage.current = snapshot.storage;
      studentSaveAttempt.current = null;
      setSelectedStudentIds((ids) => ids.filter((id) => snapshot.students.some((student) => student.studentId === id)));
      setSettings({
        className: typeof settingsPayload?.className === 'string' ? settingsPayload.className : undefined,
        currencyUnit: settingsPayload?.currencyUnit ?? '원',
        appTitle: settingsPayload?.appTitle ?? '학급 매점',
        bankTitle: settingsPayload?.bankTitle ?? '학급 은행',
        themeColor: normalizeThemeColor(settingsPayload?.themeColor),
        fontFamily: settingsPayload?.fontFamily ?? 'default',
        qrManualInputEnabled: Boolean(settingsPayload?.qrManualInputEnabled),
      });
      setMessage('');
    } catch (error) {
      notify(error instanceof Error ? error.message : '학생 목록을 불러오지 못했어요.');
    } finally {
      setIsRefreshingLists(false);
    }
  }

  async function refreshProducts() {
    setIsRefreshingLists(true);
    const productEpochAtStart = productMutationEpoch.current;
    try {
      const [productResponse, settingsResponse] = await Promise.all([
        tenantFetch('/api/products?includeInactive=1', { cache: 'no-store' }),
        tenantFetch('/api/settings', { cache: 'no-store' }),
      ]);
      const [productPayload, settingsPayload] = await Promise.all([productResponse.json(), settingsResponse.json().catch(() => null)]);
      if (!productResponse.ok) throw new Error(productPayload.error ?? '상품 목록을 불러오지 못했어요.');
      const parsedProducts = parseProductAdminEnvelope(productPayload as unknown);
      if (productMutationEpoch.current === productEpochAtStart) {
        setProductAdminState(parsedProducts);
        if (tenantApiPath('/api/products') !== '/api/products') {
          productSaveAttempt.current = null;
          productBatchDeleteAttempt.current = null;
          setProductBatchDeleteNeedsRefresh(false);
        }
        const retainedProductDeleteAttempt = productDeleteAttempt.current;
        if (retainedProductDeleteAttempt
          && parsedProducts.mutationPreconditions.get(retainedProductDeleteAttempt.productId)
            !== retainedProductDeleteAttempt.expectedProductVersion) {
          productDeleteAttempt.current = null;
          productDeleteInFlight.current = false;
          setProductDeleteConfirmation(null);
        }
        setSelectedProductIds((ids) => ids.filter((id) => parsedProducts.products.some((product) => product.productId === id)));
      }
      setSettings({
        className: typeof settingsPayload?.className === 'string' ? settingsPayload.className : undefined,
        currencyUnit: settingsPayload?.currencyUnit ?? '원',
        appTitle: settingsPayload?.appTitle ?? '학급 매점',
        bankTitle: settingsPayload?.bankTitle ?? '학급 은행',
        themeColor: normalizeThemeColor(settingsPayload?.themeColor),
        fontFamily: settingsPayload?.fontFamily ?? 'default',
        qrManualInputEnabled: Boolean(settingsPayload?.qrManualInputEnabled),
      });
      setMessage('');
    } catch (error) {
      notify(error instanceof Error ? error.message : '상품 목록을 불러오지 못했어요.');
    } finally {
      setIsRefreshingLists(false);
    }
  }

  /**
   * Shows the server's task list. The only local state kept is an unsaved definition edit in the
   * open task panel, which stays visibly unsaved instead of being overwritten.
   */
  function applyServerTasks(server: TaskDraft[]) {
    const current = taskDraftsRef.current;
    const sheet = taskSheetRef.current;
    const merged = server.map((row) => {
      const local = current.find((task) => task.taskId === row.taskId);
      let next = row;
      if (sheet?.mode === 'edit' && sheet.taskId === row.taskId && local && local.taskInstanceId === row.taskInstanceId) {
        const unsaved = TASK_DEFINITION_FIELDS.filter((field) => JSON.stringify(local[field] ?? null) !== JSON.stringify(sheet.snapshot[field] ?? null));
        if (unsaved.length) next = { ...row, ...Object.fromEntries(unsaved.map((field) => [field, local[field]])), taskVersion: local.taskVersion };
      }
      return local && JSON.stringify(local) === JSON.stringify(next) ? local : next;
    });
    if (merged.length !== current.length || merged.some((row, index) => row !== current[index])) setTasks(merged);
    setSelectedTaskIds((ids) => ids.filter((id) => server.some((task) => task.taskId === id)));
    // The open panel's clean baseline follows the server, so only real local edits look unsaved.
    const sheetRow = sheet?.mode === 'edit' ? server.find((row) => row.taskId === sheet.taskId) : undefined;
    if (sheet?.mode === 'edit' && sheetRow && JSON.stringify(sheetRow) !== JSON.stringify(sheet.snapshot)) {
      setTaskSheet((value) => value?.mode === 'edit' && value.taskId === sheetRow.taskId ? { ...value, snapshot: structuredClone(sheetRow) } : value);
    }
  }

  async function refreshTasks() {
    if (taskSingleDeleteInFlight.current) return;
    if (taskBatchDeleteInFlight.current) return;
    setIsRefreshingLists(true);
    try {
      const [taskResponse, settingsResponse] = await Promise.all([
        tenantFetch('/api/tasks?includeInactive=1', { cache: 'no-store' }),
        tenantFetch('/api/settings', { cache: 'no-store' }),
      ]);
      const [taskPayload, settingsPayload] = await Promise.all([taskResponse.json(), settingsResponse.json().catch(() => null)]);
      if (!taskResponse.ok) throw new Error(taskPayload.error ?? '과제 목록을 불러오지 못했어요.');
      applyServerTasks((taskPayload as TaskDraft[]).map(normalizeAdminTask));
      setTaskDeleteConfirmation(null);
      setSettings({
        className: typeof settingsPayload?.className === 'string' ? settingsPayload.className : undefined,
        currencyUnit: settingsPayload?.currencyUnit ?? '원',
        appTitle: settingsPayload?.appTitle ?? '학급 매점',
        bankTitle: settingsPayload?.bankTitle ?? '학급 은행',
        themeColor: normalizeThemeColor(settingsPayload?.themeColor),
        fontFamily: settingsPayload?.fontFamily ?? 'default',
        qrManualInputEnabled: Boolean(settingsPayload?.qrManualInputEnabled),
      });
      setMessage('');
    } catch (error) {
      notify(error instanceof Error ? error.message : '과제 목록을 불러오지 못했어요.');
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
    const response = await tenantFetch(`/api/tasks/${encodeURIComponent(taskId)}/assignments`, { cache: 'no-store' });
    const payload = await response.json() as TaskAssignmentStatus & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? '과제 부여 상태를 불러오지 못했어요.');
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
        const { assignedIds: loadedAssignedIds, completedIds: loadedCompletedIds, readyIds: loadedReadyIds, statusRows } = status;
        setTasks((current) => reconcileTaskAssignmentProjection(current, taskId, status));
        setTaskAssignmentEditor((current) => current?.taskId === taskId ? {
          ...current,
          selectedIds: [],
          assignedIds: loadedAssignedIds,
          completedIds: loadedCompletedIds,
          readyIds: loadedReadyIds,
          initialAssignedIds: loadedAssignedIds,
          initialReadyIds: loadedReadyIds,
          initialCompletedIds: loadedCompletedIds,
          statusRows,
          isLoading: false,
        } : current);
      })
      .catch((error) => {
        if (assignmentRequest.current.id !== requestId || assignmentRequest.current.taskId !== taskId) return;
        notify(error instanceof Error ? error.message : '과제 부여 상태를 불러오지 못했어요.');
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
    sheetEditorRequest.current = '';
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
        const response = await tenantFetch('/api/tasks/assignments/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targets }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!isCurrentSession()) return;
        if (!response.ok) throw new Error(payload.error ?? '과제 부여 내용을 저장하지 못했어요.');
        const failures = Array.isArray(payload.failures) ? payload.failures as Array<{ taskId?: string; studentId?: string; code?: string }> : [];
        const notAttempted = Array.isArray(payload.notAttempted) ? payload.notAttempted as Array<{ taskId?: string; studentId?: string }> : [];
        const warnings = Array.isArray(payload.warnings) ? payload.warnings as Array<{ taskId?: string; code?: string }> : [];
        const aborted = payload.aborted === true;
        if (failures.length === 0 && notAttempted.length === 0 && !aborted) {
          try {
            const taskResponse = await tenantFetch('/api/tasks?includeInactive=1', { cache: 'no-store' });
            const taskPayload = await taskResponse.json().catch(() => null);
            if (!isCurrentSession()) return;
            if (!taskResponse.ok || !Array.isArray(taskPayload)) throw new Error('refresh failed');
            setTasks((taskPayload as TaskDraft[]).map(normalizeAdminTask));
            setIsSavingChanges(false);
            closeTaskAssignmentEditor();
            if (warnings.length > 0) {
              notify(`과제 부여 저장은 완료됐지만 기존 호환 목록 반영에 실패했어요 (${formatTaskWarnings(warnings, tasks)}). 새로고침 후 확인해 주세요.`);
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
        notify(`${aborted ? '과제 부여 처리가 중단됐어요. ' : '과제 부여 일부 저장 실패. '}다시 시도 대상: ${formatAssignmentFailures(retryItems, tasks, students)}.${warningText}`);
      } catch (error) {
        if (isCurrentSession()) notify(error instanceof Error ? error.message : '과제 부여 내용을 저장하지 못했어요.');
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
      notify('과제를 찾을 수 없어요.');
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
        ...(wasAssigned !== assigned || (wasCompleted !== completed && completed && !assigned) ? { assigned } : {}),
        ...(wasCompleted !== completed ? { completed } : {}),
        source: 'ADMIN' as const,
      }];
    });

    if (commands.length === 0) {
      closeTaskAssignmentEditor();
      notify('과제 부여 저장 완료');
      return;
    }

    const session = { ...assignmentRequest.current };
    const isCurrentSession = () => assignmentRequest.current.id === session.id
      && assignmentRequest.current.taskId === session.taskId;
    const desiredState = {
      assignedIds: [...taskAssignmentEditor.assignedIds],
      completedIds: [...taskAssignmentEditor.completedIds],
    };
    let authoritativeAssignedIds = [...taskAssignmentEditor.initialAssignedIds];
    let authoritativeCompletedIds = [...taskAssignmentEditor.initialCompletedIds];
    let reconciliationFailureMessage = '';
    setIsSavingChanges(true);
    try {
      const response = await tenantFetch('/api/tasks/assignments/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: [{ taskId, operations: commands }] }),
      });
      const rawPayload: unknown = await response.json().catch(() => ({}));
      if (!isCurrentSession()) return;
      if (!response.ok) {
        const errorMessage = isRecord(rawPayload) && typeof rawPayload.error === 'string'
          ? rawPayload.error
          : '과제 부여 내용을 저장하지 못했어요.';
        throw new Error(errorMessage);
      }
      const result = parseAssignmentBatchResult(
        rawPayload, taskId, new Set(commands.map((command) => command.studentId)), commands.length,
      );
      if (!result) throw new Error('과제 부여 저장 결과를 확인하지 못했어요.');
      const { aborted, failures, notAttempted, warnings } = result;
      if (failures.length === 0 && notAttempted.length === 0 && !aborted) {
        setTasks((current) => current.map((item) => item.taskId === taskId
          ? { ...item, allowedStudentIds: desiredState.assignedIds }
          : item));
        setIsSavingChanges(false);
        closeTaskAssignmentEditor();
        if (warnings.length > 0) {
          notify(`과제 부여 저장은 완료됐지만 기존 호환 목록 반영에 실패했어요 (${formatTaskWarnings(warnings, tasks)}). 새로고침 후 확인해 주세요.`);
        } else {
          notify('과제 부여 저장 완료');
        }
        return;
      }

      const pendingPairs = new Set([...failures, ...notAttempted].flatMap((item) =>
        item.taskId && item.studentId ? [`${item.taskId}\u0000${item.studentId}`] : []));
      const pendingCommands = pendingPairs.size > 0
        ? commands.filter((command) => pendingPairs.has(`${taskId}\u0000${command.studentId}`))
        : commands;
      let reconciledStatus: ReturnType<typeof normalizeTaskAssignmentStatus> | null = null;
      try {
        reconciledStatus = await loadTaskAssignmentStatus(taskId);
        if (!isCurrentSession()) return;
        authoritativeAssignedIds = reconciledStatus.assignedIds;
        authoritativeCompletedIds = reconciledStatus.completedIds;
        setTasks((current) => reconcileTaskAssignmentProjection(current, taskId, reconciledStatus!));
      } catch (error) {
        if (!isCurrentSession()) return;
        reconciliationFailureMessage = error instanceof Error
          ? `, 최신 부여 상태 확인 실패: ${error.message}`
          : ', 최신 부여 상태를 확인하지 못했어요.';
      }

      let retryAssignedIds = [...authoritativeAssignedIds];
      let retryCompletedIds = [...authoritativeCompletedIds];
      for (const command of pendingCommands) {
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
        ...(reconciledStatus ? { statusRows: reconciledStatus.statusRows } : {}),
      } : current);
      const retryItems = [
        ...failures,
        ...notAttempted.map((item) => ({ ...item, code: 'NOT_ATTEMPTED' })),
      ];
      const warningText = warnings.length > 0 ? ` 기존 호환 목록 반영 실패: ${formatTaskWarnings(warnings, tasks)}.` : '';
      notify(`${aborted ? '과제 부여 처리가 중단됐어요. ' : '과제 부여 일부 저장 실패. '}다시 시도 대상: ${formatAssignmentFailures(retryItems, tasks, students)}.${warningText}${reconciliationFailureMessage}`);
    } catch (error) {
      if (isCurrentSession()) notify(error instanceof Error ? error.message : '과제 부여 내용을 저장하지 못했어요.');
    } finally {
      if (isCurrentSession()) setIsSavingChanges(false);
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

  async function resolveScannedStudent(decodedText: string): Promise<StudentDraft> {
    const qrValue = decodedText.trim();
    const response = await tenantFetch(`/api/bank/student?studentId=${encodeURIComponent(qrValue)}`, { cache: 'no-store' });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(payload) || typeof payload.studentId !== 'string') {
      throw new Error('잘못된 QR이에요.');
    }
    const student = students.find((item) => item.studentId === payload.studentId && item.status === 'ACTIVE');
    if (!student) throw new Error('잘못된 QR이에요.');
    return student;
  }

  async function assignTaskByQr(decodedText: string) {
    const qrValue = decodedText.trim();
    const taskId = qrTaskScan?.taskId;
    if (!qrValue || !taskId) return;
    setQrTaskScan(null);
    setQrTaskLoading(true);
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    const task = tasks.find((item) => item.taskId === taskId);
    if (!task) {
      setQrTaskResult({ status: 'failure', taskId, message: '과제를 찾을 수 없어요.' });
      setQrTaskLoading(false);
      return;
    }
    let student: StudentDraft;
    try {
      student = await resolveScannedStudent(qrValue);
    } catch {
      setQrTaskResult({ status: 'failure', taskId, message: '잘못된 QR이에요.' });
      setQrTaskLoading(false);
      return;
    }
    if ((task.allowedStudentIds ?? []).includes(student.studentId)) {
      setQrTaskResult({ status: 'failure', taskId, message: '이미 이 과제가 부여된 학생이에요.' });
      setQrTaskLoading(false);
      return;
    }

    const fallbackAssignedIds = [...(task.allowedStudentIds ?? []), student.studentId];

    setQrTaskLoading(false);
    setIsSavingChanges(true);
    try {
      const response = await tenantFetch(`/api/tasks/${encodeURIComponent(task.taskId)}/assignments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: student.studentId, assigned: true, source: 'QR' }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '과제 부여 내용을 저장하지 못했어요.');
      const assignedStudentIds = Array.isArray(payload.students)
        ? payload.students.filter((row: { assigned?: boolean }) => row.assigned).map((row: { studentId: string }) => row.studentId)
        : fallbackAssignedIds;
      if (Array.isArray(payload.students)) setTasks((current) => reconcileTaskAssignmentProjection(current, task.taskId, normalizeTaskAssignmentStatus(payload as TaskAssignmentStatus)));
      else setTasks((current) => current.map((item) => item.taskId === task.taskId ? { ...item, allowedStudentIds: assignedStudentIds } : item));
      setQrTaskResult({ status: 'success', taskId, message: '과제를 부여했어요.' });
    } catch (error) {
      setQrTaskResult({ status: 'failure', taskId, message: error instanceof Error ? error.message : '과제 부여 내용을 저장하지 못했어요.' });
    } finally {
      setIsSavingChanges(false);
    }
  }

  function buildStudentPayload(list: StudentDraft[]) {
    return list.map((student) => ({ studentId: student.studentId, name: student.name,
      ...(studentStorage.current === 'postgresql' ? {
        balance: student.balance, expectedStudentVersion: student.studentVersion, expectedAccountVersion: student.accountVersion,
      } : student.balanceEditRevision ? { balance: student.balance } : {}), status: student.status }));
  }

  function buildProductPayload(list: ProductDraft[]) {
    return list.map((product) => ({ productId: product.productId, name: product.name, price: product.price,
      ...(tenantApiPath('/api/products') !== '/api/products' ? {
        stock: product.stock, expectedProductVersion: productAdminState.mutationPreconditions.get(product.productId),
      } : product.stockEditRevision ? { stock: product.stock } : {}), isActive: product.isActive,
      imageUrl: product.imageUrl ?? '', category: product.category ?? '', sortOrder: product.sortOrder }));
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

  async function saveStudentRows(rows: StudentDraft[], label: string): Promise<boolean> {
    if (studentSaveInFlight.current) return false;
    const postgres = studentStorage.current === 'postgresql';
    if (postgres && rows.some((row) => !Number.isSafeInteger(row.studentVersion) || !Number.isSafeInteger(row.accountVersion))) {
      notify('학생 버전을 확인할 수 없어요. 새로고침 후 다시 편집해 주세요.');
      return false;
    }
    const studentPayload = buildStudentPayload(rows);
    const semanticKey = JSON.stringify(studentPayload);
    if (studentSaveAttempt.current?.semanticKey !== semanticKey) {
      studentSaveAttempt.current = { semanticKey, operationId: crypto.randomUUID() };
    }
    const operationId = studentSaveAttempt.current.operationId;
    studentSaveInFlight.current = true;
    setIsSavingChanges(true);
    try {
      const response = await tenantFetch('/api/students/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId, students: studentPayload }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '학생 명단을 저장하지 못했어요.');
      if (!Array.isArray(payload) || payload.length !== rows.length
        || new Set(payload.map((student) => student?.studentId)).size !== rows.length
        || !payload.every((student) => student && typeof student === 'object'
          && rows.some((row) => row.studentId === student.studentId)
          && Number.isSafeInteger(student.balance) && typeof student.name === 'string'
          && (student.status === 'ACTIVE' || student.status === 'INACTIVE')
          && (!postgres || (Number.isSafeInteger(student.studentVersion) && student.studentVersion > 0
            && Number.isSafeInteger(student.accountVersion) && student.accountVersion > 0)))) {
        throw new Error('학생 저장 결과를 확인하지 못했어요.');
      }
      const savedStudents = payload as StudentDraft[];
      const savedMap = new Map(savedStudents.map((student) => [student.studentId, student]));
      setStudents((current) => current.map((student) => {
        const submitted = rows.find((row) => row.studentId === student.studentId);
        const saved = savedMap.get(student.studentId);
        if (!submitted || !saved) return student;
        if (student === submitted) return { ...student, ...saved, balanceEditRevision: 0 };
        // A changed PG draft remains bound to the originally displayed snapshot.
        if (postgres) return student;
        return (student.balanceEditRevision ?? 0) === (submitted.balanceEditRevision ?? 0)
          ? { ...student, balance: saved.balance, balanceEditRevision: 0 } : student;
      }));
      studentSaveAttempt.current = null;
      notify(`${label} ${rows.length}명 저장 완료`);
      return true;
    } catch (error) {
      notify(`${error instanceof Error ? error.message : '학생 명단을 저장하지 못했어요.'} 새로고침으로 최신 목록을 확인해 주세요.`);
    } finally {
      studentSaveInFlight.current = false;
      setIsSavingChanges(false);
    }
    return false;
  }

  async function saveProductRows(rows: ProductDraft[], label: string): Promise<boolean> {
    if (productSaveInFlight.current) return false;
    const postgres = tenantApiPath('/api/products') !== '/api/products';
    if (postgres && rows.some((row) => !Number.isSafeInteger(productAdminState.mutationPreconditions.get(row.productId)))) {
      notify('상품 버전을 확인할 수 없어요. 새로고침 후 다시 편집해 주세요.');
      return false;
    }
    const productPayload = buildProductPayload(rows);
    const semanticKey = JSON.stringify(productPayload);
    if (productSaveAttempt.current?.semanticKey !== semanticKey) {
      productSaveAttempt.current = { semanticKey, operationId: crypto.randomUUID() };
    }
    const operationId = productSaveAttempt.current.operationId;
    productSaveInFlight.current = true;
    if (postgres) productMutationEpoch.current += 1;
    setIsSavingChanges(true);
    try {
      const response = await tenantFetch('/api/products/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId, products: productPayload }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '매점 목록을 저장하지 못했어요.');
      if (!Array.isArray(payload) || payload.length !== rows.length
        || new Set(payload.map((product) => product?.productId)).size !== rows.length
        || !payload.every((product) => product && typeof product === 'object'
          && rows.some((row) => row.productId === product.productId)
          && Number.isSafeInteger(product.stock) && product.stock >= 0
          && typeof product.name === 'string' && typeof product.isActive === 'boolean'
          && (!postgres || (Number.isSafeInteger(product.productVersion) && product.productVersion > 0)))) {
        throw new Error('상품 저장 결과를 확인하지 못했어요.');
      }
      const savedProducts = payload as Array<ProductDraft & { productVersion?: number }>;
      const savedMap = new Map(savedProducts.map((product) => [product.productId, product]));
      setProductAdminState((current) => {
        const mutationPreconditions = new Map(current.mutationPreconditions);
        const products = current.products.map((product) => {
          const submitted = rows.find((row) => row.productId === product.productId);
          const saved = savedMap.get(product.productId);
          if (!submitted || !saved) return product;
          if (product === submitted) {
            if (postgres) mutationPreconditions.set(product.productId, saved.productVersion!);
            return { ...product, ...saved, stockEditRevision: 0 };
          }
          // A changed draft keeps its displayed version, never the committed reply's.
          if (postgres) return product;
          return (product.stockEditRevision ?? 0) === (submitted.stockEditRevision ?? 0)
            ? { ...product, stock: saved.stock, stockEditRevision: 0 } : product;
        });
        return { ...current, products, mutationPreconditions };
      });
      productSaveAttempt.current = null;
      notify(`${label} ${rows.length}개 저장 완료`);
      return true;
    } catch (error) {
      notify(`${error instanceof Error ? error.message : '매점 목록을 저장하지 못했어요.'} 새로고침으로 최신 목록을 확인해 주세요.`);
    } finally {
      productSaveInFlight.current = false;
      if (postgres) productMutationEpoch.current += 1;
      setIsSavingChanges(false);
    }
    return false;
  }

  async function saveTaskRows(rows: TaskDraft[], label: string): Promise<boolean> {
    setIsSavingChanges(true);
    try {
      const response = await tenantFetch('/api/tasks/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: buildTaskPayload(rows) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '과제 목록을 저장하지 못했어요.');
      const savedTasks = payload as TaskDraft[];
      const savedMap = new Map(savedTasks.map((task) => [task.taskId, task]));
      setTasks((current) => current.map((task) => savedMap.has(task.taskId) ? { ...task, ...savedMap.get(task.taskId) } : task).sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title)));
      setDirtyTaskScheduleIds((current) => current.filter((id) => !savedMap.has(id)));
      notify(`${label} ${rows.length}개 저장 완료`);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : '과제 목록을 저장하지 못했어요.');
    } finally {
      setIsSavingChanges(false);
    }
    return false;
  }

  /**
   * PostgreSQL classes delete against the versions on screen (one operation ID per request); when
   * they no longer match, or a student is already gone, the list is re-read instead of guessed.
   */
  function versionedStudentDeletion(studentIds: readonly string[]):
    | { ok: true; students: Array<{ studentId: string; expectedStudentVersion: number }> }
    | { ok: false } {
    const rows = studentIds.map((studentId) => students.find((student) => student.studentId === studentId));
    if (rows.some((row) => !row || !Number.isSafeInteger(row.studentVersion) || (row.studentVersion ?? 0) < 1)) return { ok: false };
    return { ok: true, students: rows.map((row) => ({ studentId: row!.studentId, expectedStudentVersion: row!.studentVersion! })) };
  }

  async function deleteStudentRow(studentId: string, options: { silent?: boolean } = {}) {
    const postgres = studentStorage.current === 'postgresql';
    const versioned = postgres ? versionedStudentDeletion([studentId]) : null;
    if (versioned && !versioned.ok) {
      notify('학생 정보를 확인할 수 없어 목록을 새로 불러왔어요. 다시 삭제해 주세요.');
      void refreshStudents();
      return;
    }
    try {
      const response = await tenantFetch(`/api/students/${encodeURIComponent(studentId)}`, versioned?.ok ? {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: crypto.randomUUID(), expectedStudentVersion: versioned.students[0].expectedStudentVersion }),
      } : { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (postgres && (response.status === 404 || response.status === 409)) void refreshStudents();
        throw new Error(payload.error ?? '학생을 삭제하지 못했어요.');
      }
      setStudents((current) => current.filter((student) => student.studentId !== studentId));
      setSelectedStudentIds((current) => current.filter((id) => id !== studentId));
      if (!options.silent) notify(`${studentId} 삭제 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '학생을 삭제하지 못했어요.');
    }
  }

  async function deleteSelectedStudents() {
    if (selectedStudentIds.length === 0) return notify('선택된 학생이 없어요.');
    const idsToDelete = [...selectedStudentIds];
    const postgres = studentStorage.current === 'postgresql';
    const versioned = postgres ? versionedStudentDeletion(idsToDelete) : null;
    if (versioned && !versioned.ok) {
      notify('학생 정보를 확인할 수 없어 목록을 새로 불러왔어요. 다시 선택해 삭제해 주세요.');
      void refreshStudents();
      return;
    }
    try {
      const response = await tenantFetch('/api/students/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(versioned?.ok
          ? { operationId: crypto.randomUUID(), students: versioned.students }
          : { studentIds: idsToDelete }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (postgres && (response.status === 404 || response.status === 409)) void refreshStudents();
        throw new Error(payload.error ?? '학생을 삭제하지 못했어요.');
      }
      const deletedIds = Array.isArray(payload.studentIds) ? payload.studentIds : idsToDelete;
      setStudents((current) => current.filter((student) => !deletedIds.includes(student.studentId)));
      setSelectedStudentIds((current) => current.filter((id) => !deletedIds.includes(id)));
      notify(`선택 학생 ${deletedIds.length}명 삭제 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '학생을 삭제하지 못했어요.');
    }
  }

  async function applyBulkStudentBalance() {
    if (selectedStudentIds.length === 0) {
      notify('선택된 학생이 없어요.');
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
      const response = await tenantFetch('/api/students/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds, mode: bulkMode, amount: bulkAmount, operationId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '선택 학생 잔액을 수정하지 못했어요.');
      const balanceMap = new Map((payload as Array<{ studentId: string; balance: number }>).map((item) => [item.studentId, item.balance]));
      setStudents((current) => current.map((student) => balanceMap.has(student.studentId) ? { ...student, balance: balanceMap.get(student.studentId)!, balanceEditRevision: 0 } : student));
      bulkBalanceAttempt.current = null;
      notify(`선택 학생 ${payload.length}명 수정 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '선택 학생 잔액을 수정하지 못했어요.');
    } finally {
      bulkBalanceInFlight.current = false;
    }
  }

  async function confirmProductDelete() {
    if (!productDeleteConfirmation || productDeleteInFlight.current) return;
    const { productId } = productDeleteConfirmation;
    const expectedProductVersion = productAdminState.mutationPreconditions.get(productId);
    if (!Number.isSafeInteger(expectedProductVersion) || Number(expectedProductVersion) <= 0) {
      setProductDeleteConfirmation((current) => current?.productId === productId
        ? { ...current, error: '상품 삭제 전 목록을 새로고침해 주세요.' }
        : current);
      return;
    }

    let attempt = productDeleteAttempt.current;
    if (!attempt || attempt.productId !== productId
      || attempt.expectedProductVersion !== expectedProductVersion) {
      const operationId = crypto.randomUUID();
      if (!isCanonicalOperationId(operationId)) {
        productDeleteAttempt.current = null;
        setProductDeleteConfirmation((current) => current?.productId === productId
          ? { ...current, error: '안전한 상품 삭제 요청을 만들지 못했어요. 다시 시도해 주세요.' }
          : current);
        return;
      }
      attempt = { productId, expectedProductVersion: Number(expectedProductVersion), operationId };
      productDeleteAttempt.current = attempt;
    }

    productDeleteInFlight.current = true;
    setProductDeleteConfirmation((current) => current?.productId === productId
      ? { ...current, deleting: true, error: '' }
      : current);
    try {
      const response = await tenantFetch(`/api/products/${encodeURIComponent(productId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: attempt.operationId,
          expectedProductVersion: attempt.expectedProductVersion,
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || !parseProductDeleteResult(payload, productId)) {
        throw new Error('ambiguous product deletion');
      }
      if (productDeleteAttempt.current !== attempt) return;
      productMutationEpoch.current += 1;
      setProductAdminState((current) => {
        const mutationPreconditions = new Map(current.mutationPreconditions);
        mutationPreconditions.delete(productId);
        return {
          products: current.products.filter((product) => product.productId !== productId),
          mutationPreconditions,
        };
      });
      setSelectedProductIds((current) => current.filter((id) => id !== productId));
      productDeleteAttempt.current = null;
      productDeleteInFlight.current = false;
      setProductDeleteConfirmation(null);
      notify(`${productId} 삭제 완료`);
    } catch {
      if (productDeleteAttempt.current !== attempt) return;
      productDeleteInFlight.current = false;
      setProductDeleteConfirmation((current) => current?.productId === productId
        ? { ...current, deleting: false, error: '상품 삭제 결과를 확인하지 못했어요. 같은 창에서 다시 시도해 주세요.' }
        : current);
    }
  }

  async function deleteSelectedProducts() {
    if (isSavingChanges || productBatchDeleteInFlight.current) return;
    if (selectedProductIds.length === 0) return notify('선택된 상품이 없어요.');
    const idsToDelete = [...selectedProductIds];
    const postgres = tenantApiPath('/api/products') !== '/api/products';
    let body = JSON.stringify({ productIds: idsToDelete });
    let operationId: string | undefined;
    if (postgres) {
      if (productBatchDeleteNeedsRefresh || idsToDelete.length > 100) return notify('상품 목록을 새로고침한 후 100개 이하로 다시 선택해 주세요.');
      const products = [...idsToDelete].sort().map((productId) => ({
        productId, expectedProductVersion: getProductExpectedVersion(productAdminState, productId),
      }));
      if (new Set(idsToDelete).size !== idsToDelete.length
        || products.some((product) => product.expectedProductVersion === undefined)) {
        return notify('상품 정보가 바뀌었어요. 새로고침 후 다시 선택해 주세요.');
      }
      const semanticKey = JSON.stringify(products);
      if (productBatchDeleteAttempt.current?.semanticKey !== semanticKey) {
        const id = crypto.randomUUID();
        if (!isCanonicalOperationId(id)) return notify('안전한 상품 삭제 요청을 만들지 못했어요. 새로고침 후 다시 시도해 주세요.');
        productBatchDeleteAttempt.current = { semanticKey, operationId: id, body: JSON.stringify({ operationId: id, products }) };
      }
      ({ body, operationId } = productBatchDeleteAttempt.current);
    }
    productBatchDeleteInFlight.current = true;
    if (postgres) productMutationEpoch.current += 1;
    setIsSavingChanges(true);
    try {
      const response = await tenantFetch('/api/products/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (postgres && (response.status === 409 || response.status === 404)) {
          setProductBatchDeleteNeedsRefresh(true);
          throw new Error('상품 목록이나 삭제 요청이 바뀌었어요. 새로고침 후 다시 선택해 주세요.');
        }
        throw new Error(postgres ? '상품을 삭제하지 못했어요. 같은 요청으로 다시 시도하거나 새로고침해 주세요.' : payload.error ?? '상품을 삭제하지 못했어요.');
      }
      if (postgres && (!isRecord(payload) || payload.operationId !== operationId
        || !Array.isArray(payload.productIds) || payload.productIds.length !== idsToDelete.length
        || new Set(payload.productIds).size !== idsToDelete.length
        || payload.productIds.some((id: unknown) => typeof id !== 'string' || !idsToDelete.includes(id)))) {
        setProductBatchDeleteNeedsRefresh(true);
        throw new Error('삭제 확인을 검증하지 못했어요. 새로고침 후 다시 선택해 주세요.');
      }
      const deletedIds = Array.isArray(payload.productIds) ? payload.productIds : idsToDelete;
      setProductAdminState((current) => {
        const mutationPreconditions = new Map(current.mutationPreconditions);
        deletedIds.forEach((id: string) => mutationPreconditions.delete(id));
        return {
          products: current.products.filter((product) => !deletedIds.includes(product.productId)),
          mutationPreconditions,
        };
      });
      setSelectedProductIds((current) => current.filter((id) => !deletedIds.includes(id)));
      if (postgres) productBatchDeleteAttempt.current = null;
      notify(`선택 상품 ${deletedIds.length}개 삭제 완료`);
    } catch (error) {
      notify(postgres
        ? `${error instanceof Error ? error.message : '상품을 삭제하지 못했어요.'} 새로고침으로 최신 목록을 확인해 주세요.`
        : error instanceof Error ? error.message : '상품을 삭제하지 못했어요.');
    } finally {
      productBatchDeleteInFlight.current = false;
      if (postgres) productMutationEpoch.current += 1;
      setIsSavingChanges(false);
    }
  }

  async function createNewTask(event?: FormEvent<HTMLFormElement>): Promise<boolean> {
    event?.preventDefault();
    if (taskCreationInFlight.current) return false;
    let succeeded = false;
    const body = buildTaskCreationBody(
      newTask,
      nextPrefixedId(tasks.map((task) => task.taskId), 'T'),
    );
    const canonicalBody = canonicalTaskCreationBody(body);
    const semanticKey = JSON.stringify(canonicalBody);
    if (!taskCreationAttempt.current || taskCreationAttempt.current.semanticKey !== semanticKey) {
      taskCreationAttempt.current = { semanticKey, operationId: crypto.randomUUID() };
    }
    const operationId = taskCreationAttempt.current.operationId;
    taskCreationInFlight.current = true;
    try {
      const response = await tenantFetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId, ...body }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(isRecord(payload) && typeof payload.error === 'string'
          ? payload.error : '과제를 추가하지 못했어요.');
      }
      if (!isCreatedTask(payload, canonicalBody)) throw new Error('과제를 추가하지 못했어요.');
      const createdTask = normalizeAdminTask(payload);
      setTasks((current) => [...current.filter((task) => task.taskId !== createdTask.taskId), createdTask]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title)));
      setNewTask((current) => JSON.stringify(canonicalTaskCreationBody(buildTaskCreationBody(current, body.taskId))) === semanticKey
        ? EMPTY_TASK : current);
      if (taskCreationAttempt.current?.operationId === operationId) taskCreationAttempt.current = null;
      notify(`${createdTask.taskId} 과제 추가 완료`);
      succeeded = true;
      if (createdTask.schedule?.recurrence.type !== 'NONE') {
        try {
          const taskResponse = await tenantFetch('/api/tasks?includeInactive=1', { cache: 'no-store' });
          const taskPayload: unknown = await taskResponse.json().catch(() => null);
          if (!taskResponse.ok || !Array.isArray(taskPayload)) {
            throw new Error(isRecord(taskPayload) && typeof taskPayload.error === 'string'
              ? taskPayload.error : '최신 과제 회차를 불러오지 못했어요.');
          }
          const matchingTasks = taskPayload.filter((task) => isRecord(task) && task.taskId === createdTask.taskId);
          if (matchingTasks.length !== 1 || !isCompleteTaskProjection(matchingTasks[0], createdTask.taskId)
            || matchingTasks[0].taskInstanceId !== createdTask.taskInstanceId) {
            throw new Error('만든 과제의 최신 회차가 아직 조회되지 않아요.');
          }
          const refreshedTask = normalizeAdminTask(matchingTasks[0] as TaskDraft);
          setTasks((current) => {
            const next = current.some((task) => task.taskId === refreshedTask.taskId)
              ? current.map((task) => task === createdTask ? refreshedTask : task)
              : [...current, refreshedTask];
            return next.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
          });
        } catch (error) {
          notify(`${createdTask.taskId} 과제는 추가했지만 회차 정보를 새로고침하지 못했어요: ${error instanceof Error ? error.message : '최신 과제 회차를 불러오지 못했어요.'}`);
        }
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '과제를 추가하지 못했어요.');
    } finally {
      taskCreationInFlight.current = false;
    }
    return succeeded;
  }

  async function confirmTaskDelete() {
    if (!taskDeleteConfirmation || taskSingleDeleteInFlight.current) return;
    const { taskId } = taskDeleteConfirmation;
    taskSingleDeleteInFlight.current = true;
    setTaskDeleteConfirmation((current) => current ? { ...current, deleting: true, error: '' } : current);
    try {
      const response = await tenantFetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
      await response.json().catch(() => null);
      if (!response.ok) throw new Error('삭제 응답을 확인하지 못했어요.');
      setTasks((current) => current.filter((task) => task.taskId !== taskId));
      setSelectedTaskIds((current) => current.filter((id) => id !== taskId));
      setTaskDeleteConfirmation(null);
      notify(`${taskId} 과제 삭제 완료`);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : '과제를 삭제하지 못했어요.';
      setTaskDeleteConfirmation((current) => current?.taskId === taskId ? { ...current, deleting: false, error: messageText } : current);
      notify(messageText);
    } finally {
      taskSingleDeleteInFlight.current = false;
    }
  }

  async function deleteSelectedTasks() {
    if (taskSingleDeleteInFlight.current) return notify('개별 삭제 요청이 남아 있어요. 원래 과제의 같은 요청을 다시 시도하거나 거절된 요청을 새로고침해 주세요.');
    if (selectedTaskIds.length === 0) return notify('선택된 과제가 없어요.');
    if (taskBatchDeleteInFlight.current) return;
    const idsToDelete = [...selectedTaskIds];
    try {
      taskBatchDeleteInFlight.current = true;
      const response = await tenantFetch('/api/tasks/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: idsToDelete }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const result = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '과제를 삭제하지 못했어요.');
      const deletedIds: string[] = Array.isArray(result.taskIds) ? result.taskIds : idsToDelete;
      setTasks((current) => current.filter((task) => !deletedIds.includes(task.taskId)));
      setSelectedTaskIds((current) => current.filter((id) => !deletedIds.includes(id)));
      notify(`선택 과제 ${deletedIds.length}개 삭제 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '과제를 삭제하지 못했어요.');
    } finally {
      taskBatchDeleteInFlight.current = false;
    }
  }

  function requestTaskCompletionReset(target: TaskDialogTarget, opener: HTMLElement) {
    if (target.tasks.length === 0) return notify('선택된 과제가 없어요.');
    setTaskResetConfirmation({ target, opener, operationId: crypto.randomUUID(), resetting: false, error: '' });
  }

  async function confirmTaskCompletionReset() {
    if (!taskResetConfirmation || taskResetConfirmation.resetting) return;
    const { target, operationId } = taskResetConfirmation;
    const taskIds = target.tasks.map((task) => task.taskId);
    setTaskResetConfirmation((current) => current ? { ...current, resetting: true, error: '' } : current);
    try {
      const response = await tenantFetch('/api/tasks/completions/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds, operationId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '과제 완료 기록을 초기화하지 못했어요.');
      let taskPayload: unknown;
      try {
        const taskResponse = await tenantFetch('/api/tasks?includeInactive=1', { cache: 'no-store' });
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
            readyIds: status.readyIds,
            initialAssignedIds: status.assignedIds,
            initialReadyIds: status.readyIds,
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
      const errorText = error instanceof Error ? error.message : '과제 완료 기록을 초기화하지 못했어요.';
      setTaskResetConfirmation((current) => current ? { ...current, resetting: false, error: errorText } : current);
      notify(errorText);
    }
  }

  async function createNewStudent(event?: FormEvent<HTMLFormElement>): Promise<boolean> {
    event?.preventDefault();
    if (studentCreationInFlight.current) return false;
    let succeeded = false;
    const body = {
      studentId: newStudent.studentId,
      name: newStudent.name,
      balance: newStudent.balance,
      status: newStudent.status,
    };
    const semanticBody = { ...body, studentId: body.studentId.trim(), name: body.name.trim() };
    const semanticKey = JSON.stringify(semanticBody);
    if (studentCreationAttempt.current?.semanticKey !== semanticKey) {
      studentCreationAttempt.current = { semanticKey, operationId: crypto.randomUUID() };
    }
    const operationId = studentCreationAttempt.current.operationId;
    studentCreationInFlight.current = true;
    try {
      const response = await tenantFetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId, ...body }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(isRecord(payload) && typeof payload.error === 'string'
          ? payload.error
          : '학생을 추가하지 못했어요.');
      }
      if (!isCreatedStudent(payload, semanticBody)) {
        throw new Error('학생을 추가하지 못했어요.');
      }
      let createdStudent: StudentDraft = payload;
      let refreshWarning = '';
      if (studentStorage.current === 'postgresql') {
        try {
          const latest = await tenantFetch(studentEditorPath(), { cache: 'no-store' });
          if (!latest.ok) throw new Error('학생 조회 실패');
          const snapshot = studentEditorSnapshot(await latest.json());
          const matches = snapshot.students.filter(student => student.studentId === payload.studentId);
          if (snapshot.storage !== 'postgresql' || matches.length !== 1) throw new Error('학생 조회 실패');
          createdStudent = matches[0];
        } catch { refreshWarning = ' 학생은 등록했지만 편집 정보를 불러오지 못했어요. 명단을 새로고침한 뒤 편집해 주세요.'; }
      }
      // Merge the complete fetched row with its versions, never attach fresh
      // versions to an old balance or replace other unsaved rows.
      setStudents((current) => sortStudentsById([...current.filter(student => student.studentId !== payload.studentId), createdStudent]));
      setNewStudent((current) => JSON.stringify({
        ...current,
        studentId: current.studentId.trim(),
        name: current.name.trim(),
      }) === semanticKey ? EMPTY_STUDENT : current);
      studentCreationAttempt.current = null;
      notify(`${payload.studentId} 추가 완료${refreshWarning}`);
      succeeded = true;
    } catch (error) {
      notify(error instanceof Error ? error.message : '학생을 추가하지 못했어요.');
    } finally {
      studentCreationInFlight.current = false;
    }
    return succeeded;
  }

  async function createNewProduct(event?: FormEvent<HTMLFormElement>): Promise<boolean> {
    event?.preventDefault();
    if (productCreationInFlight.current) return false;
    const digitalSetting = digitalSettingOf(newProductDigital);
    if (!digitalSetting.ok) { notify(digitalSetting.error); return false; }
    let succeeded = false;
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
    const semanticKey = JSON.stringify(body);
    if (productCreationAttempt.current?.semanticKey !== semanticKey) {
      productCreationAttempt.current = { semanticKey, operationId: crypto.randomUUID() };
    }
    const operationId = productCreationAttempt.current.operationId;
    productCreationInFlight.current = true;
    try {
      const response = await tenantFetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId, ...body }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(isRecord(payload) && typeof payload.error === 'string'
          ? payload.error
          : '상품을 추가하지 못했어요.');
      }
      if (!isCreatedProduct(payload, body.productId)) {
        throw new Error('상품을 추가하지 못했어요.');
      }
      let createdProduct: Product = payload;
      let createdVersion: number | undefined;
      let refreshWarning = '';
      if (tenantApiPath('/api/products') !== '/api/products') {
        try {
          const latest = await tenantFetch('/api/products?includeInactive=1', { cache: 'no-store' });
          if (!latest.ok) throw new Error('상품 조회 실패');
          const snapshot = parseProductAdminEnvelope(await latest.json());
          const matches = snapshot.products.filter(product => product.productId === payload.productId);
          if (matches.length !== 1) throw new Error('상품 조회 실패');
          createdProduct = matches[0];
          createdVersion = snapshot.mutationPreconditions.get(payload.productId);
        } catch { refreshWarning = ' 상품은 등록했지만 편집 정보를 불러오지 못했어요. 목록을 새로고침한 뒤 편집해 주세요.'; }
        productMutationEpoch.current += 1;
      }
      setProductAdminState((current) => {
        const mutationPreconditions = new Map(current.mutationPreconditions);
        if (createdVersion !== undefined) mutationPreconditions.set(payload.productId, createdVersion);
        return { mutationPreconditions,
          products: [...current.products.filter(product => product.productId !== payload.productId), createdProduct]
            .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)) };
      });
      setNewProduct((current) => {
        const currentSemanticKey = JSON.stringify({
          productId: body.productId,
          name: current.name,
          price: current.price,
          stock: current.stock,
          isActive: current.isActive,
          imageUrl: current.imageUrl,
          category: current.category,
          sortOrder: current.sortOrder,
        });
        return currentSemanticKey === semanticKey ? EMPTY_PRODUCT : current;
      });
      productCreationAttempt.current = null;
      if (digitalSetting.setting) {
        const marked = await saveDigitalProduct(payload.productId, digitalSetting.setting);
        if (marked.ok) setDigitalProducts(marked.data);
        else refreshWarning += ' 디지털 상품 설정은 저장하지 못했어요. 상품을 열어 다시 설정해 주세요.';
      }
      setNewProductDigital(EMPTY_DIGITAL_DRAFT);
      notify(`${payload.productId} 추가 완료${refreshWarning}`);
      succeeded = true;
    } catch (error) {
      notify(error instanceof Error ? error.message : '상품을 추가하지 못했어요.');
    } finally {
      productCreationInFlight.current = false;
    }
    return succeeded;
  }

  async function applyCurrencyToStudent(decodedText: string, retry?: { mode: CurrencyMode; amount: number }) {
    const qrValue = decodedText.trim();
    if (!qrValue) return;
    if (currencyInFlight.current) return;
    const mode = retry?.mode ?? currencyMode;
    const amount = retry?.amount ?? currencyAmount;
    let studentId = qrValue;
    currencyInFlight.current = true;
    setCurrencyScannerOpen(false);
    setCurrencyLoading(true);
    try {
      studentId = (await resolveScannedStudent(qrValue)).studentId;
      const semanticKey = JSON.stringify({ studentIds: [studentId], mode, amount });
      if (currencyAttempt.current?.semanticKey !== semanticKey) {
        currencyAttempt.current = { semanticKey, operationId: crypto.randomUUID() };
      }
      const operationId = currencyAttempt.current.operationId;
      const response = await tenantFetch('/api/students/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: [studentId], mode, amount, operationId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '화폐를 조정하지 못했어요.');
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
        message: error instanceof Error ? error.message : '화폐를 조정하지 못했어요.',
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

  // The task editor panel reuses the recurrence/assignment editor state of the standalone dialogs.
  useEffect(() => {
    if (!taskSheet || taskSheet.mode !== 'edit') return;
    const task = tasks.find((row) => row.taskId === taskSheet.taskId);
    if (!task) {
      void Promise.resolve().then(() => setTaskSheet((current) => current?.mode === 'edit' && current.taskId === taskSheet.taskId ? null : current));
      return;
    }
    if (taskSheet.resync) {
      // A definition save succeeded: the submitted values become the clean baseline, so
      // edits made while the request was in flight stay visibly unsaved.
      const submitted = taskSheet.resync;
      void Promise.resolve().then(() => setTaskSheet((current) => {
        if (current?.mode !== 'edit' || current.taskId !== task.taskId) return current;
        const latest = taskDraftsRef.current.find((row) => row.taskId === task.taskId) ?? task;
        return { ...current, resync: undefined, snapshot: { ...structuredClone(latest),
          ...Object.fromEntries(TASK_DEFINITION_FIELDS.map((field) => [field, submitted[field]])) } };
      }));
    } else if (task.taskVersion !== taskSheet.snapshot.taskVersion || task.taskInstanceId !== taskSheet.snapshot.taskInstanceId) {
      // Another save (recurrence, assignment) advanced the version. Carry only the server-owned
      // fields so unsent definition edits stay visibly unsaved.
      void Promise.resolve().then(() => setTaskSheet((current) => {
        if (current?.mode !== 'edit' || current.taskId !== task.taskId) return current;
        const latest = taskDraftsRef.current.find((row) => row.taskId === task.taskId) ?? task;
        return { ...current, snapshot: { ...current.snapshot, taskVersion: latest.taskVersion, taskInstanceId: latest.taskInstanceId,
          schedule: latest.schedule, pendingSchedule: latest.pendingSchedule, currentCycle: latest.currentCycle } };
      }));
    }
    const key = `${taskSheet.tab}:${task.taskId}`;
    if (taskSheet.tab === 'schedule' && !taskScheduleEditor && !isSavingTaskSchedule && sheetEditorRequest.current !== `${key}:${task.taskVersion ?? ''}:${JSON.stringify(task.schedule ?? null)}`) {
      sheetEditorRequest.current = `${key}:${task.taskVersion ?? ''}:${JSON.stringify(task.schedule ?? null)}`;
      void Promise.resolve().then(() => openTaskScheduleEditor(task, null));
    }
    if (taskSheet.tab === 'students' && !taskAssignmentEditor && !isSavingChanges && sheetEditorRequest.current !== `${key}:${task.taskVersion ?? ''}:${JSON.stringify(task.currentCycle?.assignedStudentIds ?? task.allowedStudentIds ?? [])}`) {
      sheetEditorRequest.current = `${key}:${task.taskVersion ?? ''}:${JSON.stringify(task.currentCycle?.assignedStudentIds ?? task.allowedStudentIds ?? [])}`;
      void Promise.resolve().then(() => openTaskAssignmentEditor(task.taskId, task.allowedStudentIds ?? [], null));
    }
    // Editor openers are stable component functions; only state changes should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskSheet, tasks, taskScheduleEditor, taskAssignmentEditor, isSavingTaskSchedule, isSavingChanges]);

  const currencyActionLabel = currencyMode === 'add' ? '지급' : '회수';
  const themeColor = normalizeThemeColor(settings.themeColor);
  const semantic = themeStyles(themeColor);
  const fontFamilyCss = getFontFamilyCss(settings.fontFamily);
  const rootStyle = { ...semantic.variables, ...(fontFamilyCss ? { fontFamily: fontFamilyCss } : {}) };
  const unit = settings.currencyUnit ?? '원';
  const tenantScoped = tenantApiPath('/api/tasks') !== '/api/tasks';
  // Store products the teacher can put into a 보관함 (a physical product goes in as its 교환권).
  const giveOptions = products.map((product) => ({
    productId: product.productId, name: product.name, kind: digitalProducts.get(product.productId)?.kind ?? null, isActive: product.isActive,
  }));
  const digitalLabel = (productId: string) => {
    const digital = digitalProducts.get(productId);
    return digital ? `, 디지털 ${DIGITAL_KIND_LABELS[digital.kind]}` : '';
  };
  const money = (value: number) => `${value.toLocaleString('ko-KR')}${unit}`;

  /* ---------------- task panel helpers ---------------- */
  const sheetTask = taskSheet?.mode === 'edit' ? tasks.find((task) => task.taskId === taskSheet.taskId) ?? null : null;
  const sheetScheduleEditor = taskSheet?.mode === 'edit' && taskScheduleEditor?.taskId === taskSheet.taskId && taskScheduleEditor.target.kind === 'single' ? taskScheduleEditor : null;
  const sheetAssignmentEditor = taskSheet?.mode === 'edit' && taskAssignmentEditor?.taskId === taskSheet.taskId && taskAssignmentEditor.target.kind === 'single' ? taskAssignmentEditor : null;
  const taskBasicDirty = Boolean(taskSheet?.mode === 'edit' && sheetTask
    && TASK_DEFINITION_FIELDS.some((field) => JSON.stringify(sheetTask[field] ?? null) !== JSON.stringify(taskSheet.snapshot[field] ?? null)));
  const taskScheduleDirty = Boolean(sheetTask && sheetScheduleEditor
    && JSON.stringify(sheetScheduleEditor.form) !== JSON.stringify(scheduleDtoToForm(resolveEffectiveAdminTaskSchedule(sheetTask), { taskInstanceId: sheetTask.taskInstanceId })));
  const taskAssignmentDirty = Boolean(sheetAssignmentEditor
    && (JSON.stringify([...sheetAssignmentEditor.assignedIds].sort()) !== JSON.stringify([...sheetAssignmentEditor.initialAssignedIds].sort())
      || JSON.stringify([...(sheetAssignmentEditor.readyIds ?? [])].sort()) !== JSON.stringify([...(sheetAssignmentEditor.initialReadyIds ?? [])].sort())
      || JSON.stringify([...sheetAssignmentEditor.completedIds].sort()) !== JSON.stringify([...sheetAssignmentEditor.initialCompletedIds].sort())));

  function openTaskSheet(task: TaskDraft, opener: HTMLElement | null, tab: TaskSheetTab = 'basic') {
    sheetEditorRequest.current = '';
    setAssignmentFilter('all');
    setTaskSheet({ mode: 'edit', taskId: task.taskId, tab, snapshot: structuredClone(task), opener });
  }

  function openNewTaskSheet(opener: HTMLElement | null) {
    setNewTaskRecurrence(scheduleDtoToForm(newTask.schedule));
    setTaskSheet({ mode: 'new', tab: 'basic', opener });
  }

  function switchTaskSheetTab(tab: TaskSheetTab) {
    sheetEditorRequest.current = '';
    setTaskSheet((current) => current ? { ...current, tab } : current);
    if (taskSheet?.mode === 'edit' && tab !== 'schedule' && sheetScheduleEditor && !taskScheduleDirty && !isSavingTaskSchedule) {
      // A clean recurrence editor must not block definition saves.
      closeTaskScheduleEditor();
    }
  }

  function revertTaskBasic() {
    if (taskSheet?.mode !== 'edit') return;
    const snapshot = taskSheet.snapshot;
    updateTask(taskSheet.taskId, Object.fromEntries(TASK_DEFINITION_FIELDS.map((field) => [field, snapshot[field]])) as Partial<TaskDraft>);
  }

  function closeTaskSheet(force = false) {
    if (!taskSheet) return;
    if (!force && (taskBasicDirty || taskScheduleDirty || taskAssignmentDirty)) {
      setConfirmState({
        title: '저장하지 않은 변경 사항이 있어요',
        description: '닫으면 이 과제에서 바꾼 내용이 사라져요.',
        confirmLabel: '저장하지 않고 닫기',
        tone: 'warning',
        onConfirm: () => { setConfirmState(null); closeTaskSheet(true); },
      });
      return;
    }
    if (taskSheet.mode === 'edit') {
      if (taskBasicDirty) revertTaskBasic();
      if (sheetScheduleEditor && !isSavingTaskSchedule) closeTaskScheduleEditor();
      if (sheetAssignmentEditor && !isSavingChanges) closeTaskAssignmentEditor();
    }
    setTaskSheet(null);
  }

  async function saveTaskSheetBasic() {
    if (!sheetTask) return;
    const submitted = structuredClone(sheetTask);
    const ok = await saveTaskRows([sheetTask], '과제');
    if (ok) setTaskSheet((current) => current?.mode === 'edit' ? { ...current, resync: submitted } : current);
  }

  async function saveTaskSheetSchedule() {
    if (taskSheet?.mode !== 'edit') return;
    await applyTaskScheduleEditor();
  }

  async function submitNewTask() {
    const parsed = scheduleFormToPayload(newTaskRecurrence);
    if (!parsed.ok) { switchTaskSheetTab('schedule'); notify(parsed.error); return; }
    if (!newTask.title.trim()) { switchTaskSheetTab('basic'); notify('과제 이름을 입력해 주세요.'); return; }
    const ok = await createNewTask();
    if (ok) { setNewTaskRecurrence(scheduleDtoToForm()); setTaskSheet(null); }
  }

  function updateNewTaskRecurrence(form: TaskRecurrenceForm) {
    setNewTaskRecurrence(form);
    const parsed = scheduleFormToPayload(form);
    if (parsed.ok) setNewTask((current) => ({ ...current, schedule: { ruleVersion: 1, effectiveFrom: '', ...parsed.payload } }));
  }

  function taskProgress(task: TaskDraft) {
    const cycle = task.currentCycle;
    const assigned = cycle ? cycle.assignedStudentIds.length : (task.allowedStudentIds ?? []).length;
    const completed = cycle ? cycle.completedStudentIds.length : null;
    // Lists from before stages existed have no stage arrays.
    const pending = cycle?.pendingStudentIds ? cycle.pendingStudentIds.length : null;
    const ready = cycle?.readyStudentIds ? cycle.readyStudentIds.length
      : cycle?.pendingStudentIds ? cycle.assignedStudentIds.filter((id) => !cycle.pendingStudentIds!.includes(id)
        && !cycle.completedStudentIds.includes(id)).length : null;
    return { assigned, completed, pending, ready };
  }

  function taskStatus(task: TaskDraft): { label: string; tone: 'success' | 'neutral' | 'warning' | 'info' } {
    if (!task.isActive) return { label: '숨김', tone: 'neutral' };
    const state = classifyTaskAvailability(task);
    if (state === 'UPCOMING') return { label: '시작 전', tone: 'info' };
    if (state === 'EXPIRED') return { label: '마감됨', tone: 'warning' };
    return { label: '진행 중', tone: 'success' };
  }

  function taskMeta(task: TaskDraft) {
    const parts: Array<{ icon: IconName; text: string }> = [];
    const schedule = resolveEffectiveAdminTaskSchedule(task);
    if (schedule && schedule.recurrence.type !== 'NONE') parts.push({ icon: 'repeat', text: formatRecurrenceSummary(schedule) });
    if (task.dueAt) parts.push({ icon: 'calendar', text: `${formatShortDate(task.dueAt)}까지` });
    else if (task.availableFrom && classifyTaskAvailability(task) === 'UPCOMING') parts.push({ icon: 'calendar', text: `${formatShortDate(task.availableFrom)}부터` });
    if (task.prerequisiteTaskId) {
      const prerequisite = tasks.find((candidate) => candidate.taskId === task.prerequisiteTaskId);
      parts.push({ icon: 'lock', text: `선행: ${prerequisite?.title ?? task.prerequisiteTaskId}` });
    }
    return parts;
  }

  /* ---------------- student & product panel helpers ---------------- */
  const sheetStudent = studentSheet?.mode === 'edit' ? students.find((student) => student.studentId === studentSheet.id) ?? null : null;
  const studentDirty = Boolean(studentSheet?.mode === 'edit' && sheetStudent
    && (sheetStudent.name !== studentSheet.snapshot.name || sheetStudent.balance !== studentSheet.snapshot.balance || (sheetStudent.status ?? 'ACTIVE') !== (studentSheet.snapshot.status ?? 'ACTIVE')));
  const sheetProduct = productSheet?.mode === 'edit' ? products.find((product) => product.productId === productSheet.id) ?? null : null;
  const productFields = ['name', 'price', 'stock', 'category', 'imageUrl', 'sortOrder', 'isActive'] as const;
  const productFieldsDirty = Boolean(productSheet?.mode === 'edit' && sheetProduct
    && productFields.some((field) => JSON.stringify(sheetProduct[field] ?? null) !== JSON.stringify(productSheet.snapshot[field] ?? null)));
  const savedSheetDigital = sheetProduct ? digitalDraftOf(digitalProducts.get(sheetProduct.productId)) : EMPTY_DIGITAL_DRAFT;
  const sheetDigital = sheetProduct && sheetDigitalDraft?.productId === sheetProduct.productId ? sheetDigitalDraft.draft : savedSheetDigital;
  const digitalDirty = Boolean(sheetProduct) && !sameDigitalDraft(sheetDigital, savedSheetDigital);
  const productDirty = productFieldsDirty || digitalDirty;

  /** Saves the open product: its fields, then its 디지털 상품 settings. */
  async function saveProductSheet(product: ProductDraft) {
    const digitalSetting = digitalSettingOf(sheetDigital);
    if (!digitalSetting.ok) { notify(digitalSetting.error); return; }
    if (productFieldsDirty && !await saveProductRows([product], '상품')) return;
    if (digitalDirty) {
      const result = await saveDigitalProduct(product.productId, digitalSetting.setting);
      if (!result.ok) { notify(result.error); return; }
      setDigitalProducts(result.data);
      const saved = result.data.find((entry) => entry.productId === product.productId);
      notify(saved ? `'${product.name}' 상품을 디지털 상품(${DIGITAL_KIND_LABELS[saved.kind]})으로 저장했어요.`
        : `'${product.name}' 상품의 디지털 상품 설정을 끄고 저장했어요.`);
    }
    setSheetDigitalDraft(null);
    setProductSheet(null);
  }
  const productCategories = Array.from(new Set(products.map((product) => product.category?.trim()).filter((value): value is string => Boolean(value))));

  function confirmDiscard(close: () => void) {
    setConfirmState({
      title: '저장하지 않은 변경 사항이 있어요',
      description: '닫으면 바꾼 내용이 사라져요.',
      confirmLabel: '저장하지 않고 닫기',
      tone: 'warning',
      onConfirm: () => { setConfirmState(null); close(); },
    });
  }

  function closeStudentSheet(force = false) {
    if (!force && studentSheet?.mode === 'edit' && studentDirty) { confirmDiscard(() => closeStudentSheet(true)); return; }
    if (studentSheet?.mode === 'edit' && studentDirty) {
      // Restore the opened row as-is (including its edit revision), so a cancelled
      // edit never marks the balance as manually changed.
      const snapshot = studentSheet.snapshot;
      setStudents((current) => current.map((student) => student.studentId === snapshot.studentId
        ? { ...student, name: snapshot.name, balance: snapshot.balance, status: snapshot.status, balanceEditRevision: snapshot.balanceEditRevision } : student));
    }
    setStudentSheet(null);
  }

  function closeProductSheet(force = false) {
    if (!force && productSheet?.mode === 'edit' && productDirty) { confirmDiscard(() => closeProductSheet(true)); return; }
    setSheetDigitalDraft(null);
    if (productSheet?.mode === 'edit' && productFieldsDirty) {
      const snapshot = productSheet.snapshot;
      setProductAdminState((current) => ({
        ...current,
        products: current.products.map((product) => product.productId === snapshot.productId
          ? { ...product, ...Object.fromEntries(productFields.map((field) => [field, snapshot[field]])), stockEditRevision: snapshot.stockEditRevision } : product),
      }));
    }
    setProductSheet(null);
  }

  function confirmDelete(title: string, description: ReactNode, action: () => Promise<unknown> | unknown, confirmLabel = '삭제') {
    setConfirmState({ title, description, confirmLabel, tone: 'danger', onConfirm: async () => {
      setConfirmState((current) => current ? { ...current, busy: true } : current);
      try { await action(); } finally { setConfirmState(null); }
    } });
  }

  /* ---------------- derived lists ---------------- */
  const normalizedTaskQuery = taskQuery.trim().toLowerCase();
  const visibleTasks = tasks.filter((task) => (taskFilter === 'all' || (taskFilter === 'active' ? task.isActive : !task.isActive))
    && (!normalizedTaskQuery || `${task.title} ${task.description} ${task.taskId}`.toLowerCase().includes(normalizedTaskQuery)));
  const normalizedStudentQuery = studentQuery.trim().toLowerCase();
  const visibleStudents = students.filter((student) => (studentFilter === 'all' || (student.status ?? 'ACTIVE') === studentFilter)
    && (!normalizedStudentQuery || `${student.studentId} ${student.name}`.toLowerCase().includes(normalizedStudentQuery)));
  const normalizedProductQuery = productQuery.trim().toLowerCase();
  const visibleProducts = products.filter((product) => (productFilter === 'all' || (productFilter === 'active' ? product.isActive : !product.isActive))
    && (!normalizedProductQuery || `${product.name} ${product.category ?? ''} ${product.productId}`.toLowerCase().includes(normalizedProductQuery)));
  const totalBalance = students.reduce((sum, student) => sum + (Number.isFinite(student.balance) ? student.balance : 0), 0);
  const negativeStudents = students.filter((student) => student.balance < 0);
  const lowStockProducts = products.filter((product) => product.isActive && product.stock <= 3);

  const tutorialPlace = { ledgerMode, classList: tenantScoped };
  const overlayOpen = Boolean(tutorialMenu || taskHistory || taskDeleteConfirmation || productDeleteConfirmation || taskScheduleEditor || taskAssignmentEditor || taskResetConfirmation
    || taskSheet || studentSheet || productSheet || confirmState || bulkBalanceOpen || bulkGiveOpener || qrPrintStudents || qrTaskPickerOpen || qrTaskScan || qrTaskResult
    || currencyScannerOpen || currencyResult || taskDescriptionEditor || taskLedger.overlayOpen || shareState || consentFormOpener);
  const ledgerTasks = ledgerTaskSummary(taskLedger);
  // Home tab task numbers: the ledger board in PostgreSQL classes (null while it loads), else the old list.
  const homeTaskCounts = ledgerMode ? ledgerTasks : { active: summary.activeTasks, total: tasks.length };
  const nestedOverTaskSheet = Boolean(taskHistory || taskDeleteConfirmation || taskResetConfirmation || confirmState || isSavingChanges || isSavingTaskSchedule);

  if (isInitialLoading) {
    return <LoadingScreen title="학급 정보 불러오는 중" message="관리자 데이터와 테마 설정을 불러오는 중이에요." />;
  }

  const storeHref = tenantPagePath('/');
  const bankHref = tenantPagePath('/bank');
  const classLabel = settings.className ?? settings.appTitle ?? '학급 매점';
  const openShare = (target: ShareTarget) => (event: React.MouseEvent<HTMLElement>) => setShareState({ target, opener: event.currentTarget });
  const messageTone = isSuccessNotice(message) ? 'success' : 'warning';

  return (
    <main data-testid="admin-shell" style={rootStyle} className={cx(styles.admin, 'min-h-screen bg-[var(--theme-shell)] text-[15px] text-[var(--theme-text)] antialiased')}>
      {/* The 딴쌤 header (logo back to the class list, the account) sits on top; on wide screens it stays
          in view and the menu column starts under it. */}
      {tenantScoped ? (
        <div inert={overlayOpen ? true : undefined} aria-hidden={overlayOpen ? true : undefined} className="lg:sticky lg:top-0 lg:z-40">
          <GlobalHeader audience="teacher" account={account ?? null} />
        </div>
      ) : null}
      <div data-testid="admin-background" inert={overlayOpen ? true : undefined} aria-hidden={overlayOpen ? true : undefined} className="lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
        <aside className={cx('sticky top-0 z-30 border-b border-[var(--crs-line)] bg-[color-mix(in_srgb,var(--theme-surface)_88%,transparent)] backdrop-blur-md lg:border-b-0 lg:border-r lg:bg-[var(--theme-surface)] lg:backdrop-blur-0',
          tenantScoped ? 'lg:top-[65px] lg:h-[calc(100vh-65px)]' : 'lg:h-screen')}>
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-3 px-4 pb-2 pt-3 sm:px-6 lg:px-5 lg:pb-5 lg:pt-6">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[19px] font-black leading-tight tracking-[-0.03em] lg:text-[20px]" title={classLabel}>{classLabel}</h1>
              </div>
              <div data-tour="header-shortcuts" className="flex items-center gap-1 lg:hidden">
                <a href={storeHref} target="_blank" rel="noopener noreferrer" aria-label="매점 열기 새 탭 열림" className={buttonClass({ variant: 'ghost', size: 'sm' })}><Icon name="store" size={16} /><span className="hidden sm:inline">매점</span></a>
                <a href={bankHref} target="_blank" rel="noopener noreferrer" aria-label="은행 열기 새 탭 열림" className={buttonClass({ variant: 'ghost', size: 'sm' })}><Icon name="bank" size={16} /><span className="hidden sm:inline">은행</span></a>
                <button type="button" aria-label="공유" onClick={openShare('store')} className={buttonClass({ variant: 'ghost', size: 'sm' })}><Icon name="share" size={16} /><span className="hidden sm:inline">공유</span></button>
                <button type="button" aria-label="도움말" onClick={(event) => setTutorialMenu({ opener: event.currentTarget })} className={buttonClass({ variant: 'ghost', size: 'sm' })}><Icon name="help" size={16} /><span className="hidden sm:inline">도움말</span></button>
              </div>
            </div>
            <nav data-testid="admin-tabs" role="tablist" aria-label="관리자 메뉴" aria-orientation="vertical"
              className="flex gap-1 overflow-x-auto px-3 pb-2.5 [scrollbar-width:none] sm:px-5 lg:flex-col lg:overflow-visible lg:px-3 lg:pb-0">
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
                    tabIndex={selected ? 0 : -1}
                    onKeyDown={(event) => handleAdminTabKeyDown(event, tab.id)}
                    onClick={() => selectAdminTab(tab.id)}
                    className={cx('flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-[11px] px-3 py-2 text-sm font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)] lg:py-2.5',
                      selected ? 'bg-[var(--theme-accent-solid)] text-[var(--theme-accent-on-solid)] shadow-[var(--crs-shadow-sm)]' : 'text-[var(--theme-muted-text)] hover:bg-[var(--crs-subtle-hover)] hover:text-[var(--theme-text)]')}
                  >
                    <Icon name={tab.icon} size={18} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </nav>
            <div data-tour="sidebar-shortcuts" className="mt-auto hidden space-y-1 px-3 pb-5 pt-6 lg:block">
              <p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--theme-muted-text)]">바로가기</p>
              <SidebarShortcut href={storeHref} icon="store" label="매점 열기" shareLabel="매점 공유" onShare={openShare('store')} />
              <SidebarShortcut href={bankHref} icon="bank" label="은행 열기" shareLabel="은행 공유" onShare={openShare('bank')} />
              <SidebarButton icon="share" label="관리자 페이지 공유" onClick={openShare('admin')} />
              <SidebarLink href={tenantPagePath('/admin/student-qrs')} icon="qr" label="학생 QR 인쇄" external />
              {migrationsHref ? <SidebarLink href={migrationsHref} icon="migrate" label="자료 가져오기" external /> : null}
              {tenantScoped ? <SidebarLink href="/classes" icon="school" label="메인 화면으로" /> : null}
              {/* Help comes last: where a teacher looks when stuck. */}
              <SidebarButton icon="help" label="도움말" onClick={(event) => setTutorialMenu({ opener: event.currentTarget })} />
            </div>
          </div>
        </aside>

        <div className="min-w-0">
          <header data-testid="admin-header" className="mx-auto w-full max-w-[1200px] px-4 pt-5 sm:px-6 lg:px-10 lg:pt-8">
            {message ? (
              <div role="status" className={cx('flex items-start gap-3 rounded-[var(--crs-radius)] px-4 py-3 text-[13px] font-semibold leading-relaxed [animation:crs-pop-in_.18s_ease-out]',
                messageTone === 'success' ? 'bg-[var(--crs-success-bg)] text-[var(--crs-success-text)]' : 'bg-[var(--crs-warning-bg)] text-[var(--crs-warning-text)]')}>
                <span className="mt-[1px] shrink-0"><Icon name={messageTone === 'success' ? 'check' : 'info'} size={17} /></span>
                <p className="min-w-0 flex-1">{message}</p>
                <button type="button" aria-label="알림 닫기" onClick={() => setMessage('')} className="-mr-1 shrink-0 rounded-md p-0.5 opacity-70 hover:opacity-100"><Icon name="close" size={16} /></button>
              </div>
            ) : null}
          </header>

          <div className="mx-auto w-full max-w-[1200px] px-4 pb-32 pt-5 sm:px-6 lg:px-10 lg:pt-6">

            {activeTab === 'home' ? (
              <section id="admin-panel-home" role="tabpanel" aria-labelledby="admin-tab-home" aria-label="홈" className="space-y-6">
                <PageHeader eyebrow={settings.className ?? settings.appTitle ?? '학급 매점'} title="오늘의 학급" description="학생, 매점, 과제 현황을 한눈에 확인하고 자주 쓰는 작업을 바로 시작하세요." />
                <TutorialHomeCard onFirst={() => setActiveTutorial(tutorialById(FIRST_TUTORIAL_ID))} onOpen={(event) => setTutorialMenu({ opener: event.currentTarget })} />
                <div data-tour="home-stats" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <StatCard label="학생" icon="users" value={`${summary.students}명`} hint={`비활성 ${students.filter((student) => student.status === 'INACTIVE').length}명`} />
                  <StatCard label="학생 잔액 합계" icon="wallet" value={money(totalBalance)} hint={negativeStudents.length ? `음수 잔액 ${negativeStudents.length}명` : '음수 잔액 없음'} />
                  <StatCard label="판매 중인 상품" icon="store" value={`${summary.activeProducts}개`} hint={`전체 재고 ${summary.totalStock.toLocaleString('ko-KR')}개`} />
                  <StatCard label="진행 중인 과제" icon="task" value={homeTaskCounts ? `${homeTaskCounts.active}개` : '-'} hint={homeTaskCounts ? `전체 ${homeTaskCounts.total}개` : '불러오는 중'} />
                </div>
                <div data-tour="home-quick" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <QuickAction icon="coins" title="화폐 지급·회수" description="QR로 학생에게 바로 지급" onClick={() => selectAdminTab('currency')} />
                  <QuickAction icon="qr" title="QR로 과제 부여" description="학생 QR을 찍어 과제 배정" onClick={() => {
                    selectAdminTab('tasks');
                    if (ledgerMode) { taskLedger.open({ kind: 'qr', opener: null }); return; }
                    setQrTaskResult(null); setQrTaskScan(null); setQrTaskPickerOpen(true);
                  }} />
                  <QuickAction icon="store" title="매점 열기" description="학생용 매점 화면" href={storeHref} />
                  <QuickAction icon="bank" title="은행 열기" description="학생용 은행 화면" href={bankHref} />
                </div>
                {students.length === 0 || products.length === 0 || homeTaskCounts?.total === 0 ? (
                  <Card data-tour="home-start">
                    <CardHeader title="학급 시작하기" description="세 가지만 등록하면 학생들이 매점과 은행을 바로 쓸 수 있어요." />
                    <ol className="mt-5 grid gap-3 md:grid-cols-3">
                      {([
                        { done: students.length > 0, icon: 'users', title: '학생 등록', description: '번호와 이름을 등록하면 QR 카드를 인쇄할 수 있어요.', action: '학생 추가', onClick: (event: React.MouseEvent<HTMLButtonElement>) => { selectAdminTab('students'); setStudentSheet({ mode: 'new', opener: event.currentTarget }); } },
                        { done: products.length > 0, icon: 'store', title: '상품 등록', description: '학생이 매점에서 살 수 있는 물건이나 특권이에요.', action: '상품 추가', onClick: (event: React.MouseEvent<HTMLButtonElement>) => { selectAdminTab('products'); setProductSheet({ mode: 'new', opener: event.currentTarget }); } },
                        { done: homeTaskCounts?.total !== 0, icon: 'task', title: '과제 만들기', description: '학생이 은행에서 완료하고 보상을 받는 일이에요.', action: '과제 만들기', onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
                          selectAdminTab('tasks');
                          if (ledgerMode) taskLedger.open({ kind: 'new', opener: event.currentTarget });
                          else openNewTaskSheet(event.currentTarget);
                        } },
                      ] as const).map((step, index) => (
                        <li key={step.title} className={cx('flex flex-col rounded-[var(--crs-radius-lg)] border p-4', step.done ? 'border-transparent bg-[var(--crs-success-bg)]' : 'border-[var(--crs-line)]')}>
                          <div className="flex items-center gap-2.5">
                            <span className={cx('flex h-8 w-8 items-center justify-center rounded-full text-sm font-black', step.done ? 'bg-[var(--crs-success-text)] text-white' : 'bg-[var(--crs-subtle-hover)] text-[var(--theme-muted-text)]')}>
                              {step.done ? <Icon name="check" size={16} strokeWidth={2.6} /> : index + 1}
                            </span>
                            <span className="text-[15px] font-extrabold">{step.title}</span>
                          </div>
                          <p className="mt-2 flex-1 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{step.description}</p>
                          {step.done ? <p className="mt-3 text-[13px] font-bold text-[var(--crs-success-text)]">완료</p> : <Button size="sm" variant="primary" icon="plus" className="mt-3 self-start" onClick={step.onClick}>{step.action}</Button>}
                        </li>
                      ))}
                    </ol>
                  </Card>
                ) : null}
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                  {ledgerMode ? (
                    <TaskLedgerHomeCard ledger={taskLedger} onShowAll={() => selectAdminTab('tasks')}
                      onOpenTask={(taskId) => { selectAdminTab('tasks'); taskLedger.open({ kind: 'task', taskId, tab: 'students', opener: null }); }} />
                  ) : <Card data-tour="home-progress">
                    <CardHeader title="과제 진행 현황" description="이번 회차에 완료한 학생 수예요." actions={<Button size="sm" variant="ghost" iconRight="chevronRight" onClick={() => selectAdminTab('tasks')}>전체 보기</Button>} />
                    <div className="mt-4 divide-y divide-[var(--crs-line)]">
                      {tasks.filter((task) => task.isActive).slice(0, 6).map((task) => {
                        const progress = taskProgress(task);
                        return (
                          <button key={task.taskId} type="button" onClick={(event) => { selectAdminTab('tasks'); openTaskSheet(task, event.currentTarget, 'students'); }}
                            className="flex w-full items-center gap-4 py-3 text-left outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-bold">{task.title}</p>
                              <div className="mt-2"><ProgressBar value={progress.completed ?? 0} max={progress.assigned} label={`${task.title} 진행률`} /></div>
                            </div>
                            <span className="shrink-0 text-[13px] font-bold tabular-nums text-[var(--theme-muted-text)]">{progress.completed ?? '-'} / {progress.assigned}명</span>
                          </button>
                        );
                      })}
                      {tasks.filter((task) => task.isActive).length === 0 ? <p className="py-6 text-center text-[13px] text-[var(--theme-muted-text)]">진행 중인 과제가 없어요.</p> : null}
                    </div>
                  </Card>}
                  <Card data-tour="home-check">
                    <CardHeader title="확인이 필요한 항목" />
                    <div className="mt-4 space-y-2.5">
                      {negativeStudents.length ? (
                        <Callout tone="warning" title={`잔액이 음수인 학생 ${negativeStudents.length}명`}>
                          {negativeStudents.slice(0, 5).map((student) => `${student.name} (${money(student.balance)})`).join(', ')}{negativeStudents.length > 5 ? ' 외' : ''}
                        </Callout>
                      ) : null}
                      {lowStockProducts.length ? (
                        <Callout tone="info" title={`재고가 3개 이하인 상품 ${lowStockProducts.length}개`}>
                          {lowStockProducts.slice(0, 5).map((product) => `${product.name} (${product.stock}개)`).join(', ')}{lowStockProducts.length > 5 ? ' 외' : ''}
                        </Callout>
                      ) : null}
                      {!negativeStudents.length && !lowStockProducts.length ? (
                        <div className="flex items-center gap-3 rounded-[var(--crs-radius)] bg-[var(--crs-success-bg)] px-4 py-3 text-[13px] font-semibold text-[var(--crs-success-text)]"><Icon name="check" size={17} /> 지금은 확인할 항목이 없어요.</div>
                      ) : null}
                    </div>
                  </Card>
                </div>
              </section>
            ) : null}

            {activeTab === 'settings' ? (
              <section id="admin-panel-settings" role="tabpanel" aria-labelledby="admin-tab-settings" aria-label="설정" className="space-y-6">
                <PageHeader title="설정" description="매점과 은행 화면의 이름, 화폐 단위, 테마와 글꼴을 정해요." />
                <SettingsForm
                  linkedStudentCount={students.length}
                  linkedProductCount={products.length}
                  onSettingsSaved={() => loadLinkedSheetData({ silent: true })}
                />
              </section>
            ) : null}

            {activeTab === 'students' ? (
              <section id="admin-panel-students" role="tabpanel" aria-labelledby="admin-tab-students" aria-label="학생" className="space-y-5">
                <PageHeader title="학생" description="학생 명단과 잔액을 관리해요. 학생을 누르면 정보를 고칠 수 있어요."
                  actions={<>
                    <IconButton icon="refresh" label="학생 명단 새로고침" variant="secondary" onClick={refreshStudents} />
                    {tenantScoped ? <StudentBulkImport unit={unit} onImported={() => { void refreshStudents(); }} /> : null}
                    <Button variant="primary" icon="plus" data-tour="student-add" onClick={(event) => { setStudentSheet({ mode: 'new', opener: event.currentTarget }); }}>학생 추가</Button>
                  </>} />
                <Callout tone="warning" title="학생 실명은 학부모 동의를 받은 뒤에 입력해 주세요">
                  <p>
                    만 14세 미만 학생의 이름과 실제 학년, 반, 번호를 쓰려면 법정대리인(학부모)의 개인정보 수집·이용 동의가 필요해요.
                    동의를 받지 않은 학생은 실명이나 실제 번호 대신 별명과 임의 번호로 등록해 주세요.
                  </p>
                  <Button variant="secondary" size="sm" icon="printer" className="mt-2.5" onClick={(event) => setConsentFormOpener(event.currentTarget)}>
                    학부모 동의서 내려받기
                  </Button>
                </Callout>
                <div className="flex flex-wrap items-center gap-3">
                  <SearchInput value={studentQuery} onChange={setStudentQuery} placeholder="이름 또는 번호 검색" ariaLabel="학생 검색" className="w-full sm:w-72" />
                  <SegmentedControl ariaLabel="학생 상태 필터" value={studentFilter} onChange={setStudentFilter}
                    options={[{ value: 'all', label: '전체', count: students.length }, { value: 'ACTIVE', label: '활성', count: students.filter((student) => (student.status ?? 'ACTIVE') === 'ACTIVE').length }, { value: 'INACTIVE', label: '비활성', count: students.filter((student) => student.status === 'INACTIVE').length }]} />
                </div>
                {students.length === 0 ? (
                  <EmptyState icon="users" title="첫 학생을 등록해 보세요" description="학생을 등록하면 QR 카드를 발급하고 화폐를 지급할 수 있어요."
                    action={<Button variant="primary" icon="plus" data-tour="student-add" onClick={(event) => { setStudentSheet({ mode: 'new', opener: event.currentTarget }); }}>학생 추가</Button>} />
                ) : (
                  <Card padded={false} className="overflow-hidden">
                    <div data-testid="student-list" role="table" aria-label="학생 명단" className="divide-y divide-[var(--crs-line)]">
                      <div role="row" data-testid="student-header-row" className="grid grid-cols-[40px_minmax(0,1fr)_auto_28px] items-center gap-3 bg-[var(--crs-subtle)] px-4 py-2.5 text-xs font-bold text-[var(--theme-muted-text)] sm:grid-cols-[40px_72px_minmax(0,1fr)_140px_88px_28px] sm:px-5">
                        <span role="columnheader" className="flex"><Checkbox aria-label="전체 학생 선택" checked={allStudentsSelected} onChange={(event) => setSelectedStudentIds(event.target.checked ? students.map((student) => student.studentId) : [])} /></span>
                        <span role="columnheader" className="hidden sm:block">번호</span>
                        <span role="columnheader">이름</span>
                        <span role="columnheader" className="text-right">잔액</span>
                        <span role="columnheader" className="hidden sm:block">상태</span>
                        <span role="columnheader" aria-hidden="true" />
                      </div>
                      {visibleStudents.map((student) => {
                        const inactive = student.status === 'INACTIVE';
                        return (
                          <div role="row" data-testid="student-row" key={student.studentId}
                            className="group relative grid grid-cols-[40px_minmax(0,1fr)_auto_28px] items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--crs-subtle)] sm:grid-cols-[40px_72px_minmax(0,1fr)_140px_88px_28px] sm:px-5">
                            <span role="cell" className="relative z-10 flex"><Checkbox aria-label={`${student.studentId} 선택`} checked={selectedStudentIds.includes(student.studentId)} onChange={() => toggleStudent(student.studentId)} /></span>
                            <span role="cell" className="hidden truncate text-[13px] font-semibold tabular-nums text-[var(--theme-muted-text)] sm:block">{student.studentId}</span>
                            <span role="cell" className="min-w-0">
                              <button type="button" aria-label={`${student.studentId} ${student.name} 편집`}
                                onClick={(event) => setStudentSheet({ mode: 'edit', id: student.studentId, snapshot: structuredClone(student), opener: event.currentTarget })}
                                className="block max-w-full truncate text-left text-[15px] font-bold outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline">
                                {student.name}
                              </button>
                              <span className="block text-xs text-[var(--theme-muted-text)] sm:hidden">{student.studentId}{inactive ? ', 비활성' : ''}</span>
                            </span>
                            <span role="cell" className={cx('text-right text-[15px] font-extrabold tabular-nums', student.balance < 0 && 'text-[var(--crs-danger-text)]')}>{money(student.balance)}</span>
                            <span role="cell" className="hidden sm:block">{inactive ? <Badge>비활성</Badge> : <Badge tone="success" dot>활성</Badge>}</span>
                            <span role="cell" aria-hidden="true" className="text-[var(--theme-muted-text)] opacity-0 transition-opacity group-hover:opacity-100"><Icon name="chevronRight" size={18} /></span>
                          </div>
                        );
                      })}
                      {visibleStudents.length === 0 ? <p className="px-5 py-10 text-center text-[13px] text-[var(--theme-muted-text)]">검색 결과가 없어요.</p> : null}
                    </div>
                  </Card>
                )}
                <SelectionBar count={selectedStudentIds.length} label="명 선택됨" onClear={() => setSelectedStudentIds([])}>
                  <SelectionBarButton icon="coins" data-tour="student-bulk-balance" onClick={() => setBulkBalanceOpen(true)}>잔액 변경</SelectionBarButton>
                  <SelectionBarButton icon="qr" data-tour="student-qr-bulk" onClick={() => setQrPrintStudents(students.filter((student) => selectedStudentIds.includes(student.studentId)))}>QR 카드 발급</SelectionBarButton>
                  {tenantScoped ? <SelectionBarButton icon="package" data-tour="student-bulk-give" onClick={(event) => setBulkGiveOpener(event.currentTarget)}>보관함에 넣기</SelectionBarButton> : null}
                  <SelectionBarButton icon="trash" danger data-tour="student-bulk-delete" onClick={() => confirmDelete(`학생 ${selectedStudentIds.length}명을 삭제할까요?`, '삭제한 학생은 명단에서 사라져요. 거래 기록은 그대로 남아요.', deleteSelectedStudents)}>삭제</SelectionBarButton>
                </SelectionBar>
              </section>
            ) : null}

            {activeTab === 'products' ? (
              <section id="admin-panel-products" role="tabpanel" aria-labelledby="admin-tab-products" aria-label="매점" className="space-y-5">
                <PageHeader title="매점" description="학생이 매점에서 살 수 있는 상품과 할인 행사를 관리해요."
                  actions={storeTab === 'inventory' ? <>
                    <IconButton icon="refresh" label="상품 · 재고 관리 새로고침" variant="secondary" onClick={refreshProducts} />
                    {tenantScoped ? <ProductBulkImport unit={unit} onImported={() => { void refreshProducts(); }} /> : null}
                    <Button variant="primary" icon="plus" data-tour="product-add" onClick={(event) => { setNewProduct((current) => current === EMPTY_PRODUCT ? { ...current, sortOrder: products.length + 1 } : current); setProductSheet({ mode: 'new', opener: event.currentTarget }); }}>상품 추가</Button>
                  </> : null} />
                <div role="tablist" aria-label="매점 관리 메뉴" className="inline-flex gap-0.5 rounded-[12px] bg-[var(--crs-subtle-hover)] p-1">
                  {storeTabs.map((tab) => (
                    <button key={tab} ref={(node) => { storeTabRefs.current[tab] = node; }} id={`admin-store-tab-${tab}`} type="button" role="tab" aria-controls={`admin-store-panel-${tab}`}
                      aria-selected={storeTab === tab} tabIndex={storeTab === tab ? 0 : -1} onKeyDown={(event) => handleStoreTabKeyDown(event, tab)} onClick={() => selectStoreTab(tab)}
                      className={cx('h-9 rounded-[9px] px-4 text-sm font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]',
                        storeTab === tab ? 'bg-[var(--theme-surface)] text-[var(--theme-text)] shadow-[var(--crs-shadow-sm)]' : 'text-[var(--theme-muted-text)] hover:text-[var(--theme-text)]')}>
                      {tab === 'inventory' ? '상품·재고' : '행사 관리'}
                    </button>
                  ))}
                </div>
                <div id="admin-store-panel-inventory" role="tabpanel" aria-labelledby="admin-store-tab-inventory" hidden={storeTab !== 'inventory'} className="space-y-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <SearchInput value={productQuery} onChange={setProductQuery} placeholder="상품 이름 또는 분류 검색" ariaLabel="상품 검색" className="w-full sm:w-72" />
                    <SegmentedControl ariaLabel="상품 판매 상태 필터" value={productFilter} onChange={setProductFilter}
                      options={[{ value: 'all', label: '전체', count: products.length }, { value: 'active', label: '판매 중', count: products.filter((product) => product.isActive).length }, { value: 'inactive', label: '판매 중지', count: products.filter((product) => !product.isActive).length }]} />
                  </div>
                  {products.length === 0 ? (
                    <EmptyState icon="store" title="첫 상품을 등록해 보세요" description="상품을 등록하면 학생들이 매점 화면에서 바로 살 수 있어요."
                      action={<Button variant="primary" icon="plus" data-tour="product-add" onClick={(event) => { setNewProduct((current) => current === EMPTY_PRODUCT ? { ...current, sortOrder: products.length + 1 } : current); setProductSheet({ mode: 'new', opener: event.currentTarget }); }}>상품 추가</Button>} />
                  ) : (
                    <Card padded={false} className="overflow-hidden">
                      <div data-testid="product-list" role="table" aria-label="상품 목록" className="divide-y divide-[var(--crs-line)]">
                        <div role="row" data-testid="product-header-row" className="grid grid-cols-[40px_minmax(0,1fr)_auto_28px] items-center gap-3 bg-[var(--crs-subtle)] px-4 py-2.5 text-xs font-bold text-[var(--theme-muted-text)] sm:grid-cols-[40px_minmax(0,1fr)_110px_80px_96px_28px] sm:px-5">
                          <span role="columnheader" className="flex"><Checkbox aria-label="전체 상품 선택" checked={allProductsSelected} onChange={(event) => setSelectedProductIds(event.target.checked ? products.map((product) => product.productId) : [])} /></span>
                          <span role="columnheader">상품</span>
                          <span role="columnheader" className="text-right">가격</span>
                          <span role="columnheader" className="hidden text-right sm:block">재고</span>
                          <span role="columnheader" className="hidden sm:block">상태</span>
                          <span role="columnheader" aria-hidden="true" />
                        </div>
                        {visibleProducts.map((product) => (
                          <div role="row" data-testid="product-row" key={product.productId}
                            className="group relative grid grid-cols-[40px_minmax(0,1fr)_auto_28px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--crs-subtle)] sm:grid-cols-[40px_minmax(0,1fr)_110px_80px_96px_28px] sm:px-5">
                            <span role="cell" className="relative z-10 flex"><Checkbox aria-label={`${product.productId} 선택`} checked={selectedProductIds.includes(product.productId)} onChange={() => toggleProduct(product.productId)} /></span>
                            <span role="cell" className="flex min-w-0 items-center gap-3">
                              <ProductThumb name={product.name} imageUrl={product.imageUrl} />
                              <span className="min-w-0">
                                <button type="button" aria-label={`${product.productId} ${product.name} 편집`}
                                  onClick={(event) => setProductSheet({ mode: 'edit', id: product.productId, snapshot: structuredClone(product), opener: event.currentTarget })}
                                  className="block max-w-full truncate text-left text-[15px] font-bold outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline">
                                  {product.name}
                                </button>
                                <span className="block truncate text-xs text-[var(--theme-muted-text)]">{product.category || '분류 없음'}{digitalLabel(product.productId)}<span className="sm:hidden">, 재고 {product.stock}개</span></span>
                              </span>
                            </span>
                            <span role="cell" className="text-right text-[15px] font-extrabold tabular-nums">{money(product.price)}</span>
                            <span role="cell" className={cx('hidden text-right text-sm font-semibold tabular-nums sm:block', product.stock <= 3 && 'text-[var(--crs-warning-text)]')}>{product.stock}개</span>
                            <span role="cell" className="hidden sm:block">{product.isActive ? <Badge tone="success" dot>판매 중</Badge> : <Badge>판매 중지</Badge>}</span>
                            <span role="cell" aria-hidden="true" className="text-[var(--theme-muted-text)] opacity-0 transition-opacity group-hover:opacity-100"><Icon name="chevronRight" size={18} /></span>
                          </div>
                        ))}
                        {visibleProducts.length === 0 ? <p className="px-5 py-10 text-center text-[13px] text-[var(--theme-muted-text)]">검색 결과가 없어요.</p> : null}
                      </div>
                    </Card>
                  )}
                  <SelectionBar count={storeTab === 'inventory' ? selectedProductIds.length : 0} onClear={() => setSelectedProductIds([])}>
                    <SelectionBarButton icon="trash" danger data-tour="product-bulk-delete" onClick={() => confirmDelete(`상품 ${selectedProductIds.length}개를 삭제할까요?`, '삭제한 상품은 매점에서 바로 사라져요. 지난 거래 기록은 그대로 남아요.', deleteSelectedProducts)}>삭제</SelectionBarButton>
                  </SelectionBar>
                </div>
                <section id="admin-store-panel-promotions" role="tabpanel" aria-labelledby="admin-store-tab-promotions" hidden={storeTab !== 'promotions'}>
                  {hasOpenedPromotions ? (
                    <PromotionAdminPanel
                      products={products}
                      currencyUnit={unit}
                      timeZone="Asia/Seoul"
                      themeColor={themeColor}
                    />
                  ) : null}
                </section>
              </section>
            ) : null}

            {activeTab === 'tasks' && ledgerMode ? <TaskLedgerPanel ledger={taskLedger} unit={unit} notify={notify} /> : null}
            {activeTab === 'tasks' && !ledgerMode ? (
              <section id="admin-panel-tasks" data-testid="task-panel" role="tabpanel" aria-labelledby="admin-tab-tasks" aria-label="과제" className="space-y-5">
                <PageHeader title="과제" description="학생이 은행에서 완료하고 보상을 받는 과제예요. 과제를 누르면 내용, 반복, 학생별 현황을 관리할 수 있어요."
                  actions={<>
                    <IconButton icon="refresh" label="과제 설정 새로고침" variant="secondary" onClick={refreshTasks} />
                    <Button icon="qr" onClick={() => { setQrTaskResult(null); setQrTaskScan(null); setQrTaskPickerOpen(true); }}>QR로 부여</Button>
                    <Button variant="primary" icon="plus" data-tour="task-new" onClick={(event) => openNewTaskSheet(event.currentTarget)}>새 과제</Button>
                  </>} />
                <div className="flex flex-wrap items-center gap-3">
                  <SearchInput value={taskQuery} onChange={setTaskQuery} placeholder="과제 검색" ariaLabel="과제 검색" className="w-full sm:w-72" />
                  <SegmentedControl ariaLabel="과제 공개 상태 필터" value={taskFilter} onChange={setTaskFilter}
                    options={[{ value: 'all', label: '전체', count: tasks.length }, { value: 'active', label: '공개', count: tasks.filter((task) => task.isActive).length }, { value: 'hidden', label: '숨김', count: tasks.filter((task) => !task.isActive).length }]} />
                </div>
                {tasks.length === 0 ? (
                  <EmptyState icon="task" title="첫 과제를 만들어 보세요" description="숙제, 청소 당번처럼 학생이 하고 보상을 받을 일을 과제로 등록해요."
                    action={<Button variant="primary" icon="plus" onClick={(event) => openNewTaskSheet(event.currentTarget)}>새 과제</Button>} />
                ) : (
                  <Card padded={false} className="overflow-hidden" data-testid="task-list-card">
                    <div data-testid="task-list-scroll" role="table" aria-label="과제 목록" className="divide-y divide-[var(--crs-line)]">
                      <div role="row" data-testid="task-header-row" className="grid grid-cols-[40px_minmax(0,1fr)_28px] items-center gap-3 bg-[var(--crs-subtle)] px-4 py-2.5 text-xs font-bold text-[var(--theme-muted-text)] md:grid-cols-[40px_minmax(0,1fr)_96px_150px_84px_28px] md:px-5">
                        <span role="columnheader" className="flex"><Checkbox aria-label="전체 과제 선택" checked={allTasksSelected} onChange={(event) => setSelectedTaskIds(event.target.checked ? tasks.map((task) => task.taskId) : [])} /></span>
                        <span role="columnheader">과제</span>
                        <span role="columnheader" className="hidden text-right md:block">보상</span>
                        <span role="columnheader" className="hidden md:block">이번 회차 완료</span>
                        <span role="columnheader" className="hidden md:block">상태</span>
                        <span role="columnheader" aria-hidden="true" />
                      </div>
                      {visibleTasks.map((task) => {
                        const progress = taskProgress(task);
                        const status = taskStatus(task);
                        const meta = taskMeta(task);
                        return (
                          <div role="row" data-testid="task-row" key={task.taskId}
                            className="group relative grid grid-cols-[40px_minmax(0,1fr)_28px] items-center gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--crs-subtle)] md:grid-cols-[40px_minmax(0,1fr)_96px_150px_84px_28px] md:px-5">
                            <span role="cell" className="relative z-10 flex"><Checkbox aria-label={`${task.taskId} 선택`} checked={selectedTaskIds.includes(task.taskId)} onChange={() => toggleTask(task.taskId)} /></span>
                            <span role="cell" className="min-w-0">
                              <button type="button" aria-label={`${task.title || task.taskId} 과제 편집`} onClick={(event) => openTaskSheet(task, event.currentTarget)}
                                className="block max-w-full truncate text-left text-[15px] font-bold outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline">
                                {task.title || '(이름 없음)'}
                              </button>
                              <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--theme-muted-text)]">
                                <span className="md:hidden">{money(task.reward)}</span>
                                {meta.map((item) => <span key={item.text} className="inline-flex items-center gap-1"><Icon name={item.icon} size={13} />{item.text}</span>)}
                                <span className="inline-flex items-center gap-1"><Icon name="users" size={13} />{progress.assigned}명 부여
                                  {progress.pending !== null && progress.ready !== null && progress.assigned > 0
                                    ? <span className="text-[var(--theme-muted-text)]">(미완료 {progress.pending}, 완료 가능 {progress.ready})</span> : null}</span>
                                <span className="md:hidden"><Badge tone={status.tone}>{status.label}</Badge></span>
                              </span>
                            </span>
                            <span role="cell" className="hidden text-right text-[15px] font-extrabold tabular-nums md:block">{money(task.reward)}</span>
                            <span role="cell" className="hidden md:block">
                              {progress.completed === null ? <span className="text-xs text-[var(--theme-muted-text)]">-</span> : (
                                <>
                                  <ProgressBar value={progress.completed} max={progress.assigned} label={`${task.title} 완료율`} />
                                  <span className="mt-1.5 block text-xs font-semibold tabular-nums text-[var(--theme-muted-text)]">{progress.completed} / {progress.assigned}명</span>
                                </>
                              )}
                            </span>
                            <span role="cell" className="hidden md:block"><Badge tone={status.tone} dot>{status.label}</Badge></span>
                            <span role="cell" aria-hidden="true" className="text-[var(--theme-muted-text)] opacity-0 transition-opacity group-hover:opacity-100"><Icon name="chevronRight" size={18} /></span>
                          </div>
                        );
                      })}
                      {visibleTasks.length === 0 ? <p className="px-5 py-10 text-center text-[13px] text-[var(--theme-muted-text)]">검색 결과가 없어요.</p> : null}
                    </div>
                  </Card>
                )}
                <SelectionBar count={selectedTaskIds.length} onClear={() => setSelectedTaskIds([])}>
                  <SelectionBarButton icon="repeat" aria-label="선택 과제 반복 설정" onClick={(event) => openBulkTaskScheduleEditor(event.currentTarget)}>반복 설정</SelectionBarButton>
                  <SelectionBarButton icon="users" aria-label="선택 과제 학생 부여" onClick={(event) => openBulkTaskAssignmentEditor(event.currentTarget)}>학생 부여</SelectionBarButton>
                  <SelectionBarButton icon="trash" danger onClick={() => confirmDelete(`과제 ${selectedTaskIds.length}개를 삭제할까요?`, '삭제한 과제는 학생 은행 화면에서 사라져요. 이미 지급한 보상은 그대로 남아요.', deleteSelectedTasks)}>삭제</SelectionBarButton>
                </SelectionBar>
              </section>
            ) : null}

            {activeTab === 'tree' ? (
              <section id="admin-panel-tree" role="tabpanel" aria-labelledby="admin-tab-tree" aria-label="나무 키우기">
                <ClassTreePanel unit={unit} notify={notify} />
              </section>
            ) : null}

            {activeTab === 'pets' ? (
              <section id="admin-panel-pets" role="tabpanel" aria-labelledby="admin-tab-pets" aria-label="펫 키우기">
                <PetPanel unit={unit} notify={notify} />
              </section>
            ) : null}

            <section id="admin-panel-transactions" role="tabpanel" aria-labelledby="admin-tab-transactions" aria-label="거래 내역" hidden={activeTab !== 'transactions'} className="space-y-6">
              {hasOpenedTransactions ? (
                <>
                  <PageHeader title="거래 내역" description="매점 결제, 과제 보상, 지급·회수 기록을 확인하고 필요하면 결제를 취소해요." />
                  <TransactionsPanel embedded />
                </>
              ) : null}
            </section>

            {activeTab === 'currency' ? (
              <section id="admin-panel-currency" role="tabpanel" aria-labelledby="admin-tab-currency" aria-label="지급·회수" className="space-y-6">
                <PageHeader title="화폐 지급·회수" description="금액을 정한 뒤 학생 QR을 찍으면 바로 지급하거나 회수해요." />
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
                  <Card className="space-y-6">
                    <div data-tour="currency-mode">
                      <p className="mb-2 text-[13px] font-bold">무엇을 할까요?</p>
                      <div role="group" aria-label="지급 또는 회수" className="grid grid-cols-2 gap-2">
                        {(['add', 'subtract'] as const).map((mode) => {
                          const selected = currencyMode === mode;
                          return (
                            <button key={mode} type="button" aria-pressed={selected} onClick={() => setCurrencyMode(mode)}
                              className={cx('flex h-[72px] items-center justify-center gap-2.5 rounded-[16px] text-lg font-black transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)] focus-visible:ring-offset-2',
                                selected
                                  ? mode === 'add' ? 'bg-[var(--theme-accent-solid)] text-[var(--theme-accent-on-solid)] shadow-[var(--crs-shadow)]' : 'bg-[var(--crs-danger-solid)] text-white shadow-[var(--crs-shadow)]'
                                  : 'border border-[var(--crs-line-strong)] text-[var(--theme-muted-text)] hover:bg-[var(--crs-subtle-hover)]')}>
                              <Icon name={mode === 'add' ? 'plus' : 'minus'} size={20} strokeWidth={2.4} />{mode === 'add' ? '지급' : '회수'}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <Field label="금액" htmlFor="currency-amount">
                      <Input id="currency-amount" aria-label="지급/회수 금액" value={currencyAmount} onChange={(event) => setCurrencyAmount(Number(event.target.value))} type="number" min="0" inputMode="numeric" suffix={unit}
                        className="h-16 text-3xl font-black tabular-nums" />
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {[10, 50, 100, 500, 1000].map((step) => (
                          <button key={step} type="button" onClick={() => setCurrencyAmount((current) => Math.max(0, (Number.isFinite(current) ? current : 0) + step))}
                            className="h-8 rounded-full border border-[var(--crs-line-strong)] px-3 text-[13px] font-bold tabular-nums hover:bg-[var(--crs-subtle-hover)]">+{step.toLocaleString('ko-KR')}</button>
                        ))}
                        <button type="button" onClick={() => setCurrencyAmount(0)} className="h-8 rounded-full px-3 text-[13px] font-bold text-[var(--theme-muted-text)] hover:bg-[var(--crs-subtle-hover)]">초기화</button>
                      </div>
                    </Field>
                    <Button variant={currencyMode === 'add' ? 'primary' : 'danger'} size="lg" block icon="qr" data-tour="currency-start" disabled={!(currencyAmount > 0)}
                      onClick={() => { setCurrencyResult(null); setCurrencyManualId(''); setCurrencyScannerOpen(true); }}>
                      QR 인식 시작
                    </Button>
                  </Card>
                  <Card>
                    <CardHeader title="알아 두세요" titleAs="h3" />
                    <ul className="mt-3 space-y-3 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">
                      <li className="flex gap-2.5"><Icon name="qr" size={16} className="mt-0.5 shrink-0" />학생 QR을 찍을 때마다 같은 금액이 한 번씩 처리돼요.</li>
                      <li className="flex gap-2.5"><Icon name="alert" size={16} className="mt-0.5 shrink-0" />회수할 금액이 잔액보다 크면 잔액이 음수가 돼요. 예: 잔액 10에서 15를 회수하면 -5</li>
                      <li className="flex gap-2.5"><Icon name="receipt" size={16} className="mt-0.5 shrink-0" />모든 지급과 회수는 거래 내역에 기록돼요.</li>
                    </ul>
                  </Card>
                </div>
              </section>
            ) : null}
            {tabs.filter((tab) => tab.id !== activeTab && tab.id !== 'transactions').map((tab) => (
              <section key={`inactive-${tab.id}`} id={`admin-panel-${tab.id}`} role="tabpanel" aria-labelledby={`admin-tab-${tab.id}`} hidden />
            ))}
          </div>
        </div>
      </div>

      {ledgerMode ? (
        <TaskLedgerOverlays ledger={taskLedger} students={students} unit={unit} notify={notify} qrManualInputEnabled={Boolean(settings.qrManualInputEnabled)} />
      ) : null}

      {/* ---------------- task editor panel ---------------- */}
      {taskSheet ? (
        <Sheet
          title={taskSheet.mode === 'new' ? '새 과제' : sheetTask?.title || '과제'}
          eyebrow={taskSheet.mode === 'new' ? '과제 만들기' : `과제 편집 ${taskSheet.taskId}`}
          ariaLabel={taskSheet.mode === 'new' ? '새 과제' : `${sheetTask?.title || taskSheet.taskId} 과제 편집`}
          opener={taskSheet.opener}
          onClose={() => closeTaskSheet()}
          obscured={nestedOverTaskSheet}
          headerActions={taskSheet.mode === 'edit' && sheetTask ? (
            <IconButton icon="history" label={`${sheetTask.taskId} 기록 보기`} onClick={(event) => void openTaskHistory(sheetTask, event.currentTarget)} />
          ) : null}
          toolbar={(
            <div role="tablist" aria-label="과제 편집 메뉴" className="flex gap-0.5 rounded-[12px] bg-[var(--crs-subtle-hover)] p-1">
              {([['basic', '기본 정보', taskBasicDirty], ['schedule', '반복', taskScheduleDirty], ['students', taskSheet.mode === 'new' ? '대상 학생' : '학생 현황', taskAssignmentDirty]] as const).map(([tab, label, dirty]) => (
                <button key={tab} type="button" role="tab" aria-selected={taskSheet.tab === tab} onClick={() => switchTaskSheetTab(tab)}
                  className={cx('relative h-9 flex-1 rounded-[9px] text-[13px] font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]',
                    taskSheet.tab === tab ? 'bg-[var(--theme-surface)] text-[var(--theme-text)] shadow-[var(--crs-shadow-sm)]' : 'text-[var(--theme-muted-text)] hover:text-[var(--theme-text)]')}>
                  {label}{dirty ? <span aria-label="저장 안 됨" className="ml-1.5 inline-block h-1.5 w-1.5 -translate-y-0.5 rounded-full bg-[var(--crs-warning-text)]" /> : null}
                </button>
              ))}
            </div>
          )}
          footer={taskSheet.mode === 'new' ? (
            <>
              <Button variant="ghost" onClick={() => closeTaskSheet()}>취소</Button>
              <div className="ml-auto" />
              <Button variant="primary" icon="check" onClick={() => void submitNewTask()}>과제 만들기</Button>
            </>
          ) : taskSheet.tab === 'basic' && sheetTask ? (
            <>
              <Button variant="dangerGhost" icon="trash" aria-label={`${sheetTask.taskId} 과제 삭제`} onClick={(event) => requestTaskDelete(sheetTask, event.currentTarget)}>삭제</Button>
              <div className="ml-auto" />
              <Button variant="ghost" disabled={!taskBasicDirty} onClick={revertTaskBasic}>되돌리기</Button>
              <Button variant="primary" icon="check" disabled={!taskBasicDirty} onClick={() => void saveTaskSheetBasic()}>저장</Button>
            </>
          ) : taskSheet.tab === 'schedule' && sheetScheduleEditor ? (
            <>
              <div className="ml-auto" />
              <Button variant="primary" icon="check" disabled={isSavingTaskSchedule || !taskScheduleDirty || !scheduleFormToPayload(sheetScheduleEditor.form).ok}
                onClick={() => void saveTaskSheetSchedule()}>반복 설정 저장</Button>
            </>
          ) : taskSheet.tab === 'students' && sheetAssignmentEditor ? (
            <>
              <Button variant="ghost" icon="restore" disabled={isSavingChanges} onClick={(event) => requestTaskCompletionReset(sheetAssignmentEditor.target, event.currentTarget)}>완료 기록 초기화</Button>
              <div className="ml-auto" />
              <Button variant="primary" icon="check" disabled={Boolean(sheetAssignmentEditor.isLoading) || isSavingChanges} onClick={saveTaskAssignment}>저장</Button>
            </>
          ) : null}
        >
          {taskSheet.tab === 'basic' ? (
            taskSheet.mode === 'new' ? (
              <TaskBasicFields
                values={newTask}
                tasks={tasks}
                selfTaskId={null}
                unit={unit}
                onChange={(patch) => setNewTask((current) => ({ ...current, ...patch }))}
              />
            ) : sheetTask ? (
              <TaskBasicFields
                values={sheetTask}
                tasks={tasks}
                selfTaskId={sheetTask.taskId}
                unit={unit}
                onChange={(patch) => updateTask(sheetTask.taskId, patch)}
              />
            ) : null
          ) : null}

          {taskSheet.tab === 'schedule' ? (
            taskSheet.mode === 'new' ? (
              <TaskRecurrenceFields form={newTaskRecurrence} onChange={updateNewTaskRecurrence} />
            ) : sheetScheduleEditor && sheetTask ? (
              <div className="space-y-6">
                <TaskScheduleProjection task={sheetTask} />
                <TaskRecurrenceFields form={sheetScheduleEditor.form}
                  onChange={(form) => setTaskScheduleEditor((current) => current ? { ...current, form, explicit: true } : current)} />
                <p className="text-xs leading-relaxed text-[var(--theme-muted-text)]">반복 규칙을 바꾸면 바로 적용돼요. 지금 회차의 완료 상태는 보상 없이 새 규칙으로 이어지고, 기록 지우기는 다음 회차부터 적용돼요.</p>
              </div>
            ) : taskScheduleEditor && taskSheet.mode === 'edit' ? (
              <Callout tone="warning" title="다른 반복 설정 창이 열려 있어요">먼저 열린 반복 설정을 저장하거나 닫아 주세요.</Callout>
            ) : <SheetLoading label="반복 설정 불러오는 중" />
          ) : null}

          {taskSheet.tab === 'students' ? (
            taskSheet.mode === 'new' ? (
              <NewTaskStudentPicker students={sortStudentsById(students)} selectedIds={newTask.allowedStudentIds ?? []}
                onChange={(ids) => setNewTask((current) => ({ ...current, allowedStudentIds: ids }))} />
            ) : sheetAssignmentEditor && sheetTask ? (
              <TaskAssignmentBoard
                editor={sheetAssignmentEditor}
                task={sheetTask}
                students={sortStudentsById(students)}
                filter={assignmentFilter}
                onFilterChange={setAssignmentFilter}
                onToggleRow={toggleTaskAssignmentStudent}
                onSelectRows={(ids) => setTaskAssignmentEditor((current) => current ? { ...current, selectedIds: ids } : current)}
                onToggleAssigned={toggleTaskAssignmentAssigned}
                onToggleCompleted={toggleTaskAssignmentCompleted}
                onBulkAssigned={setSelectedTaskAssignmentAssigned}
                onBulkCompleted={setSelectedTaskAssignmentCompletion}
              />
            ) : taskAssignmentEditor && taskSheet.mode === 'edit' ? (
              <Callout tone="warning" title="다른 과제의 부여 창이 열려 있어요">먼저 열린 부여 창을 저장하거나 닫아 주세요.</Callout>
            ) : (
              <div className="space-y-3">
                <SheetLoading label="학생 현황 불러오는 중" />
                {sheetTask ? <Button size="sm" variant="ghost" icon="refresh" onClick={() => openTaskAssignmentEditor(sheetTask.taskId, sheetTask.allowedStudentIds ?? [], null)}>다시 불러오기</Button> : null}
              </div>
            )
          ) : null}
        </Sheet>
      ) : null}

      {/* ---------------- student editor panel ---------------- */}
      {studentSheet ? (
        <Sheet
          title={studentSheet.mode === 'new' ? '학생 추가' : sheetStudent?.name || '학생'}
          eyebrow={studentSheet.mode === 'new' ? '새 학생' : `학생 편집 ${studentSheet.id}`}
          ariaLabel={studentSheet.mode === 'new' ? '학생 추가' : `${studentSheet.id} 학생 편집`}
          opener={studentSheet.opener}
          width="max-w-[460px]"
          onClose={() => closeStudentSheet()}
          obscured={Boolean(confirmState || isSavingChanges)}
          footer={studentSheet.mode === 'new' ? (
            <>
              <Button variant="ghost" onClick={() => closeStudentSheet()}>취소</Button>
              <div className="ml-auto" />
              <Button variant="primary" icon="check" type="submit" form="student-sheet-form" data-tour="student-create">새 학생 추가</Button>
            </>
          ) : sheetStudent ? (
            <>
              <Button variant="dangerGhost" icon="trash" aria-label={`${sheetStudent.studentId} 학생 삭제`}
                onClick={() => confirmDelete(`${sheetStudent.name} 학생을 삭제할까요?`, '삭제한 학생은 명단에서 사라져요. 거래 기록은 그대로 남아요.', async () => { await deleteStudentRow(sheetStudent.studentId); setStudentSheet(null); })}>삭제</Button>
              <div className="ml-auto" />
              <Button variant="ghost" onClick={() => closeStudentSheet()}>취소</Button>
              <Button variant="primary" icon="check" data-tour="student-save" disabled={!studentDirty} onClick={async () => { if (await saveStudentRows([sheetStudent], '학생')) setStudentSheet(null); }}>저장</Button>
            </>
          ) : null}
        >
          {studentSheet.mode === 'new' ? (
            <form id="student-sheet-form" onSubmit={async (event) => { event.preventDefault(); if (await createNewStudent()) setStudentSheet(null); }} className="space-y-5">
              <Field label="번호" htmlFor="new-student-id" hint="학생을 구분하는 고유 번호예요. 예: 01, S001">
                <Input id="new-student-id" aria-label="새 학생 ID" data-autofocus required value={newStudent.studentId} onChange={(event) => setNewStudent((current) => ({ ...current, studentId: event.target.value }))} />
              </Field>
              <Field label="이름" htmlFor="new-student-name">
                <Input id="new-student-name" aria-label="새 학생 이름" required value={newStudent.name} onChange={(event) => setNewStudent((current) => ({ ...current, name: event.target.value }))} />
              </Field>
              <Field label="처음 잔액" htmlFor="new-student-balance" hint="음수로도 시작할 수 있어요.">
                <Input id="new-student-balance" aria-label="새 학생 잔액" type="number" inputMode="numeric" suffix={unit} value={Number.isFinite(newStudent.balance) ? newStudent.balance : 0} onChange={(event) => setNewStudent((current) => ({ ...current, balance: Number(event.target.value) }))} />
              </Field>
            </form>
          ) : sheetStudent ? (
            <div className="space-y-5">
              <div className="flex items-center gap-4 rounded-[var(--crs-radius-lg)] bg-[var(--crs-subtle)] px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-[var(--theme-muted-text)]">현재 잔액</p>
                  <p className={cx('mt-0.5 text-[26px] font-black tabular-nums tracking-[-0.03em]', studentSheet.snapshot.balance < 0 && 'text-[var(--crs-danger-text)]')}>{money(studentSheet.snapshot.balance)}</p>
                </div>
                <Button size="sm" icon="qr" data-tour="student-qr" onClick={() => setQrPrintStudents([sheetStudent])}>QR 카드</Button>
              </div>
              <Field label="이름" htmlFor="student-sheet-name">
                <Input id="student-sheet-name" aria-label={`${sheetStudent.studentId} 이름`} value={sheetStudent.name} onChange={(event) => updateStudent(sheetStudent.studentId, { name: event.target.value })} />
              </Field>
              <Field label="잔액" htmlFor="student-sheet-balance" hint="직접 고치면 거래 내역 없이 잔액이 바뀌어요. 보상이나 벌금은 지급·회수 메뉴를 쓰세요.">
                <Input id="student-sheet-balance" aria-label={`${sheetStudent.studentId} 잔액`} type="number" inputMode="numeric" suffix={unit} value={Number.isFinite(sheetStudent.balance) ? sheetStudent.balance : 0} onChange={(event) => updateStudent(sheetStudent.studentId, { balance: Number(event.target.value) })} />
              </Field>
              <Switch checked={(sheetStudent.status ?? 'ACTIVE') === 'ACTIVE'} ariaLabel={`${sheetStudent.studentId} 활성`}
                onChange={(checked) => updateStudent(sheetStudent.studentId, { status: checked ? 'ACTIVE' : 'INACTIVE' })}
                label="활성 학생" description="끄면 이 학생은 매점과 은행을 쓸 수 없어요. 전학 간 학생 등에 쓰세요." />
              {tenantScoped ? (
                <StudentStorageSection key={sheetStudent.studentId} studentId={sheetStudent.studentId} name={sheetStudent.name} notify={notify}
                  giveOptions={giveOptions} />
              ) : null}
            </div>
          ) : null}
        </Sheet>
      ) : null}

      {/* ---------------- product editor panel ---------------- */}
      {productSheet ? (
        <Sheet
          title={productSheet.mode === 'new' ? '상품 추가' : sheetProduct?.name || '상품'}
          eyebrow={productSheet.mode === 'new' ? '새 상품' : `상품 편집 ${productSheet.id}`}
          ariaLabel={productSheet.mode === 'new' ? '상품 추가' : `${productSheet.id} 상품 편집`}
          opener={productSheet.opener}
          width="max-w-[480px]"
          onClose={() => closeProductSheet()}
          obscured={Boolean(productDeleteConfirmation || confirmState || isSavingChanges)}
          footer={productSheet.mode === 'new' ? (
            <>
              <Button variant="ghost" onClick={() => closeProductSheet()}>취소</Button>
              <div className="ml-auto" />
              <Button variant="primary" icon="check" type="submit" form="product-sheet-form" data-tour="product-create">새 상품 추가</Button>
            </>
          ) : sheetProduct ? (
            <>
              <Button variant="dangerGhost" icon="trash" aria-label={`${sheetProduct.productId} 상품 삭제`} onClick={(event) => requestProductDelete(sheetProduct, event.currentTarget)}>삭제</Button>
              <div className="ml-auto" />
              <Button variant="ghost" onClick={() => closeProductSheet()}>취소</Button>
              <Button variant="primary" icon="check" data-tour="product-save" disabled={!productDirty} onClick={() => void saveProductSheet(sheetProduct)}>저장</Button>
            </>
          ) : null}
        >
          {productSheet.mode === 'new' ? (
            <form id="product-sheet-form" onSubmit={async (event) => { event.preventDefault(); if (await createNewProduct()) setProductSheet(null); }}>
              <ProductFields
                idPrefix="new-product"
                labelPrefix="새 상품"
                values={newProduct}
                categories={productCategories}
                unit={unit}
                onChange={(patch) => setNewProduct((current) => ({ ...current, ...patch }))}
                digital={tenantScoped ? (
                  <DigitalProductFields idPrefix="new-product" ariaPrefix="새 상품" value={newProductDigital}
                    onChange={(patch) => setNewProductDigital((current) => ({ ...current, ...patch }))} />
                ) : undefined}
              />
            </form>
          ) : sheetProduct ? (
            <ProductFields
              idPrefix="product-sheet"
              labelPrefix={sheetProduct.productId}
              values={{ name: sheetProduct.name, price: sheetProduct.price, stock: sheetProduct.stock, isActive: sheetProduct.isActive, imageUrl: sheetProduct.imageUrl ?? '', category: sheetProduct.category ?? '', sortOrder: sheetProduct.sortOrder }}
              categories={productCategories}
              unit={unit}
              onChange={(patch) => updateProduct(sheetProduct.productId, patch)}
              digital={tenantScoped ? (
                <DigitalProductFields idPrefix="product-sheet" ariaPrefix={sheetProduct.productId} value={sheetDigital}
                  onChange={(patch) => setSheetDigitalDraft({ productId: sheetProduct.productId, draft: { ...sheetDigital, ...patch } })} />
              ) : undefined}
            />
          ) : null}
        </Sheet>
      ) : null}

      {isSavingChanges ? <LoadingOverlay title="변경 사항 저장 중" message="변경 사항을 저장하는 중이에요." /> : null}
      {isSavingTaskSchedule ? <LoadingOverlay title="반복 설정 저장 중" message="반복 설정을 저장하는 중이에요." /> : null}
      {taskResetConfirmation?.resetting ? <LoadingOverlay title="완료 기록 초기화 중" message="완료 기록을 초기화하고 최신 과제 목록을 불러오는 중이에요." restoreFocus={false} /> : null}
      {isRefreshingLists ? <LoadingOverlay title="새로고침 중" message="최신 목록을 불러오는 중이에요." /> : null}


      {consentFormOpener ? (
        <ParentConsentFormDialog classLabel={settings.className ?? ''} opener={consentFormOpener} onClose={() => setConsentFormOpener(null)} />
      ) : null}

      {shareState ? (
        <ShareLinkDialog initialTarget={shareState.target} paths={sharePaths(tenantPagePath)} classLabel={classLabel}
          titles={{ store: settings.appTitle ?? '학급 매점', bank: settings.bankTitle ?? '학급 은행' }}
          opener={shareState.opener} onClose={() => setShareState(null)} />
      ) : null}

      {bulkGiveOpener ? (
        <BulkGiveDialog studentIds={selectedStudentIds} options={giveOptions} opener={bulkGiveOpener}
          onClose={() => setBulkGiveOpener(null)} notify={notify} />
      ) : null}

      {bulkBalanceOpen ? (
        <Modal title="잔액 한꺼번에 바꾸기" ariaLabel="잔액 한꺼번에 바꾸기" description={`선택한 학생 ${selectedStudentIds.length}명의 잔액을 바꿔요.`} onClose={() => setBulkBalanceOpen(false)}
          footer={<>
            <Button variant="ghost" onClick={() => setBulkBalanceOpen(false)}>취소</Button>
            <Button variant="primary" icon="check" data-tour="bulk-balance-apply" onClick={async () => { await applyBulkStudentBalance(); setBulkBalanceOpen(false); }}>{selectedStudentIds.length}명에게 적용</Button>
          </>}>
          <div className="space-y-5">
            <div>
              <p className="mb-1.5 text-[13px] font-bold">방법</p>
              <SegmentedControl ariaLabel="선택 학생 작업" value={bulkMode} onChange={setBulkMode}
                options={[{ value: 'add', label: '더하기' }, { value: 'subtract', label: '빼기' }, { value: 'set', label: '이 금액으로 맞추기' }]} />
            </div>
            <Field label="금액" htmlFor="bulk-balance-amount" hint={bulkMode === 'subtract' ? '잔액보다 많이 빼면 음수가 돼요.' : undefined}>
              <Input id="bulk-balance-amount" aria-label="선택 학생 금액" type="number" inputMode="numeric" suffix={unit} value={bulkAmount} onChange={(event) => setBulkAmount(Number(event.target.value))} />
            </Field>
          </div>
        </Modal>
      ) : null}

      {qrPrintStudents ? (
        <Modal title="학생 QR 카드" ariaLabel="선택 학생 QR 발급" description={`선택한 학생 ${qrPrintStudents.length}명의 QR 카드예요. 그대로 인쇄하면 지금 쓰는 카드도 계속 쓸 수 있어요.`} size="xl" className="print:hidden"
          busy={qrReissue.state.pending} onClose={closeQrPrint}
          footer={<>
            <Button variant="ghost" disabled={qrReissue.state.pending} onClick={closeQrPrint}>닫기</Button>
            <Button icon="refresh" data-tour="student-qr-reissue" disabled={qrReissue.state.pending || qrReissue.state.confirming} onClick={qrReissue.ask}>새로 발급</Button>
            <Button variant="primary" icon="printer" disabled={!allQrPrintUrlsReady || qrReissue.state.confirming} onClick={() => window.print()}>인쇄</Button>
          </>}>
          <StudentQrReissueNotice state={qrReissue.state} count={qrPrintStudents.length} onCancel={qrReissue.cancel}
            onConfirm={() => void qrReissue.confirm(qrPrintStudents.map((student) => student.studentId))} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {qrPrintStudents.map((student) => <StudentQrCard key={student.studentId} student={student} qrUrl={qrPrintUrlFor(student.studentId)} />)}
          </div>
        </Modal>
      ) : null}
      {qrPrintStudents ? (
        <section data-qr-print-document aria-label="선택 학생 QR 인쇄 영역">
          <div data-qr-print-grid className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3 print:gap-3">
            {qrPrintStudents.map((student) => <StudentQrCard key={`print-${student.studentId}`} student={student} qrUrl={qrPrintUrlFor(student.studentId)} />)}
          </div>
        </section>
      ) : null}

      {qrTaskPickerOpen ? (
        <Modal title="QR로 과제 부여" description="부여할 과제를 고른 뒤 학생 QR을 찍으면 그 학생에게 과제가 부여돼요." onClose={() => setQrTaskPickerOpen(false)}
          footer={<Button variant="ghost" onClick={() => setQrTaskPickerOpen(false)}>닫기</Button>}>
          <div className="space-y-2">
            {tasks.map((task) => (
              <button key={task.taskId} type="button" aria-label={`${task.title} 과제 선택`} onClick={() => openQrTaskScan(task.taskId)}
                className="flex w-full items-center gap-3 rounded-[var(--crs-radius)] border border-[var(--crs-line)] px-4 py-3 text-left transition-colors hover:bg-[var(--crs-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-bold">{task.title}</span>
                  <span className="mt-0.5 block text-xs text-[var(--theme-muted-text)]">보상 {money(task.reward)}, 부여 {taskProgress(task).assigned}명</span>
                </span>
                <Icon name="chevronRight" size={18} className="shrink-0 text-[var(--theme-muted-text)]" />
              </button>
            ))}
            {tasks.length === 0 ? <p className="py-6 text-center text-[13px] text-[var(--theme-muted-text)]">먼저 과제를 만들어 주세요.</p> : null}
          </div>
        </Modal>
      ) : null}
      {qrTaskScan ? (
        <Modal title="학생 QR 인식" ariaLabel={`${tasks.find((task) => task.taskId === qrTaskScan.taskId)?.title ?? '과제'} QR 과제 부여`}
          description={<><strong className="text-[var(--theme-text)]">{tasks.find((task) => task.taskId === qrTaskScan.taskId)?.title ?? '선택한 과제'}</strong> 과제를 부여해요.</>}
          onClose={returnToQrTaskPicker}
          footer={<>
            <Button variant="ghost" onClick={returnToQrTaskPicker}>취소</Button>
            <Button variant="primary" onClick={() => assignTaskByQr(qrTaskScan.manualId)}>직접 입력 적용</Button>
          </>}>
          <div className="flex justify-center overflow-hidden rounded-[var(--crs-radius-lg)] bg-[var(--crs-subtle)]"><QrScanner onScan={assignTaskByQr} /></div>
          <Field label="학생 QR 직접 입력" htmlFor="qr-task-manual" className="mt-4">
            <Input id="qr-task-manual" aria-label="과제 부여 학생 QR 직접 입력" value={qrTaskScan.manualId} onChange={(event) => setQrTaskScan((current) => current ? { ...current, manualId: event.target.value } : current)} placeholder="S001" />
          </Field>
        </Modal>
      ) : null}
      {qrTaskLoading ? <LoadingOverlay title="QR 인식 중" message="QR을 인식했어요. 과제를 부여하는 중이에요." /> : null}
      {qrTaskResult ? (
        <Modal size="sm" tone={qrTaskResult.status === 'success' ? 'success' : 'danger'}
          title={`QR 과제 부여 ${qrTaskResult.status === 'success' ? '성공' : '실패'}`}
          onClose={returnToQrTaskPicker}
          footer={<>
            <Button variant="ghost" onClick={returnToQrTaskPicker}>{qrTaskResult.status === 'success' ? '닫기' : '취소'}</Button>
            <button type="button" onClick={() => openQrTaskScan(qrTaskResult.taskId)} className={buttonClass({ variant: 'primary' })}>{qrTaskResult.status === 'success' ? '다시 찍기' : '다시 시도'}</button>
          </>}>
          <p className="text-sm leading-relaxed">{qrTaskResult.message}</p>
        </Modal>
      ) : null}

      {/* Recurrence editor opened outside the task panel, e.g. for a bulk selection. */}
      {taskScheduleEditor && !sheetScheduleEditor ? (
        <Modal title={taskScheduleEditor.target.kind === 'bulk' ? '선택한 과제 반복 설정' : '반복 설정'} ariaLabel="과제 기한 설정"
          description={`대상: ${taskTargetSummary(taskScheduleEditor.target).short}`}
          opener={taskScheduleEditor.opener} busy={isSavingTaskSchedule} onClose={closeTaskScheduleEditor} hideWhileBusy
          footer={<>
            <Button variant="ghost" disabled={isSavingTaskSchedule} onClick={closeTaskScheduleEditor}>취소</Button>
            <Button variant="primary" icon="check" disabled={isSavingTaskSchedule || !taskScheduleEditor.explicit || !scheduleFormToPayload(taskScheduleEditor.form).ok}
              onClick={() => void applyTaskScheduleEditor()}>반복 설정 저장</Button>
          </>}>
          <div className="space-y-5">
            {taskScheduleEditor.target.kind === 'bulk' ? <Callout tone="info">선택한 모든 과제에 같은 반복 규칙을 적용해요. 기존 규칙은 덮어써요.</Callout> : null}
            {taskScheduleEditor.taskId ? <TaskScheduleProjection task={tasks.find((task) => task.taskId === taskScheduleEditor.taskId) ?? {}} /> : null}
            <TaskRecurrenceFields form={taskScheduleEditor.form} allowUnset={taskScheduleEditor.target.kind === 'bulk'}
              onChange={(form) => setTaskScheduleEditor((current) => current ? { ...current, form, explicit: current.target.kind === 'bulk' ? Boolean(form.type) : true } : current)} />
            {taskScheduleEditor.target.kind === 'bulk' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="시작" htmlFor="bulk-available-from" optional><Input id="bulk-available-from" aria-label="시작 시각" type="datetime-local" value={taskScheduleEditor.availableFrom} onChange={(event) => setTaskScheduleEditor((current) => current ? { ...current, availableFrom: event.target.value, availabilityExplicit: true } : current)} /></Field>
                <Field label="마감" htmlFor="bulk-due-at" optional><Input id="bulk-due-at" aria-label="기한" type="datetime-local" value={taskScheduleEditor.dueAt} onChange={(event) => setTaskScheduleEditor((current) => current ? { ...current, dueAt: event.target.value, availabilityExplicit: true } : current)} /></Field>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {taskHistory ? <TaskHistoryDialog history={taskHistory} onClose={closeTaskHistory} opener={historyOpenerRef.current} themeColor={themeColor} currencyUnit={unit} /> : null}

      {/* Assignment editor opened outside the task panel, e.g. for a bulk selection. */}
      {taskAssignmentEditor && !sheetAssignmentEditor && !(taskSheet?.mode === 'edit' && taskAssignmentEditor.taskId === taskSheet.taskId) ? (
        <Modal title={taskAssignmentEditor.target.kind === 'bulk' ? '선택한 과제 학생 부여' : '과제 부여'} ariaLabel="과제 부여" size="lg"
          description={`대상: ${taskTargetSummary(taskAssignmentEditor.target).short}`}
          opener={taskAssignmentEditor.opener} busy={isSavingChanges} obscured={Boolean(taskResetConfirmation)} onClose={closeTaskAssignmentEditor} hideWhileBusy
          footer={<>
            {taskAssignmentEditor.target.kind !== 'new' ? <Button variant="ghost" icon="restore" disabled={isSavingChanges} onClick={(event) => requestTaskCompletionReset(taskAssignmentEditor.target, event.currentTarget)}>완료 기록 초기화</Button> : null}
            <div className="mr-auto" />
            <Button variant="ghost" disabled={isSavingChanges} onClick={closeTaskAssignmentEditor}>취소</Button>
            <Button variant="primary" icon="check" disabled={Boolean(taskAssignmentEditor.isLoading) || isSavingChanges || (taskAssignmentEditor.target.kind === 'bulk' && Object.keys(taskAssignmentEditor.operations).length === 0)} onClick={saveTaskAssignment}>
              저장
            </Button>
          </>}>
          {taskAssignmentEditor.target.kind === 'bulk' ? (
            <BulkAssignmentBoard
              editor={taskAssignmentEditor}
              students={sortStudentsById(students)}
              onToggleRow={toggleTaskAssignmentStudent}
              onSelectRows={(ids) => setTaskAssignmentEditor((current) => current ? { ...current, selectedIds: ids } : current)}
              onOperation={setBulkAssignmentOperation}
              onBulkAssigned={setSelectedTaskAssignmentAssigned}
              onBulkCompleted={setSelectedTaskAssignmentCompletion}
            />
          ) : (
            <TaskAssignmentBoard
              editor={taskAssignmentEditor}
              task={tasks.find((task) => task.taskId === taskAssignmentEditor.taskId) ?? null}
              students={sortStudentsById(students)}
              filter={assignmentFilter}
              onFilterChange={setAssignmentFilter}
              onToggleRow={toggleTaskAssignmentStudent}
              onSelectRows={(ids) => setTaskAssignmentEditor((current) => current ? { ...current, selectedIds: ids } : current)}
              onToggleAssigned={toggleTaskAssignmentAssigned}
              onToggleCompleted={toggleTaskAssignmentCompleted}
              onBulkAssigned={setSelectedTaskAssignmentAssigned}
              onBulkCompleted={setSelectedTaskAssignmentCompletion}
            />
          )}
        </Modal>
      ) : null}

      {taskDeleteConfirmation ? (
        <TaskDeleteConfirmDialog
          confirmation={taskDeleteConfirmation}
          onCancel={cancelTaskDelete}
          onConfirm={() => void confirmTaskDelete()}
        />
      ) : null}
      {productDeleteConfirmation ? (
        <ProductDeleteConfirmDialog
          confirmation={productDeleteConfirmation}
          onCancel={cancelProductDelete}
          onConfirm={() => void confirmProductDelete()}
        />
      ) : null}
      {taskResetConfirmation ? (
        <TaskResetConfirmDialog
          confirmation={taskResetConfirmation}
          onCancel={() => { if (!taskResetConfirmation.resetting) setTaskResetConfirmation(null); }}
          onConfirm={() => void confirmTaskCompletionReset()}
        />
      ) : null}
      {taskDescriptionEditor ? (
        <Modal title="과제 설명 편집" ariaLabel="과제 상세 설정 편집" onClose={() => setTaskDescriptionEditor(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setTaskDescriptionEditor(null)}>취소</Button>
            <Button variant="primary" onClick={() => { updateTask(taskDescriptionEditor.taskId, { description: taskDescriptionEditor.value }); setTaskDescriptionEditor(null); }}>상세 설정 적용</Button>
          </>}>
          <Textarea aria-label="과제 상세 설정 전체 입력" className="min-h-40" value={taskDescriptionEditor.value}
            onChange={(event) => setTaskDescriptionEditor((current) => current ? { ...current, value: event.target.value } : current)} />
        </Modal>
      ) : null}
      {currencyLoading ? (
        <LoadingOverlay title={`화폐 ${currencyActionLabel} 처리 중`} message={`QR을 인식했어요. 화폐를 ${currencyActionLabel}하는 중이에요.`} />
      ) : null}
      {currencyScannerOpen ? (
        <Modal title="학생 QR 인식" description={<><strong className="text-[var(--theme-text)]">{money(currencyAmount)}</strong>을 {currencyActionLabel}할 학생의 QR을 찍어 주세요.</>}
          onClose={() => setCurrencyScannerOpen(false)}
          footer={<>
            <Button variant="ghost" onClick={() => setCurrencyScannerOpen(false)}>취소</Button>
            <Button variant="primary" onClick={() => applyCurrencyToStudent(currencyManualId)}>직접 입력 적용</Button>
          </>}>
          <div className="flex justify-center overflow-hidden rounded-[var(--crs-radius-lg)] bg-[var(--crs-subtle)]"><QrScanner onScan={applyCurrencyToStudent} /></div>
          <Field label="학생 QR 직접 입력" htmlFor="currency-manual" className="mt-4">
            <Input id="currency-manual" aria-label="학생 QR 직접 입력" value={currencyManualId} onChange={(event) => setCurrencyManualId(event.target.value)} placeholder="S001" />
          </Field>
        </Modal>
      ) : null}
      {currencyResult ? (
        <Modal size="sm" tone={currencyResult.status === 'success' ? 'success' : 'danger'}
          title={`화폐 ${currencyResult.mode === 'add' ? '지급' : '회수'} ${currencyResult.status === 'success' ? '성공' : '실패'}`}
          onClose={() => setCurrencyResult(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setCurrencyResult(null)}>{currencyResult.status === 'success' ? '닫기' : '취소'}</Button>
            <Button variant="primary" icon="qr" data-autofocus onClick={retryCurrencyScan}>{currencyResult.status === 'success' ? '다음 학생' : '다시 시도'}</Button>
          </>}>
          <p className="text-sm leading-relaxed">{currencyResult.message}</p>
        </Modal>
      ) : null}

      {confirmState ? (
        <Modal size="sm" tone={confirmState.tone ?? 'danger'} title={confirmState.title} busy={confirmState.busy} onClose={() => setConfirmState(null)}
          footer={<>
            <Button variant="ghost" disabled={confirmState.busy} onClick={() => setConfirmState(null)}>취소</Button>
            <Button variant={confirmState.tone === 'warning' ? 'primary' : 'danger'} data-autofocus loading={confirmState.busy} onClick={() => void confirmState.onConfirm()}>{confirmState.confirmLabel}</Button>
          </>}>
          <div className="text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{confirmState.description}</div>
        </Modal>
      ) : null}

      {tutorialMenu ? (
        <TutorialMenu opener={tutorialMenu.opener} place={tutorialPlace} onClose={() => setTutorialMenu(null)}
          onStart={(id) => { setTutorialMenu(null); setActiveTutorial(tutorialById(id)); }} />
      ) : null}
      {activeTutorial ? (
        <TutorialRunner key={activeTutorial.id} tutorial={activeTutorial} onNavigate={(tab) => selectAdminTab(tab)} onClose={() => setActiveTutorial(null)}
          after={{
            next: tutorialAfter(activeTutorial, tutorialPlace),
            onNext: (id) => setActiveTutorial(tutorialById(id)),
            onMenu: () => { setActiveTutorial(null); setTutorialMenu({ opener: null }); },
          }} />
      ) : null}

      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-4 z-[80] flex flex-col items-center gap-2 px-4">
        {toasts.map((toast) => (
          <div key={toast.id} role={toast.tone === 'success' ? 'status' : 'alert'}
            className={cx('pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-[14px] border px-4 py-3 text-[13px] font-semibold leading-relaxed shadow-[var(--crs-shadow-lg)] [animation:crs-pop-in_.18s_ease-out]',
              toast.tone === 'success' ? 'border-[color-mix(in_srgb,var(--crs-success-text)_25%,transparent)] bg-[var(--theme-surface)] text-[var(--theme-text)]' : 'border-[color-mix(in_srgb,var(--crs-warning-text)_25%,transparent)] bg-[var(--theme-surface)] text-[var(--theme-text)]')}>
            <span className={cx('mt-[1px] shrink-0', toast.tone === 'success' ? 'text-[var(--crs-success-text)]' : 'text-[var(--crs-warning-text)]')}><Icon name={toast.tone === 'success' ? 'check' : 'alert'} size={17} /></span>
            <p className="min-w-0 flex-1">{toast.text}</p>
            <button type="button" aria-label="알림 닫기" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))} className="-mr-1 shrink-0 rounded-md p-0.5 opacity-60 hover:opacity-100"><Icon name="close" size={15} /></button>
          </div>
        ))}
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Presentational pieces                                               */
/* ------------------------------------------------------------------ */

function isSuccessNotice(text: string) {
  return /완료|저장했|추가했|심었어요|줬어요|수확했어요|넣었어요|회수했어요/.test(text) && !/실패|못했|불확실|거절|확인해 주세요|미저장|새로고침/.test(text);
}
