'use client';

/* eslint-disable @next/next/no-img-element */

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import type { ClassTask, Product, Student } from '@/domain/types';
import { SettingsForm } from './SettingsForm';
import { QrScanner } from './QrScanner';
import { TransactionsPanel } from './TransactionsPage';

type StudentDraft = Student;
type ProductDraft = Product;
type TaskDraft = ClassTask;
type AdminTab = 'settings' | 'students' | 'products' | 'tasks' | 'transactions' | 'currency';
type BulkMode = 'set' | 'add' | 'subtract';
type CurrencyMode = 'add' | 'subtract';
type ThemeColor = 'blue' | 'pink' | 'yellow' | 'green' | 'purple' | 'white' | 'black' | 'navy';
type Settings = { currencyUnit?: string; appTitle?: string; bankTitle?: string; themeColor?: ThemeColor };
type AdminTheme = { shell: string; pageText: string; accentText: string; accentBg: string; actionText: string; selectedTab: string; idleTab: string; statBg: string; logoColor: string; softBg: string; softText: string; focusBorder: string };
const disabledActionClass = 'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none';
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
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  imageUrl: string;
  category: string;
  sortOrder: number;
};

const EMPTY_STUDENT: NewStudentDraft = { studentId: '', name: '', number: 1, balance: 0, status: 'ACTIVE' };
const EMPTY_PRODUCT: NewProductDraft = { name: '', price: 0, stock: 0, isActive: true, imageUrl: '', category: '', sortOrder: 1 };
const EMPTY_TASK: Omit<TaskDraft, 'taskId'> = { title: '', description: '', reward: 0, maxCompletionsPerStudent: 1, isActive: true, sortOrder: 1 };

const ADMIN_THEME: Record<ThemeColor, AdminTheme> = {
  blue: { shell: 'bg-[#EDF5FA]', pageText: 'text-slate-950', accentText: 'text-[#365F78]', accentBg: 'bg-[#B8D0E0]', actionText: 'text-[#1F1F1F]', selectedTab: 'bg-[#B8D0E0] text-[#1F1F1F]', idleTab: 'bg-[#EDF5FA] text-slate-800 hover:bg-[#D8E9F2]', statBg: 'bg-[#EDF5FA]', logoColor: 'bg-[#365F78]', softBg: 'bg-[#EDF5FA]/80', softText: 'text-slate-700', focusBorder: 'focus:border-[#B8D0E0]' },
  pink: { shell: 'bg-[#FAEDED]', pageText: 'text-slate-950', accentText: 'text-[#8F5555]', accentBg: 'bg-[#F0C7C7]', actionText: 'text-[#1F1F1F]', selectedTab: 'bg-[#F0C7C7] text-[#1F1F1F]', idleTab: 'bg-[#FAEDED] text-slate-800 hover:bg-[#F4DADA]', statBg: 'bg-[#FAEDED]', logoColor: 'bg-[#B97878]', softBg: 'bg-[#FAEDED]/80', softText: 'text-slate-700', focusBorder: 'focus:border-[#F0C7C7]' },
  yellow: { shell: 'bg-[#FCFAE6]', pageText: 'text-slate-950', accentText: 'text-[#766D1E]', accentBg: 'bg-[#F5EDA6]', actionText: 'text-[#1F1F1F]', selectedTab: 'bg-[#F5EDA6] text-[#1F1F1F]', idleTab: 'bg-[#FCFAE6] text-slate-800 hover:bg-[#F8F2BF]', statBg: 'bg-[#FCFAE6]', logoColor: 'bg-[#A99D37]', softBg: 'bg-[#FCFAE6]/80', softText: 'text-slate-700', focusBorder: 'focus:border-[#F5EDA6]' },
  green: { shell: 'bg-[#DCF5C9]', pageText: 'text-slate-950', accentText: 'text-[#4F7138]', accentBg: 'bg-[#A5C78B]', actionText: 'text-[#1F1F1F]', selectedTab: 'bg-[#A5C78B] text-[#1F1F1F]', idleTab: 'bg-[#DCF5C9] text-slate-800 hover:bg-[#C3E5AE]', statBg: 'bg-[#DCF5C9]', logoColor: 'bg-[#6B8E50]', softBg: 'bg-[#DCF5C9]/80', softText: 'text-slate-700', focusBorder: 'focus:border-[#A5C78B]' },
  purple: { shell: 'bg-[#F7EDFC]', pageText: 'text-slate-950', accentText: 'text-[#76518A]', accentBg: 'bg-[#BB99CC]', actionText: 'text-[#1F1F1F]', selectedTab: 'bg-[#BB99CC] text-[#1F1F1F]', idleTab: 'bg-[#F7EDFC] text-slate-800 hover:bg-[#E8D6F0]', statBg: 'bg-[#F7EDFC]', logoColor: 'bg-[#76518A]', softBg: 'bg-[#F7EDFC]/80', softText: 'text-slate-700', focusBorder: 'focus:border-[#BB99CC]' },
  white: { shell: 'bg-[#FCFCFC]', pageText: 'text-[#1F1F1F]', accentText: 'text-[#1F1F1F]', accentBg: 'bg-[#1F1F1F]', actionText: 'text-[#FCFCFC]', selectedTab: 'bg-[#1F1F1F] text-[#FCFCFC]', idleTab: 'bg-[#FCFCFC] text-[#1F1F1F] hover:bg-white', statBg: 'bg-white', logoColor: 'bg-[#1F1F1F]', softBg: 'bg-white', softText: 'text-[#1F1F1F]', focusBorder: 'focus:border-[#1F1F1F]' },
  black: { shell: 'bg-[#1F1F1F]', pageText: 'text-[#FCFCFC]', accentText: 'text-[#FCFCFC]', accentBg: 'bg-[#FCFCFC]', actionText: 'text-[#1F1F1F]', selectedTab: 'bg-[#FCFCFC] text-[#1F1F1F]', idleTab: 'bg-[#2B2B2B] text-[#FCFCFC] hover:bg-[#3A3A3A]', statBg: 'bg-[#2B2B2B]', logoColor: 'bg-[#FCFCFC]', softBg: 'bg-[#2B2B2B]', softText: 'text-[#FCFCFC]', focusBorder: 'focus:border-[#FCFCFC]' },
  navy: { shell: 'bg-[#DCE8F4]', pageText: 'text-[#1F1F1F]', accentText: 'text-[#2F5D82]', accentBg: 'bg-[#7FA6C7]', actionText: 'text-[#1F1F1F]', selectedTab: 'bg-[#7FA6C7] text-[#1F1F1F]', idleTab: 'bg-[#EEF5FA] text-[#1F1F1F] hover:bg-[#C8DCEC]', statBg: 'bg-[#EEF5FA]', logoColor: 'bg-[#3F6F95]', softBg: 'bg-[#EEF5FA]/80', softText: 'text-slate-700', focusBorder: 'focus:border-[#7FA6C7]' },
};

function normalizeThemeColor(value: unknown): ThemeColor {
  return value === 'blue' || value === 'pink' || value === 'yellow' || value === 'green' || value === 'purple' || value === 'black' || value === 'navy' ? value : 'white';
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
  const [newTask, setNewTask] = useState<Omit<TaskDraft, 'taskId'>>(EMPTY_TASK);
  const [imageEditor, setImageEditor] = useState<{ productId: string; value: string } | null>(null);
  const [taskDescriptionEditor, setTaskDescriptionEditor] = useState<{ taskId: string; value: string } | null>(null);
  const [qrPrintStudents, setQrPrintStudents] = useState<StudentDraft[] | null>(null);
  const [currencyMode, setCurrencyMode] = useState<CurrencyMode>('add');
  const [currencyAmount, setCurrencyAmount] = useState(0);
  const [currencyScannerOpen, setCurrencyScannerOpen] = useState(false);
  const [currencyManualId, setCurrencyManualId] = useState('');
  const [currencyResult, setCurrencyResult] = useState<CurrencyResult | null>(null);
  const [currencyLoading, setCurrencyLoading] = useState(false);
  const [settings, setSettings] = useState<Settings>({ currencyUnit: '원', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white' });
  const [isInitialLoading, setIsInitialLoading] = useState(true);

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
      });
      setStudents(studentPayload);
      setProducts(productPayload);
      setTasks(taskPayload);
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

  function buildStudentPayload(list: StudentDraft[]) {
    return list.map((student) => ({ studentId: student.studentId, name: student.name, number: student.number, balance: student.balance, status: student.status }));
  }

  function buildProductPayload(list: ProductDraft[]) {
    return list.map((product) => ({ productId: product.productId, name: product.name, price: product.price, stock: product.stock, isActive: product.isActive, imageUrl: product.imageUrl ?? '', category: product.category ?? '', sortOrder: product.sortOrder }));
  }

  function buildTaskPayload(list: TaskDraft[]) {
    return list.map((task) => ({ taskId: task.taskId, title: task.title, description: task.description, reward: task.reward, maxCompletionsPerStudent: task.maxCompletionsPerStudent, isActive: task.isActive, sortOrder: task.sortOrder }));
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
      setStudents((current) => current.map((student) => savedMap.get(student.studentId) ?? student));
      notify(`${label} ${rows.length}명 저장 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '학생 명단을 저장하지 못했습니다.');
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
      setProducts((current) => current.map((product) => savedMap.get(product.productId) ?? product));
      notify(`${label} ${rows.length}개 저장 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '매점 목록을 저장하지 못했습니다.');
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
      setTasks((current) => current.map((task) => savedMap.get(task.taskId) ?? task).sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title)));
      notify(`${label} ${rows.length}개 저장 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '과제 목록을 저장하지 못했습니다.');
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

  async function applyCurrencyToStudent(decodedText: string) {
    const studentId = decodedText.trim();
    if (!studentId) return;
    setCurrencyScannerOpen(false);
    setCurrencyLoading(true);
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
    } finally {
      setCurrencyLoading(false);
    }
  }

  function retryCurrencyScan() {
    setCurrencyResult(null);
    setCurrencyManualId('');
    setCurrencyScannerOpen(true);
  }

  const currencyActionLabel = currencyMode === 'add' ? '지급' : '회수';
  const theme = ADMIN_THEME[settings.themeColor ?? 'white'] ?? ADMIN_THEME.white;

  if (isInitialLoading) {
    return <LoadingScreen title="시트 정보 불러오는 중" message="관리자 데이터와 테마 설정을 불러오는 중입니다." />;
  }

  return (
    <main data-testid="admin-shell" className={`min-h-screen ${theme.shell} ${theme.pageText} p-2 sm:p-3 lg:p-5`}>
      <section className="mx-auto flex w-full max-w-[1280px] flex-col gap-3 lg:gap-4">
        <header className="rounded-[1.25rem] border border-slate-300/70 bg-white px-4 py-4 text-center text-slate-950 shadow-sm sm:rounded-[1.75rem] md:px-6">
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <span className="inline-flex h-16 w-16 shrink-0 items-center justify-center">
              <span role="img" aria-label="학급 보상 시스템 로고" className={`h-16 w-16 ${theme.logoColor} [mask-image:url('/class-reward-system-icon.png')] [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain]`} />
            </span>
            <div>
              <p className={`text-xs font-black tracking-[0.22em] ${theme.accentText} sm:text-sm`}>Class Reward System</p>
              <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl md:text-5xl">학급 보상 시스템</h1>
            </div>
          </div>
          <p className="mx-auto mt-1 max-w-2xl text-xs font-bold text-slate-500 sm:text-sm md:text-base">
            태블릿과 스마트폰에서 빠르게 학생 잔액과 상품 재고를 관리합니다.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <SummaryCard label="학생" value={`${summary.students}명`} toneClass={theme.statBg} accentClass={theme.accentText} />
            <SummaryCard label="판매 상품" value={`${summary.activeProducts}개`} toneClass={theme.statBg} accentClass={theme.accentText} />
            <SummaryCard label="전체 재고" value={`${summary.totalStock}개`} toneClass={theme.statBg} accentClass={theme.accentText} />
            <SummaryCard label="활성 과제" value={`${summary.activeTasks}개`} toneClass={theme.statBg} accentClass={theme.accentText} />
          </div>
          {message ? <p className="mt-3 rounded-2xl bg-rose-100 p-3 text-sm font-bold text-rose-700">{message}</p> : null}
        </header>

        <nav data-testid="admin-tabs" role="tablist" aria-label="관리자 메뉴" className="grid grid-cols-2 gap-2 rounded-[1.5rem] border border-slate-300/70 bg-white/90 p-2 shadow-sm sm:grid-cols-4 lg:grid-cols-8">
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
          <section role="tabpanel" aria-label="시스템 설정" className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
            <SettingsForm
              linkedStudentCount={students.length}
              linkedProductCount={products.length}
              onSettingsSaved={() => loadLinkedSheetData({ silent: true })}
            />
            <InfoPanel />
          </section>
        ) : null}

        {activeTab === 'students' ? (
          <section role="tabpanel" aria-label="학생 관리" className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
            <SectionCard title="새 학생 추가" description="QR ID와 초기 잔액을 등록합니다." compact>
              <form onSubmit={createNewStudent} className="space-y-2">
                <TextInput label="새 학생 ID" value={newStudent.studentId} onChange={(value) => setNewStudent((current) => ({ ...current, studentId: value }))} compact />
                <TextInput label="새 학생 이름" value={newStudent.name} onChange={(value) => setNewStudent((current) => ({ ...current, name: value }))} compact />
                <div className="grid grid-cols-2 gap-2">
                  <NumberInput label="새 학생 번호" value={newStudent.number} onChange={(value) => setNewStudent((current) => ({ ...current, number: value }))} compact />
                  <NumberInput label="새 학생 잔액" value={newStudent.balance} onChange={(value) => setNewStudent((current) => ({ ...current, balance: value }))} compact />
                </div>
                <button className={`w-full rounded-xl ${theme.accentBg} py-3 font-black ${theme.actionText} shadow-sm`} type="submit">새 학생 추가</button>
              </form>
            </SectionCard>

            <SectionCard title="학생 명단" action={<button type="button" onClick={saveAllStudents} className={`rounded-xl ${theme.accentBg} px-4 py-2 text-sm font-black ${theme.actionText} shadow-sm`}>전체 저장</button>} compact>
              <div className={`mb-3 rounded-2xl border border-slate-200 ${theme.softBg} p-3`}>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-black">
                    <input aria-label="전체 학생 선택" checked={allStudentsSelected} onChange={(event) => setSelectedStudentIds(event.target.checked ? students.map((student) => student.studentId) : [])} type="checkbox" />
                    전체 선택 ({selectedStudentIds.length}/{students.length})
                  </label>
                  <select aria-label="선택 학생 작업" value={bulkMode} onChange={(event) => setBulkMode(event.target.value as BulkMode)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-950">
                    <option value="set">특정 값으로 설정</option>
                    <option value="add">금액 추가</option>
                    <option value="subtract">금액 제거</option>
                  </select>
                  <input aria-label="선택 학생 금액" value={bulkAmount} onChange={(event) => setBulkAmount(Number(event.target.value))} type="number" className="w-28 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-950" />
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
                    <p className={`min-w-0 truncate font-black ${theme.accentText}`}>{student.studentId}</p>
                    <TextInput dataTestId="student-name-field" label={`${student.studentId} 이름`} value={student.name} onChange={(value) => updateStudent(student.studentId, { name: value })} dense />
                    <NumberInput label={`${student.studentId} 번호`} value={student.number} onChange={(value) => updateStudent(student.studentId, { number: value })} dense />
                    <NumberInput label={`${student.studentId} 잔액`} value={student.balance} onChange={(value) => updateStudent(student.studentId, { balance: value })} dense />
                    <label className="block min-w-0 text-xs font-bold text-slate-700">
                      <span className="sr-only">상태</span>
                      <select aria-label={`${student.studentId} 상태`} className="h-8 w-full rounded-lg border border-slate-200 bg-white px-1 text-xs text-slate-950" onChange={(event) => updateStudent(student.studentId, { status: event.target.value as Student['status'] })} value={student.status}>
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
          <section role="tabpanel" aria-label="매점 관리" className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
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

            <SectionCard title="상품 · 재고 관리" action={<button type="button" onClick={saveAllProducts} className={`rounded-xl ${theme.accentBg} px-4 py-2 text-sm font-black ${theme.actionText} shadow-sm`}>전체 저장</button>} compact>
              <div className={`mb-3 rounded-2xl border border-slate-200 ${theme.softBg} p-3`}>
                <label className="flex w-fit items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-black">
                  <input aria-label="전체 상품 선택" checked={allProductsSelected} onChange={(event) => setSelectedProductIds(event.target.checked ? products.map((product) => product.productId) : [])} type="checkbox" />
                  전체 선택 ({selectedProductIds.length}/{products.length})
                </label>
                <button type="button" disabled={selectedProductIds.length === 0} onClick={deleteSelectedProducts} className={`mt-2 rounded-xl bg-rose-500 px-4 py-2 text-sm font-black text-white ${disabledActionClass}`}>삭제</button>
                <button type="button" disabled={selectedProductIds.length === 0} onClick={saveSelectedProducts} className={`ml-2 mt-2 rounded-xl ${theme.accentBg} px-4 py-2 text-sm font-black ${theme.actionText} ${disabledActionClass}`}>선택 저장</button>
              </div>
              <div data-testid="product-list" className="overflow-hidden rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100">
                <div data-testid="product-header-row" className="grid grid-cols-[24px_minmax(3rem,1fr)_56px_48px_36px_minmax(3rem,0.8fr)_40px_30px_34px] items-center gap-0.5 bg-slate-100 px-1.5 py-1 text-[10px] font-black text-slate-500">
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
                      className="h-8 min-w-0 truncate rounded-lg border border-slate-200 bg-white px-1 text-left text-[10px] font-bold text-slate-600"
                      onClick={() => setImageEditor({ productId: product.productId, value: product.imageUrl ?? '' })}
                      type="button"
                    >
                      {product.imageUrl ? 'URL' : '이미지'}
                    </button>
                    <NumberInput label={`${product.productId} 정렬`} value={product.sortOrder} onChange={(value) => updateProduct(product.productId, { sortOrder: value })} dense />
                    <label className={`flex h-8 items-center justify-center rounded-lg ${theme.softBg} text-[10px] font-bold ${theme.softText}`}>
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
                <TextInput label="새 과제명" value={newTask.title} onChange={(value) => setNewTask((current) => ({ ...current, title: value }))} compact />
                <label className="block text-xs font-bold text-slate-700">
                  <span>새 과제 설명</span>
                  <textarea aria-label="새 과제 설명" value={newTask.description} onChange={(event) => setNewTask((current) => ({ ...current, description: event.target.value }))} className="mt-1 min-h-24 w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm text-slate-950 outline-none transition focus:border-slate-300" />
                </label>
                <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3">
                  <NumberInput label="새 과제 보상" value={newTask.reward} onChange={(value) => setNewTask((current) => ({ ...current, reward: value }))} compact />
                  <NumberInput label="새 과제 완료 가능 횟수" value={newTask.maxCompletionsPerStudent} onChange={(value) => setNewTask((current) => ({ ...current, maxCompletionsPerStudent: value }))} compact />
                  <NumberInput label="새 과제 정렬" value={newTask.sortOrder} onChange={(value) => setNewTask((current) => ({ ...current, sortOrder: value }))} compact />
                </div>
                <label className={`flex items-center gap-2 rounded-xl ${theme.softBg} px-3 py-2 text-sm font-black ${theme.softText}`}>
                  <input aria-label="새 과제 활성" checked={newTask.isActive} onChange={(event) => setNewTask((current) => ({ ...current, isActive: event.target.checked }))} type="checkbox" />
                  은행 페이지에 표시
                </label>
                <button className={`w-full rounded-xl ${theme.accentBg} py-3 font-black ${theme.actionText} shadow-sm`} type="submit">새 과제 추가</button>
              </form>
            </SectionCard>
            </div>

            <div data-testid="task-list-card" className="min-w-0">
            <SectionCard title="과제 설정" action={<button type="button" onClick={saveAllTasks} className={`rounded-xl ${theme.accentBg} px-4 py-2 text-sm font-black ${theme.actionText} shadow-sm`}>전체 저장</button>} compact>
              <div className={`mb-3 rounded-2xl border border-slate-200 ${theme.softBg} p-3`}>
                <div data-testid="task-bulk-actions" className="flex flex-wrap items-center gap-2">
                <label className="flex w-fit items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-black">
                  <input aria-label="전체 과제 선택" checked={allTasksSelected} onChange={(event) => setSelectedTaskIds(event.target.checked ? tasks.map((task) => task.taskId) : [])} type="checkbox" />
                  전체 선택 ({selectedTaskIds.length}/{tasks.length})
                </label>
                <button type="button" disabled={selectedTaskIds.length === 0} onClick={deleteSelectedTasks} className={`rounded-xl bg-rose-500 px-4 py-2 text-sm font-black text-white ${disabledActionClass}`}>삭제</button>
                <button type="button" disabled={selectedTaskIds.length === 0} onClick={() => resetTaskCompletions([...selectedTaskIds], `선택 과제 ${selectedTaskIds.length}개`)} className={`rounded-xl bg-amber-300 px-4 py-2 text-sm font-black text-amber-950 ${disabledActionClass}`}>초기화</button>
                <button type="button" disabled={selectedTaskIds.length === 0} onClick={saveSelectedTasks} className={`rounded-xl ${theme.accentBg} px-4 py-2 text-sm font-black ${theme.actionText} ${disabledActionClass}`}>선택 저장</button>
                </div>
              </div>
              <div data-testid="task-list-scroll" className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
                <div className="min-w-[540px] divide-y divide-slate-100">
                <div data-testid="task-header-row" className="grid grid-cols-[24px_minmax(5rem,1fr)_64px_64px_48px_38px_minmax(3rem,0.7fr)_46px_40px] items-center gap-0.5 bg-slate-100 px-1.5 py-1 text-[10px] font-black text-slate-500">
                  <span>선택</span><span>과제명</span><span>보상</span><span>횟수</span><span>순서</span><span>활성</span><span>상세</span><span>초기화</span><span>삭제</span>
                </div>
                {tasks.map((task) => (
                  <div data-testid="task-row" key={task.taskId} className="grid grid-cols-[24px_minmax(5rem,1fr)_64px_64px_48px_38px_minmax(3rem,0.7fr)_46px_40px] items-center gap-0.5 px-1.5 py-1 text-[11px]">
                    <label className="flex items-center justify-center">
                      <input aria-label={`${task.taskId} 선택`} checked={selectedTaskIds.includes(task.taskId)} onChange={() => toggleTask(task.taskId)} type="checkbox" />
                      <span className="sr-only">선택</span>
                    </label>
                    <TextInput label={`${task.taskId} 과제명`} value={task.title} onChange={(value) => updateTask(task.taskId, { title: value })} dense />
                    <NumberInput label={`${task.taskId} 보상`} value={task.reward} onChange={(value) => updateTask(task.taskId, { reward: value })} dense />
                    <NumberInput label={`${task.taskId} 완료 가능 횟수`} value={task.maxCompletionsPerStudent} onChange={(value) => updateTask(task.taskId, { maxCompletionsPerStudent: value })} dense />
                    <NumberInput label={`${task.taskId} 정렬`} value={task.sortOrder} onChange={(value) => updateTask(task.taskId, { sortOrder: value })} dense />
                    <label className={`flex h-8 items-center justify-center rounded-lg ${theme.softBg} text-[10px] font-bold ${theme.softText}`}>
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

        <section role="tabpanel" aria-label="거래 내역 확인" hidden={activeTab !== 'transactions'}>
          <TransactionsPanel embedded summaryToneClass={theme.statBg} summaryAccentClass={theme.accentText} />
        </section>

        {activeTab === 'currency' ? (
          <section role="tabpanel" aria-label="화폐 지급/회수" className="mx-auto w-full max-w-xl">
            <SectionCard title="화폐 지급/회수" description="금액과 지급/회수만 정한 뒤 학생 QR을 찍으면 바로 반영됩니다." compact>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setCurrencyMode('add')} className={`rounded-2xl px-4 py-4 text-xl font-black ${currencyMode === 'add' ? `${theme.accentBg} ${theme.actionText}` : `${theme.softBg} ${theme.softText}`}`}>지급</button>
                <button type="button" onClick={() => setCurrencyMode('subtract')} className={`rounded-2xl px-4 py-4 text-xl font-black ${currencyMode === 'subtract' ? 'bg-rose-500 text-white' : 'bg-rose-50 text-slate-700'}`}>회수</button>
              </div>
              <label className="mt-3 block text-sm font-black text-slate-700">
                <span>금액</span>
                <input aria-label="지급/회수 금액" value={currencyAmount} onChange={(event) => setCurrencyAmount(Number(event.target.value))} type="number" min="0" className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-4 text-2xl font-black text-slate-950 outline-none focus:border-slate-300" />
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
                className="mt-2 min-h-32 w-full rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-950 outline-none focus:border-slate-300"
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
                이미지 주소 적용
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {qrPrintStudents ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 print:hidden">
          <section role="dialog" aria-modal="true" aria-label="선택 학생 QR 발급" className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl bg-white p-4 shadow-2xl">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-xl font-black">선택 학생 QR 발급</h2>
                <p className="mt-1 text-sm font-bold text-slate-500">선택한 학생 {qrPrintStudents.length}명의 QR만 출력합니다.</p>
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
      {taskDescriptionEditor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-label="과제 상세 설정 편집" className="w-full max-w-xl rounded-2xl bg-white p-4 shadow-2xl">
            <h2 className="text-xl font-black">과제 상세 설정 편집</h2>
            <p className="mt-1 text-sm font-bold text-slate-500">긴 설명은 여기에서 편하게 입력하고 수정합니다.</p>
            <label className="mt-4 block text-sm font-bold text-slate-700">
              <span>과제 상세 설정 전체 입력</span>
              <textarea
                aria-label="과제 상세 설정 전체 입력"
                className="mt-2 min-h-40 w-full rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-950 outline-none focus:border-slate-300"
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
          <section role="dialog" aria-modal="true" aria-label="학생 QR 인식" className="w-full max-w-xl rounded-2xl bg-white p-4 shadow-2xl">
            <h2 className="text-xl font-black">학생 QR 인식</h2>
            <p className="mt-1 text-sm font-bold text-slate-500">{currencyAmount} {currencyActionLabel}할 학생 QR을 인식합니다.</p>
            <div className="mt-4 flex justify-center">
              <QrScanner onScan={applyCurrencyToStudent} />
            </div>
            <label className="mt-4 block text-sm font-bold text-slate-700">
              <span>학생 QR 직접 입력</span>
              <input aria-label="학생 QR 직접 입력" value={currencyManualId} onChange={(event) => setCurrencyManualId(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-950 outline-none focus:border-slate-300" placeholder="S001" />
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
          <section role="dialog" aria-modal="true" aria-label={`화폐 ${currencyResult.mode === 'add' ? '지급' : '회수'} ${currencyResult.status === 'success' ? '성공' : '실패'}`} className="w-full max-w-md rounded-2xl bg-white p-5 text-center shadow-2xl">
            <h2 className={`text-2xl font-black ${currencyResult.status === 'success' ? theme.accentText : 'text-rose-700'}`}>화폐 {currencyResult.mode === 'add' ? '지급' : '회수'} {currencyResult.status === 'success' ? '성공' : '실패'}</h2>
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

function LoadingScreen({ title, message }: { title: string; message: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4 text-slate-950">
      <section role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-2xl">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-slate-200 border-t-slate-950" aria-hidden="true" />
        <h1 className="mt-4 text-2xl font-black">{title}</h1>
        <p className="mt-2 rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-600">{message}</p>
      </section>
    </main>
  );
}

function LoadingDialog({ title, message }: { title: string; message: string }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <section role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-2xl">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-slate-200 border-t-sky-500" aria-hidden="true" />
        <h2 className="mt-4 text-2xl font-black">{title}</h2>
        <p className="mt-2 rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-600">{message}</p>
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
    <article className="break-inside-avoid rounded-3xl border-2 border-slate-200 bg-white p-5 text-center shadow-sm print:rounded-2xl print:border print:p-4 print:shadow-none">
      <div className="mx-auto mb-4 flex h-48 w-48 items-center justify-center rounded-3xl border border-slate-100 bg-white p-3 print:h-40 print:w-40">
        <img alt={`${student.name} QR 코드`} className="h-full w-full" src={`/api/qrcode?value=${encodeURIComponent(student.studentId)}`} />
      </div>
      <h3 className="text-2xl font-black">{student.name}</h3>
      <p className="mt-1 text-lg font-bold text-slate-600">{student.number}번 · {student.studentId}</p>
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
      <p className="text-[11px] font-black text-slate-500 sm:text-xs">{label}</p>
      <p className={`mt-1 text-xl font-black ${accentClass} sm:text-2xl`}>{value}</p>
    </div>
  );
}

function SectionCard({ title, description, action, children, compact = false }: { title: string; description?: string; action?: ReactNode; children: ReactNode; compact?: boolean }) {
  return (
    <section className={`min-w-0 overflow-hidden rounded-[1.25rem] border border-slate-300/70 bg-white/90 text-slate-950 shadow-sm sm:rounded-[1.75rem] ${compact ? 'p-3 md:p-4' : 'p-4 md:p-5'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-black text-slate-950 sm:text-2xl">{title}</h2>
        {action}
      </div>
      {description ? <p className="mt-1 text-xs font-bold text-slate-500 sm:text-sm">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function TextInput({ label, value, onChange, compact = false, dense = false, dataTestId }: { label: string; value: string; onChange: (value: string) => void; compact?: boolean; dense?: boolean; dataTestId?: string }) {
  const visibleLabel = label.replace(/^새 |^[SP]\d+ /, '');
  const inputClass = dense
    ? 'h-8 w-full rounded-lg border border-slate-200 bg-white px-1 text-[11px] text-slate-950 outline-none transition focus:border-slate-300'
    : `mt-1 w-full rounded-xl border border-slate-200 bg-white px-2 text-slate-950 outline-none transition focus:border-slate-300 ${compact ? 'py-2 text-sm' : 'py-3'}`;

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
    ? 'h-8 w-full rounded-lg border border-slate-200 bg-white px-1 text-[11px] text-slate-950 outline-none transition focus:border-slate-300'
    : `mt-1 w-full rounded-xl border border-slate-200 bg-white px-2 text-slate-950 outline-none transition focus:border-slate-300 ${compact ? 'py-2 text-sm' : 'py-3'}`;

  return (
    <label className="block min-w-0 text-xs font-bold text-slate-700">
      <span className={dense ? 'sr-only' : undefined}>{visibleLabel}</span>
      <input aria-label={label} className={inputClass} onChange={(event) => onChange(Number(event.target.value))} type="number" value={value} />
    </label>
  );
}

function InfoPanel() {
  return (
    <aside className="rounded-[1.25rem] border border-slate-300/70 bg-white/90 p-4 text-slate-950 shadow-sm sm:rounded-[1.75rem] md:p-5">
      <h2 className="text-xl font-black text-slate-950 sm:text-2xl">사용 전 확인</h2>
      <ul className="mt-3 space-y-2 text-sm font-bold text-slate-600">
        <li>• Students, Products, Transactions, Adjustments 시트가 필요합니다.</li>
        <li>• Google 로그인 계정 또는 서비스 계정에 스프레드시트 편집 권한이 필요합니다.</li>
        <li>• QR 코드에는 이름이 아니라 S001 같은 studentId만 넣습니다.</li>
      </ul>
    </aside>
  );
}
