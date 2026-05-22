'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import type { ClassTask, Product, Student } from '@/domain/types';
import { SettingsForm } from './SettingsForm';
import { QrScanner } from './QrScanner';

type StudentDraft = Student;
type ProductDraft = Product;
type TaskDraft = ClassTask;
type AdminTab = 'settings' | 'students' | 'products' | 'tasks' | 'currency';
type BulkMode = 'set' | 'add' | 'subtract';
type CurrencyMode = 'add' | 'subtract';
type CurrencyResult = {
  status: 'success' | 'failure';
  mode: CurrencyMode;
  studentId: string;
  amount: number;
  message: string;
};

type NewStudentDraft = {
  studentId: string;
  name: string;
  number: number;
  balance: number;
  status: Student['status'];
};

type NewProductDraft = {
  productId: string;
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  imageUrl: string;
  category: string;
  sortOrder: number;
};

const EMPTY_STUDENT: NewStudentDraft = { studentId: '', name: '', number: 1, balance: 0, status: 'ACTIVE' };
const EMPTY_PRODUCT: NewProductDraft = { productId: '', name: '', price: 0, stock: 0, isActive: true, imageUrl: '', category: '', sortOrder: 1 };
const EMPTY_TASK: TaskDraft = { taskId: '', title: '', description: '', reward: 0, maxCompletionsPerStudent: 1, isActive: true, sortOrder: 1 };

const tabs: Array<{ id: AdminTab; label: string; description: string }> = [
  { id: 'settings', label: '시트 설정', description: 'Google Sheets 연결' },
  { id: 'students', label: '학생 명단', description: '잔액과 상태 관리' },
  { id: 'products', label: '재고 관리', description: '상품과 가격 관리' },
  { id: 'tasks', label: '과제 설정', description: '은행 보상 과제' },
  { id: 'currency', label: '화폐 지급/회수', description: 'QR로 재화 조정' },
];

export function AdminManagePage() {
  const [activeTab, setActiveTab] = useState<AdminTab>('settings');
  const [students, setStudents] = useState<StudentDraft[]>([]);
  const [products, setProducts] = useState<ProductDraft[]>([]);
  const [tasks, setTasks] = useState<TaskDraft[]>([]);
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [bulkMode, setBulkMode] = useState<BulkMode>('set');
  const [bulkAmount, setBulkAmount] = useState(0);
  const [message, setMessage] = useState('학생/상품 목록을 불러오는 중입니다.');
  const [newStudent, setNewStudent] = useState<NewStudentDraft>(EMPTY_STUDENT);
  const [newProduct, setNewProduct] = useState<NewProductDraft>(EMPTY_PRODUCT);
  const [newTask, setNewTask] = useState<TaskDraft>(EMPTY_TASK);
  const [imageEditor, setImageEditor] = useState<{ productId: string; value: string } | null>(null);
  const [taskDescriptionEditor, setTaskDescriptionEditor] = useState<{ taskId: string; value: string } | null>(null);
  const [currencyMode, setCurrencyMode] = useState<CurrencyMode>('add');
  const [currencyAmount, setCurrencyAmount] = useState(0);
  const [currencyScannerOpen, setCurrencyScannerOpen] = useState(false);
  const [currencyManualId, setCurrencyManualId] = useState('');
  const [currencyResult, setCurrencyResult] = useState<CurrencyResult | null>(null);

  const loadLinkedSheetData = useCallback(async (options: { silent?: boolean; shouldApply?: () => boolean } = {}) => {
    const shouldApply = options.shouldApply ?? (() => true);

    if (!options.silent && shouldApply()) setMessage('학생/상품 목록을 불러오는 중입니다.');

    try {
      const [studentResponse, productResponse, taskResponse] = await Promise.all([
        fetch('/api/students', { cache: 'no-store' }),
        fetch('/api/products?includeInactive=1', { cache: 'no-store' }),
        fetch('/api/tasks?includeInactive=1', { cache: 'no-store' }),
      ]);
      const [studentPayload, productPayload, taskPayload] = await Promise.all([studentResponse.json(), productResponse.json(), taskResponse.json()]);

      if (!studentResponse.ok) throw new Error(studentPayload.error ?? '학생 목록을 불러오지 못했습니다.');
      if (!productResponse.ok) throw new Error(productPayload.error ?? '상품 목록을 불러오지 못했습니다.');
      if (!taskResponse.ok) throw new Error(taskPayload.error ?? '과제 목록을 불러오지 못했습니다.');

      if (!shouldApply()) return;
      setStudents(studentPayload);
      setProducts(productPayload);
      setTasks(taskPayload);
      setSelectedStudentIds((ids) => ids.filter((id) => studentPayload.some((student: Student) => student.studentId === id)));
      setSelectedProductIds((ids) => ids.filter((id) => productPayload.some((product: Product) => product.productId === id)));
      setSelectedTaskIds((ids) => ids.filter((id) => taskPayload.some((task: ClassTask) => task.taskId === id)));
      setMessage('');
    } catch (error) {
      if (!shouldApply()) return;
      setStudents([]);
      setProducts([]);
      setTasks([]);
      setMessage(error instanceof Error ? error.message : '목록을 불러오지 못했습니다.');
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

  function notify(messageText: string) {
    window.alert(messageText);
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

  async function saveAllStudents() {
    try {
      const response = await fetch('/api/students/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          students: students.map((student) => ({
            studentId: student.studentId,
            name: student.name,
            number: student.number,
            balance: student.balance,
            status: student.status,
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '학생 명단을 저장하지 못했습니다.');
      const savedStudents = payload as StudentDraft[];
      const savedMap = new Map(savedStudents.map((student) => [student.studentId, student]));
      setStudents((current) => current.map((student) => savedMap.get(student.studentId) ?? student));
      notify(`학생 명단 ${savedStudents.length}명 저장 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '학생 명단을 저장하지 못했습니다.');
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
    try {
      const response = await fetch('/api/students/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: selectedStudentIds, mode: bulkMode, amount: bulkAmount }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '선택 학생 재화를 수정하지 못했습니다.');
      const balanceMap = new Map((payload as Array<{ studentId: string; balance: number }>).map((item) => [item.studentId, item.balance]));
      setStudents((current) => current.map((student) => balanceMap.has(student.studentId) ? { ...student, balance: balanceMap.get(student.studentId)! } : student));
      notify(`선택 학생 ${payload.length}명 수정 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '선택 학생 재화를 수정하지 못했습니다.');
    }
  }

  async function saveAllProducts() {
    try {
      const response = await fetch('/api/products/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products: products.map((product) => ({
            productId: product.productId,
            name: product.name,
            price: product.price,
            stock: product.stock,
            isActive: product.isActive,
            imageUrl: product.imageUrl ?? '',
            category: product.category ?? '',
            sortOrder: product.sortOrder,
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '재고 목록을 저장하지 못했습니다.');
      const savedProducts = payload as ProductDraft[];
      const savedMap = new Map(savedProducts.map((product) => [product.productId, product]));
      setProducts((current) => current.map((product) => savedMap.get(product.productId) ?? product));
      notify(`재고 목록 ${savedProducts.length}개 저장 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '재고 목록을 저장하지 못했습니다.');
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
        taskId: newTask.taskId,
        title: newTask.title,
        description: newTask.description,
        reward: newTask.reward,
        maxCompletionsPerStudent: newTask.maxCompletionsPerStudent,
        isActive: newTask.isActive,
        sortOrder: newTask.sortOrder,
      };
      const response = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '과제를 추가하지 못했습니다.');
      setTasks((current) => [...current, payload].sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title)));
      setNewTask(EMPTY_TASK);
      notify(`${payload.taskId} 과제 추가 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '과제를 추가하지 못했습니다.');
    }
  }

  async function saveAllTasks() {
    try {
      const response = await fetch('/api/tasks/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tasks: tasks.map((task) => ({
            taskId: task.taskId,
            title: task.title,
            description: task.description,
            reward: task.reward,
            maxCompletionsPerStudent: task.maxCompletionsPerStudent,
            isActive: task.isActive,
            sortOrder: task.sortOrder,
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '과제 목록을 저장하지 못했습니다.');
      const savedTasks = payload as TaskDraft[];
      const savedMap = new Map(savedTasks.map((task) => [task.taskId, task]));
      setTasks((current) => current.map((task) => savedMap.get(task.taskId) ?? task).sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title)));
      notify(`과제 목록 ${savedTasks.length}개 저장 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '과제 목록을 저장하지 못했습니다.');
    }
  }

  async function deleteTaskRow(taskId: string) {
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '과제를 삭제하지 못했습니다.');
      setTasks((current) => current.filter((task) => task.taskId !== taskId));
      setSelectedTaskIds((current) => current.filter((id) => id !== taskId));
      notify(`${taskId} 과제 삭제 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '과제를 삭제하지 못했습니다.');
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

  async function resetTaskCompletions(taskIds: string[], label: string) {
    if (taskIds.length === 0) return notify('선택된 과제가 없습니다.');
    try {
      const response = await fetch('/api/tasks/completions/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '과제 완료 기록을 초기화하지 못했습니다.');
      notify(`${label} 완료 기록 ${Number(payload.deletedCount ?? 0)}건 초기화 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '과제 완료 기록을 초기화하지 못했습니다.');
    }
  }

  async function createNewStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const body = { studentId: newStudent.studentId, name: newStudent.name, number: newStudent.number, balance: newStudent.balance, status: newStudent.status };
      const response = await fetch('/api/students', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '학생을 추가하지 못했습니다.');
      setStudents((current) => [...current, payload].sort((a, b) => a.number - b.number || a.name.localeCompare(b.name)));
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
        productId: newProduct.productId,
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

  async function applyCurrencyToStudent(decodedText: string) {
    const studentId = decodedText.trim();
    if (!studentId) return;
    setCurrencyScannerOpen(false);
    try {
      const response = await fetch('/api/students/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: [studentId], mode: currencyMode, amount: currencyAmount }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '화폐를 조정하지 못했습니다.');
      const updatedBalance = Array.isArray(payload) ? payload.find((item: { studentId: string }) => item.studentId === studentId)?.balance : undefined;
      if (typeof updatedBalance === 'number') {
        updateStudent(studentId, { balance: updatedBalance });
      }
      setCurrencyResult({
        status: 'success',
        mode: currencyMode,
        studentId,
        amount: currencyAmount,
        message: `${studentId} 학생에게 ${currencyAmount} ${currencyMode === 'add' ? '지급' : '회수'} 완료`,
      });
    } catch (error) {
      setCurrencyResult({
        status: 'failure',
        mode: currencyMode,
        studentId,
        amount: currencyAmount,
        message: error instanceof Error ? error.message : '화폐를 조정하지 못했습니다.',
      });
    }
  }

  function retryCurrencyScan() {
    setCurrencyResult(null);
    setCurrencyManualId('');
    setCurrencyScannerOpen(true);
  }

  const currencyActionLabel = currencyMode === 'add' ? '지급' : '회수';

  return (
    <main data-testid="admin-shell" className="min-h-screen bg-[#dbeaf6] p-2 text-slate-950 sm:p-3 lg:p-5">
      <section className="mx-auto flex w-full max-w-[1280px] flex-col gap-3 lg:gap-4">
        <header className="rounded-[1.25rem] border border-slate-300/70 bg-white px-4 py-4 text-center shadow-sm sm:rounded-[1.75rem] md:px-6">
          <p className="text-xs font-black tracking-[0.22em] text-sky-600 sm:text-sm">CLASS STORE ADMIN</p>
          <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl md:text-5xl">관리자 센터</h1>
          <p className="mx-auto mt-1 max-w-2xl text-xs font-bold text-slate-500 sm:text-sm md:text-base">
            태블릿과 스마트폰에서 빠르게 학생 잔액과 상품 재고를 관리합니다.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <SummaryCard label="학생" value={`${summary.students}명`} />
            <SummaryCard label="판매 상품" value={`${summary.activeProducts}개`} />
            <SummaryCard label="전체 재고" value={`${summary.totalStock}개`} />
            <SummaryCard label="활성 과제" value={`${summary.activeTasks}개`} />
          </div>
          {message ? <p className="mt-3 rounded-2xl bg-rose-100 p-3 text-sm font-bold text-rose-700">{message}</p> : null}
        </header>

        <nav data-testid="admin-tabs" role="tablist" aria-label="관리자 메뉴" className="grid grid-cols-3 gap-2 rounded-[1.5rem] border border-slate-300/70 bg-white/90 p-2 shadow-sm sm:grid-cols-6">
          <AdminNavLink href="/" title="매점 바로가기" description="키오스크" />
          <AdminNavLink href="/bank" title="은행 바로가기" description="학생 은행" />
          <AdminNavLink href="/admin/transactions" title="결제 내역 확인" description="거래 기록" />
          {tabs.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={tab.label}
                onClick={() => setActiveTab(tab.id)}
                className={`rounded-[1rem] px-2 py-3 text-left transition ${selected ? 'bg-sky-500 text-white shadow-sm' : 'bg-sky-50 text-slate-700 hover:bg-sky-100'}`}
              >
                <span className="block text-sm font-black sm:text-base">{tab.label}</span>
                <span className={`mt-0.5 hidden text-[11px] font-bold lg:block ${selected ? 'text-sky-50' : 'text-slate-500'}`}>{tab.description}</span>
              </button>
            );
          })}
        </nav>

        {activeTab === 'settings' ? (
          <section role="tabpanel" aria-label="시트 설정" className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
            <SettingsForm
              linkedStudentCount={students.length}
              linkedProductCount={products.length}
              onSettingsSaved={() => loadLinkedSheetData()}
            />
            <InfoPanel />
          </section>
        ) : null}

        {activeTab === 'students' ? (
          <section role="tabpanel" aria-label="학생 명단" className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
            <SectionCard title="새 학생 추가" description="QR ID와 초기 잔액을 등록합니다." compact>
              <form onSubmit={createNewStudent} className="space-y-2">
                <TextInput label="새 학생 ID" value={newStudent.studentId} onChange={(value) => setNewStudent((current) => ({ ...current, studentId: value }))} compact />
                <TextInput label="새 학생 이름" value={newStudent.name} onChange={(value) => setNewStudent((current) => ({ ...current, name: value }))} compact />
                <div className="grid grid-cols-2 gap-2">
                  <NumberInput label="새 학생 번호" value={newStudent.number} onChange={(value) => setNewStudent((current) => ({ ...current, number: value }))} compact />
                  <NumberInput label="새 학생 잔액" value={newStudent.balance} onChange={(value) => setNewStudent((current) => ({ ...current, balance: value }))} compact />
                </div>
                <button className="w-full rounded-xl bg-sky-500 py-3 font-black text-white shadow-sm" type="submit">새 학생 추가</button>
              </form>
            </SectionCard>

            <SectionCard title="학생 명단" description="짧은 행으로 많이 보이게 정리했습니다." compact>
              <div className="mb-3 rounded-2xl border border-slate-200 bg-sky-50/70 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-black">
                    <input aria-label="전체 학생 선택" checked={allStudentsSelected} onChange={(event) => setSelectedStudentIds(event.target.checked ? students.map((student) => student.studentId) : [])} type="checkbox" />
                    전체 선택 ({selectedStudentIds.length}/{students.length})
                  </label>
                  <select aria-label="선택 학생 작업" value={bulkMode} onChange={(event) => setBulkMode(event.target.value as BulkMode)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold">
                    <option value="set">특정 값으로 설정</option>
                    <option value="add">금액 추가</option>
                    <option value="subtract">금액 제거</option>
                  </select>
                  <input aria-label="선택 학생 금액" value={bulkAmount} onChange={(event) => setBulkAmount(Number(event.target.value))} type="number" className="w-28 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold" />
                  <button type="button" onClick={applyBulkStudentBalance} className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-black text-white">화폐 수정</button>
                  <button type="button" onClick={deleteSelectedStudents} className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-black text-white">삭제</button>
                  <button type="button" onClick={saveAllStudents} className="rounded-xl bg-sky-500 px-4 py-2 text-sm font-black text-white">저장</button>
                  <Link href="/admin/student-qrs" className="rounded-xl bg-amber-100 px-4 py-2 text-sm font-black text-amber-900">QR 출력</Link>
                </div>
              </div>

              <div data-testid="student-list" className="overflow-hidden rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100">
                <div data-testid="student-header-row" className="grid grid-cols-[24px_44px_minmax(3.8rem,1fr)_42px_72px_46px_40px] items-center gap-0.5 bg-slate-100 px-1.5 py-1 text-[10px] font-black text-slate-500">
                  <span>선택</span>
                  <span>ID</span>
                  <span>이름</span>
                  <span>번호</span>
                  <span>잔액</span>
                  <span>상태</span>
                  <span>삭제</span>
                </div>
                {students.map((student) => (
                  <div data-testid="student-row" className="grid grid-cols-[24px_44px_minmax(3.8rem,1fr)_42px_72px_46px_40px] items-center gap-0.5 px-1.5 py-1 text-[11px]" key={student.studentId}>
                    <label className="flex items-center justify-center">
                      <input aria-label={`${student.studentId} 선택`} checked={selectedStudentIds.includes(student.studentId)} onChange={() => toggleStudent(student.studentId)} type="checkbox" />
                      <span className="sr-only">선택</span>
                    </label>
                    <p className="min-w-0 truncate font-black text-sky-700">{student.studentId}</p>
                    <TextInput dataTestId="student-name-field" label={`${student.studentId} 이름`} value={student.name} onChange={(value) => updateStudent(student.studentId, { name: value })} dense />
                    <NumberInput label={`${student.studentId} 번호`} value={student.number} onChange={(value) => updateStudent(student.studentId, { number: value })} dense />
                    <NumberInput label={`${student.studentId} 잔액`} value={student.balance} onChange={(value) => updateStudent(student.studentId, { balance: value })} dense />
                    <label className="block min-w-0 text-xs font-bold text-slate-700">
                      <span className="sr-only">상태</span>
                      <select aria-label={`${student.studentId} 상태`} className="h-8 w-full rounded-lg border border-slate-200 bg-white px-1 text-xs" onChange={(event) => updateStudent(student.studentId, { status: event.target.value as Student['status'] })} value={student.status}>
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
          <section role="tabpanel" aria-label="재고 관리" className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
            <SectionCard title="새 상품 추가" description="상품과 가격, 재고를 등록합니다." compact>
              <form onSubmit={createNewProduct} className="space-y-2">
                <TextInput label="새 상품 ID" value={newProduct.productId} onChange={(value) => setNewProduct((current) => ({ ...current, productId: value }))} compact />
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
                <button className="w-full rounded-xl bg-sky-500 py-3 font-black text-white shadow-sm" type="submit">새 상품 추가</button>
              </form>
            </SectionCard>

            <SectionCard title="상품 · 재고 관리" description="가로형 행으로 재고를 빠르게 수정합니다." compact>
              <div className="mb-3 rounded-2xl border border-slate-200 bg-sky-50/70 p-3">
                <label className="flex w-fit items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-black">
                  <input aria-label="전체 상품 선택" checked={allProductsSelected} onChange={(event) => setSelectedProductIds(event.target.checked ? products.map((product) => product.productId) : [])} type="checkbox" />
                  전체 선택 ({selectedProductIds.length}/{products.length})
                </label>
                <button type="button" onClick={deleteSelectedProducts} className="mt-2 rounded-xl bg-rose-600 px-4 py-2 text-sm font-black text-white">삭제</button>
                <button type="button" onClick={saveAllProducts} className="ml-2 mt-2 rounded-xl bg-sky-500 px-4 py-2 text-sm font-black text-white">저장</button>
              </div>
              <div data-testid="product-list" className="overflow-hidden rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100">
                <div data-testid="product-header-row" className="grid grid-cols-[24px_30px_minmax(3rem,1fr)_56px_48px_36px_minmax(3rem,0.8fr)_40px_30px_34px] items-center gap-0.5 bg-slate-100 px-1.5 py-1 text-[10px] font-black text-slate-500">
                  <span>선택</span>
                  <span>ID</span>
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
                  <div data-testid="product-row" className="grid grid-cols-[24px_30px_minmax(3rem,1fr)_56px_48px_36px_minmax(3rem,0.8fr)_40px_30px_34px] items-center gap-0.5 px-1.5 py-1 text-[11px]" key={product.productId}>
                    <label className="flex items-center justify-center">
                      <input aria-label={`${product.productId} 선택`} checked={selectedProductIds.includes(product.productId)} onChange={() => toggleProduct(product.productId)} type="checkbox" />
                      <span className="sr-only">선택</span>
                    </label>
                    <p className="min-w-0 truncate font-black text-sky-700">{product.productId}</p>
                    <TextInput dataTestId="product-name-field" label={`${product.productId} 상품명`} value={product.name} onChange={(value) => updateProduct(product.productId, { name: value })} dense />
                    <NumberInput label={`${product.productId} 가격`} value={product.price} onChange={(value) => updateProduct(product.productId, { price: value })} dense />
                    <NumberInput label={`${product.productId} 재고`} value={product.stock} onChange={(value) => updateProduct(product.productId, { stock: value })} dense />
                    <TextInput label={`${product.productId} 카테고리`} value={product.category ?? ''} onChange={(value) => updateProduct(product.productId, { category: value })} dense />
                    <button
                      aria-label={`${product.productId} 이미지 주소 편집`}
                      className="h-8 min-w-0 truncate rounded-lg border border-slate-200 bg-white px-1 text-left text-[10px] font-bold text-slate-600"
                      onClick={() => setImageEditor({ productId: product.productId, value: product.imageUrl ?? '' })}
                      type="button"
                    >
                      {product.imageUrl ? 'URL' : '이미지'}
                    </button>
                    <NumberInput label={`${product.productId} 정렬`} value={product.sortOrder} onChange={(value) => updateProduct(product.productId, { sortOrder: value })} dense />
                    <label className="flex h-8 items-center justify-center rounded-lg bg-sky-50 text-[10px] font-bold text-slate-700">
                      <input aria-label={`${product.productId} 판매중`} checked={product.isActive} onChange={(event) => updateProduct(product.productId, { isActive: event.target.checked })} type="checkbox" />
                    </label>
                    <button aria-label={`${product.productId} 상품 삭제`} className="h-8 rounded-lg bg-rose-100 px-1 text-[10px] font-black text-rose-700" onClick={() => deleteProductRow(product.productId)} type="button">
                      삭제
                    </button>
                  </div>
                ))}
              </div>
            </SectionCard>
          </section>
        ) : null}

        {activeTab === 'tasks' ? (
          <section data-testid="task-panel" role="tabpanel" aria-label="과제 설정" className="grid min-w-0 gap-3 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
            <div data-testid="new-task-card" className="min-w-0">
            <SectionCard title="새 과제 추가" description="은행 페이지에서 학생이 완료할 보상 과제를 등록합니다." compact>
              <form onSubmit={createNewTask} className="space-y-2">
                <TextInput label="새 과제 ID" value={newTask.taskId} onChange={(value) => setNewTask((current) => ({ ...current, taskId: value }))} compact />
                <TextInput label="새 과제명" value={newTask.title} onChange={(value) => setNewTask((current) => ({ ...current, title: value }))} compact />
                <label className="block text-xs font-bold text-slate-700">
                  <span>새 과제 설명</span>
                  <textarea aria-label="새 과제 설명" value={newTask.description} onChange={(event) => setNewTask((current) => ({ ...current, description: event.target.value }))} className="mt-1 min-h-24 w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm outline-none transition focus:border-sky-400" />
                </label>
                <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3">
                  <NumberInput label="새 과제 보상" value={newTask.reward} onChange={(value) => setNewTask((current) => ({ ...current, reward: value }))} compact />
                  <NumberInput label="새 과제 완료 가능 횟수" value={newTask.maxCompletionsPerStudent} onChange={(value) => setNewTask((current) => ({ ...current, maxCompletionsPerStudent: value }))} compact />
                  <NumberInput label="새 과제 정렬" value={newTask.sortOrder} onChange={(value) => setNewTask((current) => ({ ...current, sortOrder: value }))} compact />
                </div>
                <label className="flex items-center gap-2 rounded-xl bg-sky-50 px-3 py-2 text-sm font-black text-slate-700">
                  <input aria-label="새 과제 활성" checked={newTask.isActive} onChange={(event) => setNewTask((current) => ({ ...current, isActive: event.target.checked }))} type="checkbox" />
                  은행 페이지에 표시
                </label>
                <button className="w-full rounded-xl bg-sky-500 py-3 font-black text-white shadow-sm" type="submit">새 과제 추가</button>
              </form>
            </SectionCard>
            </div>

            <div data-testid="task-list-card" className="min-w-0">
            <SectionCard title="과제 설정" description="학생 은행 페이지에 노출될 과제와 완료 제한을 관리합니다." compact>
              <div className="mb-3 rounded-2xl border border-slate-200 bg-sky-50/70 p-3">
                <div data-testid="task-bulk-actions" className="flex flex-wrap items-center gap-2">
                <label className="flex w-fit items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-black">
                  <input aria-label="전체 과제 선택" checked={allTasksSelected} onChange={(event) => setSelectedTaskIds(event.target.checked ? tasks.map((task) => task.taskId) : [])} type="checkbox" />
                  전체 선택 ({selectedTaskIds.length}/{tasks.length})
                </label>
                <button type="button" onClick={deleteSelectedTasks} className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-black text-white">삭제</button>
                <button type="button" onClick={() => resetTaskCompletions([...selectedTaskIds], `선택 과제 ${selectedTaskIds.length}개`)} className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-black text-white">초기화</button>
                <button type="button" onClick={saveAllTasks} className="rounded-xl bg-sky-500 px-4 py-2 text-sm font-black text-white">저장</button>
                </div>
              </div>
              <div data-testid="task-list-scroll" className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
                <div className="min-w-[540px] divide-y divide-slate-100">
                <div data-testid="task-header-row" className="grid grid-cols-[24px_42px_minmax(5rem,1fr)_64px_64px_48px_38px_minmax(3rem,0.7fr)_46px_40px] items-center gap-0.5 bg-slate-100 px-1.5 py-1 text-[10px] font-black text-slate-500">
                  <span>선택</span><span>ID</span><span>과제명</span><span>보상</span><span>횟수</span><span>순서</span><span>활성</span><span>상세</span><span>초기화</span><span>삭제</span>
                </div>
                {tasks.map((task) => (
                  <div data-testid="task-row" key={task.taskId} className="grid grid-cols-[24px_42px_minmax(5rem,1fr)_64px_64px_48px_38px_minmax(3rem,0.7fr)_46px_40px] items-center gap-0.5 px-1.5 py-1 text-[11px]">
                    <label className="flex items-center justify-center">
                      <input aria-label={`${task.taskId} 선택`} checked={selectedTaskIds.includes(task.taskId)} onChange={() => toggleTask(task.taskId)} type="checkbox" />
                      <span className="sr-only">선택</span>
                    </label>
                    <p className="min-w-0 truncate font-black text-sky-700">{task.taskId}</p>
                    <TextInput label={`${task.taskId} 과제명`} value={task.title} onChange={(value) => updateTask(task.taskId, { title: value })} dense />
                    <NumberInput label={`${task.taskId} 보상`} value={task.reward} onChange={(value) => updateTask(task.taskId, { reward: value })} dense />
                    <NumberInput label={`${task.taskId} 완료 가능 횟수`} value={task.maxCompletionsPerStudent} onChange={(value) => updateTask(task.taskId, { maxCompletionsPerStudent: value })} dense />
                    <NumberInput label={`${task.taskId} 정렬`} value={task.sortOrder} onChange={(value) => updateTask(task.taskId, { sortOrder: value })} dense />
                    <label className="flex h-8 items-center justify-center rounded-lg bg-sky-50 text-[10px] font-bold text-slate-700">
                      <input aria-label={`${task.taskId} 활성`} checked={task.isActive} onChange={(event) => updateTask(task.taskId, { isActive: event.target.checked })} type="checkbox" />
                    </label>
                    <button
                      aria-label={`${task.taskId} 상세 설정 편집`}
                      className="h-8 min-w-0 truncate rounded-lg border border-slate-200 bg-white px-1 text-left text-[10px] font-bold text-slate-600"
                      onClick={() => setTaskDescriptionEditor({ taskId: task.taskId, value: task.description })}
                      type="button"
                    >
                      {task.description ? '상세 있음' : '상세'}
                    </button>
                    <button type="button" aria-label={`${task.taskId} 완료 기록 초기화`} onClick={() => resetTaskCompletions([task.taskId], task.taskId)} className="h-8 rounded-lg bg-amber-100 px-1 text-[10px] font-black text-amber-800">초기화</button>
                    <button type="button" aria-label={`${task.taskId} 과제 삭제`} onClick={() => deleteTaskRow(task.taskId)} className="h-8 rounded-lg bg-rose-100 px-1 text-[10px] font-black text-rose-700">삭제</button>
                  </div>
                ))}
                </div>
              </div>
            </SectionCard>
            </div>
          </section>
        ) : null}

        {activeTab === 'currency' ? (
          <section role="tabpanel" aria-label="화폐 지급/회수" className="mx-auto w-full max-w-xl">
            <SectionCard title="화폐 지급/회수" description="금액과 지급/회수만 정한 뒤 학생 QR을 찍으면 바로 반영됩니다." compact>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setCurrencyMode('add')} className={`rounded-2xl px-4 py-4 text-xl font-black ${currencyMode === 'add' ? 'bg-sky-500 text-white' : 'bg-sky-50 text-slate-700'}`}>지급</button>
                <button type="button" onClick={() => setCurrencyMode('subtract')} className={`rounded-2xl px-4 py-4 text-xl font-black ${currencyMode === 'subtract' ? 'bg-rose-500 text-white' : 'bg-rose-50 text-slate-700'}`}>회수</button>
              </div>
              <label className="mt-3 block text-sm font-black text-slate-700">
                <span>금액</span>
                <input aria-label="지급/회수 금액" value={currencyAmount} onChange={(event) => setCurrencyAmount(Number(event.target.value))} type="number" min="0" className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-4 text-2xl font-black outline-none focus:border-sky-400" />
              </label>
              <button type="button" onClick={() => { setCurrencyResult(null); setCurrencyManualId(''); setCurrencyScannerOpen(true); }} className="mt-3 w-full rounded-2xl bg-slate-950 py-4 text-xl font-black text-white">
                QR 인식 시작
              </button>
            </SectionCard>
          </section>
        ) : null}
      </section>
      {imageEditor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-label="이미지 주소 편집" className="w-full max-w-xl rounded-2xl bg-white p-4 shadow-2xl">
            <h2 className="text-xl font-black">이미지 주소 편집</h2>
            <p className="mt-1 text-sm font-bold text-slate-500">긴 이미지 URL은 여기에서 편하게 붙여넣고 수정합니다.</p>
            <label className="mt-4 block text-sm font-bold text-slate-700">
              <span>이미지 주소 전체 입력</span>
              <textarea
                aria-label="이미지 주소 전체 입력"
                className="mt-2 min-h-32 w-full rounded-xl border border-slate-200 bg-white p-3 text-sm outline-none focus:border-sky-400"
                value={imageEditor.value}
                onChange={(event) => setImageEditor((current) => current ? { ...current, value: event.target.value } : current)}
              />
            </label>
            <div className="mt-4 flex gap-2">
              <button type="button" className="flex-1 rounded-xl bg-slate-200 py-3 font-black text-slate-700" onClick={() => setImageEditor(null)}>취소</button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-sky-500 py-3 font-black text-white"
                onClick={() => {
                  updateProduct(imageEditor.productId, { imageUrl: imageEditor.value });
                  setImageEditor(null);
                }}
              >
                이미지 주소 적용
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {taskDescriptionEditor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-label="과제 상세 설정 편집" className="w-full max-w-xl rounded-2xl bg-white p-4 shadow-2xl">
            <h2 className="text-xl font-black">과제 상세 설정 편집</h2>
            <p className="mt-1 text-sm font-bold text-slate-500">긴 설명은 여기에서 편하게 입력하고 수정합니다.</p>
            <label className="mt-4 block text-sm font-bold text-slate-700">
              <span>과제 상세 설정 전체 입력</span>
              <textarea
                aria-label="과제 상세 설정 전체 입력"
                className="mt-2 min-h-40 w-full rounded-xl border border-slate-200 bg-white p-3 text-sm outline-none focus:border-sky-400"
                value={taskDescriptionEditor.value}
                onChange={(event) => setTaskDescriptionEditor((current) => current ? { ...current, value: event.target.value } : current)}
              />
            </label>
            <div className="mt-4 flex gap-2">
              <button type="button" className="flex-1 rounded-xl bg-slate-200 py-3 font-black text-slate-700" onClick={() => setTaskDescriptionEditor(null)}>취소</button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-sky-500 py-3 font-black text-white"
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
      {currencyScannerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-label="학생 QR 인식" className="w-full max-w-xl rounded-2xl bg-white p-4 shadow-2xl">
            <h2 className="text-xl font-black">학생 QR 인식</h2>
            <p className="mt-1 text-sm font-bold text-slate-500">{currencyAmount} {currencyActionLabel}할 학생 QR을 인식합니다.</p>
            <div className="mt-4 flex justify-center">
              <QrScanner onScan={applyCurrencyToStudent} />
            </div>
            <label className="mt-4 block text-sm font-bold text-slate-700">
              <span>학생 QR 직접 입력</span>
              <input aria-label="학생 QR 직접 입력" value={currencyManualId} onChange={(event) => setCurrencyManualId(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white p-3 text-sm outline-none focus:border-sky-400" placeholder="S001" />
            </label>
            <div className="mt-4 flex gap-2">
              <button type="button" className="flex-1 rounded-xl bg-slate-200 py-3 font-black text-slate-700" onClick={() => setCurrencyScannerOpen(false)}>취소</button>
              <button type="button" className="flex-1 rounded-xl bg-sky-500 py-3 font-black text-white" onClick={() => applyCurrencyToStudent(currencyManualId)}>직접 입력 적용</button>
            </div>
          </section>
        </div>
      ) : null}
      {currencyResult ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-label={`화폐 ${currencyResult.mode === 'add' ? '지급' : '회수'} ${currencyResult.status === 'success' ? '성공' : '실패'}`} className="w-full max-w-md rounded-2xl bg-white p-5 text-center shadow-2xl">
            <h2 className={`text-2xl font-black ${currencyResult.status === 'success' ? 'text-sky-700' : 'text-rose-700'}`}>화폐 {currencyResult.mode === 'add' ? '지급' : '회수'} {currencyResult.status === 'success' ? '성공' : '실패'}</h2>
            <p className="mt-3 rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-700">{currencyResult.message}</p>
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

function AdminNavLink({ href, title, description }: { href: string; title: string; description: string }) {
  return (
    <Link className="rounded-[1rem] bg-sky-50 px-2 py-3 text-left text-slate-700 transition hover:bg-sky-100" href={href}>
      <span className="block text-sm font-black sm:text-base">{title}</span>
      <span className="mt-0.5 hidden text-[11px] font-bold text-slate-500 lg:block">{description}</span>
    </Link>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-sky-50 px-3 py-2 text-left sm:px-4 sm:py-3">
      <p className="text-[11px] font-black text-slate-500 sm:text-xs">{label}</p>
      <p className="mt-1 text-xl font-black text-sky-700 sm:text-2xl">{value}</p>
    </div>
  );
}

function SectionCard({ title, description, children, compact = false }: { title: string; description: string; children: ReactNode; compact?: boolean }) {
  return (
    <section className={`min-w-0 overflow-hidden rounded-[1.25rem] border border-slate-300/70 bg-white/90 shadow-sm sm:rounded-[1.75rem] ${compact ? 'p-3 md:p-4' : 'p-4 md:p-5'}`}>
      <h2 className="text-xl font-black sm:text-2xl">{title}</h2>
      <p className="mt-1 text-xs font-bold text-slate-500 sm:text-sm">{description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function TextInput({ label, value, onChange, compact = false, dense = false, dataTestId }: { label: string; value: string; onChange: (value: string) => void; compact?: boolean; dense?: boolean; dataTestId?: string }) {
  const visibleLabel = label.replace(/^새 |^[SP]\d+ /, '');
  const inputClass = dense
    ? 'h-8 w-full rounded-lg border border-slate-200 bg-white px-1 text-[11px] outline-none transition focus:border-sky-400'
    : `mt-1 w-full rounded-xl border border-slate-200 bg-white px-2 outline-none transition focus:border-sky-400 ${compact ? 'py-2 text-sm' : 'py-3'}`;

  return (
    <label className="block min-w-0 text-xs font-bold text-slate-700">
      <span data-testid={dataTestId} className={dense ? 'sr-only' : undefined}>{visibleLabel}</span>
      <input aria-label={label} className={inputClass} onChange={(event) => onChange(event.target.value)} value={value} />
    </label>
  );
}

function NumberInput({ label, value, onChange, compact = false, dense = false }: { label: string; value: number; onChange: (value: number) => void; compact?: boolean; dense?: boolean }) {
  const visibleLabel = label.replace(/^새 |^[SP]\d+ /, '');
  const inputClass = dense
    ? 'h-8 w-full rounded-lg border border-slate-200 bg-white px-1 text-[11px] outline-none transition focus:border-sky-400'
    : `mt-1 w-full rounded-xl border border-slate-200 bg-white px-2 outline-none transition focus:border-sky-400 ${compact ? 'py-2 text-sm' : 'py-3'}`;

  return (
    <label className="block min-w-0 text-xs font-bold text-slate-700">
      <span className={dense ? 'sr-only' : undefined}>{visibleLabel}</span>
      <input aria-label={label} className={inputClass} onChange={(event) => onChange(Number(event.target.value))} type="number" value={value} />
    </label>
  );
}

function InfoPanel() {
  return (
    <aside className="rounded-[1.25rem] border border-slate-300/70 bg-white/90 p-4 shadow-sm sm:rounded-[1.75rem] md:p-5">
      <h2 className="text-xl font-black sm:text-2xl">사용 전 확인</h2>
      <ul className="mt-3 space-y-2 text-sm font-bold text-slate-600">
        <li>• Students, Products, Transactions, Adjustments 시트가 필요합니다.</li>
        <li>• Google 로그인 계정 또는 서비스 계정에 스프레드시트 편집 권한이 필요합니다.</li>
        <li>• QR 코드에는 이름이 아니라 S001 같은 studentId만 넣습니다.</li>
      </ul>
    </aside>
  );
}
