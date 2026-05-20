'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import type { Product, Student } from '@/domain/types';
import { SettingsForm } from './SettingsForm';

type StudentDraft = Student;
type ProductDraft = Product;
type SaveState = Record<string, string>;
type AdminTab = 'settings' | 'students' | 'products';
type BulkMode = 'set' | 'add' | 'subtract';

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
  category: string;
  sortOrder: number;
};

const EMPTY_STUDENT: NewStudentDraft = { studentId: '', name: '', number: 1, balance: 0, status: 'ACTIVE' };
const EMPTY_PRODUCT: NewProductDraft = { productId: '', name: '', price: 0, stock: 0, isActive: true, category: '', sortOrder: 1 };

const tabs: Array<{ id: AdminTab; label: string; description: string }> = [
  { id: 'settings', label: '시트 설정', description: 'Google Sheets 연결' },
  { id: 'students', label: '학생 명단', description: '잔액과 상태 관리' },
  { id: 'products', label: '재고 관리', description: '상품과 가격 관리' },
];

export function AdminManagePage() {
  const [activeTab, setActiveTab] = useState<AdminTab>('settings');
  const [students, setStudents] = useState<StudentDraft[]>([]);
  const [products, setProducts] = useState<ProductDraft[]>([]);
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [bulkMode, setBulkMode] = useState<BulkMode>('set');
  const [bulkAmount, setBulkAmount] = useState(0);
  const [message, setMessage] = useState('학생/상품 목록을 불러오는 중입니다.');
  const [saveState, setSaveState] = useState<SaveState>({});
  const [newStudent, setNewStudent] = useState<NewStudentDraft>(EMPTY_STUDENT);
  const [newProduct, setNewProduct] = useState<NewProductDraft>(EMPTY_PRODUCT);
  const [createMessages, addCreateMessages] = useState<string[]>([]);

  const loadLinkedSheetData = useCallback(async (options: { silent?: boolean; shouldApply?: () => boolean } = {}) => {
    const shouldApply = options.shouldApply ?? (() => true);

    if (!options.silent && shouldApply()) setMessage('학생/상품 목록을 불러오는 중입니다.');

    try {
      const [studentResponse, productResponse] = await Promise.all([
        fetch('/api/students', { cache: 'no-store' }),
        fetch('/api/products?includeInactive=1', { cache: 'no-store' }),
      ]);
      const [studentPayload, productPayload] = await Promise.all([studentResponse.json(), productResponse.json()]);

      if (!studentResponse.ok) throw new Error(studentPayload.error ?? '학생 목록을 불러오지 못했습니다.');
      if (!productResponse.ok) throw new Error(productPayload.error ?? '상품 목록을 불러오지 못했습니다.');

      if (!shouldApply()) return;
      setStudents(studentPayload);
      setProducts(productPayload);
      setSelectedStudentIds((ids) => ids.filter((id) => studentPayload.some((student: Student) => student.studentId === id)));
      setSelectedProductIds((ids) => ids.filter((id) => productPayload.some((product: Product) => product.productId === id)));
      setMessage('');
    } catch (error) {
      if (!shouldApply()) return;
      setStudents([]);
      setProducts([]);
      setMessage(error instanceof Error ? error.message : '목록을 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    let ignore = false;

    loadLinkedSheetData({ shouldApply: () => !ignore });

    return () => {
      ignore = true;
    };
  }, [loadLinkedSheetData]);

  const summary = useMemo(() => {
    const activeProducts = products.filter((product) => product.isActive).length;
    const totalStock = products.reduce((sum, product) => sum + product.stock, 0);
    return { students: students.length, activeProducts, totalStock };
  }, [products, students]);

  const allStudentsSelected = students.length > 0 && selectedStudentIds.length === students.length;
  const allProductsSelected = products.length > 0 && selectedProductIds.length === products.length;

  function updateStudent(studentId: string, patch: Partial<StudentDraft>) {
    setStudents((current) => current.map((student) => (student.studentId === studentId ? { ...student, ...patch } : student)));
  }

  function updateProduct(productId: string, patch: Partial<ProductDraft>) {
    setProducts((current) => current.map((product) => (product.productId === productId ? { ...product, ...patch } : product)));
  }

  function addCreateMessage(messageText: string) {
    addCreateMessages((current) => [...current, messageText].slice(-4));
  }

  function toggleStudent(studentId: string) {
    setSelectedStudentIds((current) => current.includes(studentId) ? current.filter((id) => id !== studentId) : [...current, studentId]);
  }

  function toggleProduct(productId: string) {
    setSelectedProductIds((current) => current.includes(productId) ? current.filter((id) => id !== productId) : [...current, productId]);
  }

  async function saveStudent(student: StudentDraft) {
    setSaveState((current) => ({ ...current, [student.studentId]: '저장 중...' }));
    try {
      const body = { name: student.name, number: student.number, balance: student.balance, status: student.status };
      const response = await fetch(`/api/students/${encodeURIComponent(student.studentId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '학생 정보를 저장하지 못했습니다.');
      updateStudent(student.studentId, payload);
      setSaveState((current) => ({ ...current, [student.studentId]: `${student.studentId} 저장 완료` }));
    } catch (error) {
      setSaveState((current) => ({ ...current, [student.studentId]: error instanceof Error ? error.message : '학생 정보를 저장하지 못했습니다.' }));
    }
  }

  async function deleteStudentRow(studentId: string) {
    setSaveState((current) => ({ ...current, [studentId]: '삭제 중...' }));
    try {
      const response = await fetch(`/api/students/${encodeURIComponent(studentId)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '학생을 삭제하지 못했습니다.');
      setStudents((current) => current.filter((student) => student.studentId !== studentId));
      setSelectedStudentIds((current) => current.filter((id) => id !== studentId));
      setSaveState((current) => ({ ...current, [studentId]: `${studentId} 삭제 완료` }));
    } catch (error) {
      setSaveState((current) => ({ ...current, [studentId]: error instanceof Error ? error.message : '학생을 삭제하지 못했습니다.' }));
    }
  }

  async function applyBulkStudentBalance() {
    if (selectedStudentIds.length === 0) {
      addCreateMessage('선택된 학생이 없습니다.');
      return;
    }
    addCreateMessage('선택 학생 재화 수정 중...');
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
      addCreateMessage(`선택 학생 ${payload.length}명 수정 완료`);
    } catch (error) {
      addCreateMessage(error instanceof Error ? error.message : '선택 학생 재화를 수정하지 못했습니다.');
    }
  }

  async function saveProduct(product: ProductDraft) {
    setSaveState((current) => ({ ...current, [product.productId]: '저장 중...' }));
    try {
      const body = {
        name: product.name,
        price: product.price,
        stock: product.stock,
        isActive: product.isActive,
        category: product.category ?? '',
        sortOrder: product.sortOrder,
      };
      const response = await fetch(`/api/products/${encodeURIComponent(product.productId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '상품 정보를 저장하지 못했습니다.');
      updateProduct(product.productId, payload);
      setSaveState((current) => ({ ...current, [product.productId]: `${product.productId} 저장 완료` }));
    } catch (error) {
      setSaveState((current) => ({ ...current, [product.productId]: error instanceof Error ? error.message : '상품 정보를 저장하지 못했습니다.' }));
    }
  }

  async function deleteProductRow(productId: string) {
    setSaveState((current) => ({ ...current, [productId]: '삭제 중...' }));
    try {
      const response = await fetch(`/api/products/${encodeURIComponent(productId)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '상품을 삭제하지 못했습니다.');
      setProducts((current) => current.filter((product) => product.productId !== productId));
      setSelectedProductIds((current) => current.filter((id) => id !== productId));
      setSaveState((current) => ({ ...current, [productId]: `${productId} 삭제 완료` }));
    } catch (error) {
      setSaveState((current) => ({ ...current, [productId]: error instanceof Error ? error.message : '상품을 삭제하지 못했습니다.' }));
    }
  }

  async function createNewStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    addCreateMessage('학생 추가 중...');
    try {
      const body = { studentId: newStudent.studentId, name: newStudent.name, number: newStudent.number, balance: newStudent.balance, status: newStudent.status };
      const response = await fetch('/api/students', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '학생을 추가하지 못했습니다.');
      setStudents((current) => [...current, payload].sort((a, b) => a.number - b.number || a.name.localeCompare(b.name)));
      setNewStudent(EMPTY_STUDENT);
      addCreateMessage(`${payload.studentId} 추가 완료`);
    } catch (error) {
      addCreateMessage(error instanceof Error ? error.message : '학생을 추가하지 못했습니다.');
    }
  }

  async function createNewProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    addCreateMessage('상품 추가 중...');
    try {
      const body = {
        productId: newProduct.productId,
        name: newProduct.name,
        price: newProduct.price,
        stock: newProduct.stock,
        isActive: newProduct.isActive,
        category: newProduct.category,
        sortOrder: newProduct.sortOrder,
      };
      const response = await fetch('/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '상품을 추가하지 못했습니다.');
      setProducts((current) => [...current, payload].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)));
      setNewProduct(EMPTY_PRODUCT);
      addCreateMessage(`${payload.productId} 추가 완료`);
    } catch (error) {
      addCreateMessage(error instanceof Error ? error.message : '상품을 추가하지 못했습니다.');
    }
  }

  return (
    <main data-testid="admin-shell" className="min-h-screen bg-[#dbeaf6] p-2 text-slate-950 sm:p-3 lg:p-5">
      <section className="mx-auto flex w-full max-w-[1280px] flex-col gap-3 lg:gap-4">
        <header className="rounded-[1.25rem] border border-slate-300/70 bg-white px-4 py-4 text-center shadow-sm sm:rounded-[1.75rem] md:px-6">
          <p className="text-xs font-black tracking-[0.22em] text-sky-600 sm:text-sm">CLASS STORE ADMIN</p>
          <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl md:text-5xl">관리자 센터</h1>
          <p className="mx-auto mt-1 max-w-2xl text-xs font-bold text-slate-500 sm:text-sm md:text-base">
            태블릿과 스마트폰에서 빠르게 학생 잔액과 상품 재고를 관리합니다.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <SummaryCard label="학생" value={`${summary.students}명`} />
            <SummaryCard label="판매 상품" value={`${summary.activeProducts}개`} />
            <SummaryCard label="전체 재고" value={`${summary.totalStock}개`} />
          </div>
          {message ? <p className="mt-3 rounded-2xl bg-rose-100 p-3 text-sm font-bold text-rose-700">{message}</p> : null}
        </header>

        <section aria-label="관리자 바로가기" className="grid grid-cols-2 gap-2 rounded-[1.25rem] border border-slate-300/70 bg-white/90 p-2 shadow-sm">
          <AdminLink href="/admin/student-qrs" title="학생 QR 출력" description="학생별 QR 카드" />
          <AdminLink href="/admin/transactions" title="결제 내역 확인" description="거래 기록 확인" />
        </section>

        <nav data-testid="admin-tabs" role="tablist" aria-label="관리자 메뉴" className="grid grid-cols-3 gap-2 rounded-[1.5rem] border border-slate-300/70 bg-white/90 p-2 shadow-sm">
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
                className={`rounded-[1rem] px-3 py-3 text-left transition ${selected ? 'bg-sky-500 text-white shadow-sm' : 'bg-sky-50 text-slate-700 hover:bg-sky-100'}`}
              >
                <span className="block text-base font-black sm:text-lg">{tab.label}</span>
                <span className={`mt-0.5 hidden text-xs font-bold sm:block ${selected ? 'text-sky-50' : 'text-slate-500'}`}>{tab.description}</span>
              </button>
            );
          })}
        </nav>

        {createMessages.length > 0 ? (
          <div className="space-y-2">
            {createMessages.map((item, index) => (
              <p className="rounded-2xl bg-sky-100 p-3 text-sm font-bold text-sky-900" key={`${item}-${index}`}>
                {item}
              </p>
            ))}
          </div>
        ) : null}

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
                  <button type="button" onClick={applyBulkStudentBalance} className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-black text-white">선택 학생 재화 적용</button>
                </div>
              </div>

              <div data-testid="student-list" className="overflow-hidden rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100">
                {students.map((student) => (
                  <div className="grid gap-2 px-3 py-2 md:grid-cols-[32px_86px_minmax(110px,1fr)_74px_110px_96px_88px_70px] md:items-center" key={student.studentId}>
                    <label className="flex items-center gap-2 text-sm font-black md:justify-center">
                      <input aria-label={`${student.studentId} 선택`} checked={selectedStudentIds.includes(student.studentId)} onChange={() => toggleStudent(student.studentId)} type="checkbox" />
                      <span className="md:hidden">선택</span>
                    </label>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black text-sky-700">{student.studentId}</p>
                      <p className="text-xs font-bold text-slate-500 md:hidden">{student.number}번 · {student.name}</p>
                    </div>
                    <TextInput label={`${student.studentId} 이름`} value={student.name} onChange={(value) => updateStudent(student.studentId, { name: value })} compact />
                    <NumberInput label={`${student.studentId} 번호`} value={student.number} onChange={(value) => updateStudent(student.studentId, { number: value })} compact />
                    <NumberInput label={`${student.studentId} 잔액`} value={student.balance} onChange={(value) => updateStudent(student.studentId, { balance: value })} compact />
                    <label className="block text-xs font-bold text-slate-700">
                      <span className="md:sr-only">상태</span>
                      <select aria-label={`${student.studentId} 상태`} className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm" onChange={(event) => updateStudent(student.studentId, { status: event.target.value as Student['status'] })} value={student.status}>
                        <option value="ACTIVE">활성</option>
                        <option value="INACTIVE">비활성</option>
                      </select>
                    </label>
                    <button aria-label={`${student.studentId} 학생 저장`} className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-black text-white" onClick={() => saveStudent(student)} type="button">
                      저장
                    </button>
                    <button className="rounded-xl bg-rose-100 px-3 py-2 text-sm font-black text-rose-700" onClick={() => deleteStudentRow(student.studentId)} type="button">
                      {student.studentId} 삭제
                    </button>
                    {saveState[student.studentId] ? <p className="text-xs font-bold text-sky-700 md:col-span-8 md:col-start-2">{saveState[student.studentId]}</p> : null}
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
              </div>
              <div data-testid="product-list" className="overflow-hidden rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100">
                {products.map((product) => (
                  <div className="grid gap-2 px-3 py-2 md:grid-cols-[32px_82px_minmax(120px,1fr)_92px_82px_96px_70px_76px_70px] md:items-center" key={product.productId}>
                    <label className="flex items-center gap-2 text-sm font-black md:justify-center">
                      <input aria-label={`${product.productId} 선택`} checked={selectedProductIds.includes(product.productId)} onChange={() => toggleProduct(product.productId)} type="checkbox" />
                      <span className="md:hidden">선택</span>
                    </label>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black text-sky-700">{product.productId}</p>
                      <p className="text-xs font-bold text-slate-500 md:hidden">{product.name} · 재고 {product.stock}</p>
                    </div>
                    <TextInput label={`${product.productId} 상품명`} value={product.name} onChange={(value) => updateProduct(product.productId, { name: value })} compact />
                    <NumberInput label={`${product.productId} 가격`} value={product.price} onChange={(value) => updateProduct(product.productId, { price: value })} compact />
                    <NumberInput label={`${product.productId} 재고`} value={product.stock} onChange={(value) => updateProduct(product.productId, { stock: value })} compact />
                    <TextInput label={`${product.productId} 카테고리`} value={product.category ?? ''} onChange={(value) => updateProduct(product.productId, { category: value })} compact />
                    <NumberInput label={`${product.productId} 정렬`} value={product.sortOrder} onChange={(value) => updateProduct(product.productId, { sortOrder: value })} compact />
                    <label className="flex items-center justify-center gap-2 rounded-xl bg-sky-50 px-2 py-2 text-sm font-bold text-slate-700">
                      <input aria-label={`${product.productId} 판매중`} checked={product.isActive} onChange={(event) => updateProduct(product.productId, { isActive: event.target.checked })} type="checkbox" />
                      판매
                    </label>
                    <button aria-label={`${product.productId} 상품 저장`} className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-black text-white" onClick={() => saveProduct(product)} type="button">
                      저장
                    </button>
                    <button className="rounded-xl bg-rose-100 px-3 py-2 text-sm font-black text-rose-700 md:col-start-9" onClick={() => deleteProductRow(product.productId)} type="button">
                      {product.productId} 삭제
                    </button>
                    {saveState[product.productId] ? <p className="text-xs font-bold text-sky-700 md:col-span-8 md:col-start-2">{saveState[product.productId]}</p> : null}
                  </div>
                ))}
              </div>
            </SectionCard>
          </section>
        ) : null}
      </section>
    </main>
  );
}

function AdminLink({ href, title, description }: { href: string; title: string; description: string }) {
  return (
    <Link className="rounded-[1rem] bg-sky-50 px-3 py-3 text-left text-slate-700 transition hover:bg-sky-100" href={href}>
      <span className="block text-base font-black sm:text-lg">{title}</span>
      <span className="mt-0.5 block text-xs font-bold text-slate-500">{description}</span>
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
    <section className={`rounded-[1.25rem] border border-slate-300/70 bg-white/90 shadow-sm sm:rounded-[1.75rem] ${compact ? 'p-3 md:p-4' : 'p-4 md:p-5'}`}>
      <h2 className="text-xl font-black sm:text-2xl">{title}</h2>
      <p className="mt-1 text-xs font-bold text-slate-500 sm:text-sm">{description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function TextInput({ label, value, onChange, compact = false }: { label: string; value: string; onChange: (value: string) => void; compact?: boolean }) {
  return (
    <label className="block text-xs font-bold text-slate-700">
      <span>{label.replace(/^새 |^[SP]\d+ /, '')}</span>
      <input aria-label={label} className={`mt-1 w-full rounded-xl border border-slate-200 bg-white px-2 outline-none transition focus:border-sky-400 ${compact ? 'py-2 text-sm' : 'py-3'}`} onChange={(event) => onChange(event.target.value)} value={value} />
    </label>
  );
}

function NumberInput({ label, value, onChange, compact = false }: { label: string; value: number; onChange: (value: number) => void; compact?: boolean }) {
  return (
    <label className="block text-xs font-bold text-slate-700">
      <span>{label.replace(/^새 |^[SP]\d+ /, '')}</span>
      <input aria-label={label} className={`mt-1 w-full rounded-xl border border-slate-200 bg-white px-2 outline-none transition focus:border-sky-400 ${compact ? 'py-2 text-sm' : 'py-3'}`} onChange={(event) => onChange(Number(event.target.value))} type="number" value={value} />
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
