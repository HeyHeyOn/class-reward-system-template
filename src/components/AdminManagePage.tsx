'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import type { Product, Student } from '@/domain/types';
import { SettingsForm } from './SettingsForm';

type StudentDraft = Student;
type ProductDraft = Product;
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
  imageUrl: string;
  category: string;
  sortOrder: number;
};

const EMPTY_STUDENT: NewStudentDraft = { studentId: '', name: '', number: 1, balance: 0, status: 'ACTIVE' };
const EMPTY_PRODUCT: NewProductDraft = { productId: '', name: '', price: 0, stock: 0, isActive: true, imageUrl: '', category: '', sortOrder: 1 };

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
  const [newStudent, setNewStudent] = useState<NewStudentDraft>(EMPTY_STUDENT);
  const [newProduct, setNewProduct] = useState<NewProductDraft>(EMPTY_PRODUCT);
  const [imageEditor, setImageEditor] = useState<{ productId: string; value: string } | null>(null);

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

    void Promise.resolve().then(() => loadLinkedSheetData({ shouldApply: () => !ignore }));

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

  function notify(messageText: string) {
    window.alert(messageText);
  }

  function toggleStudent(studentId: string) {
    setSelectedStudentIds((current) => current.includes(studentId) ? current.filter((id) => id !== studentId) : [...current, studentId]);
  }

  function toggleProduct(productId: string) {
    setSelectedProductIds((current) => current.includes(productId) ? current.filter((id) => id !== productId) : [...current, productId]);
  }

  async function saveStudent(student: StudentDraft) {
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
      notify(`${student.studentId} 저장 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '학생 정보를 저장하지 못했습니다.');
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
    const count = selectedStudentIds.length;
    for (const studentId of selectedStudentIds) {
      await deleteStudentRow(studentId, { silent: true });
    }
    notify(`선택 학생 ${count}명 삭제 완료`);
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

  async function saveProduct(product: ProductDraft) {
    try {
      const body = {
        name: product.name,
        price: product.price,
        stock: product.stock,
        isActive: product.isActive,
        imageUrl: product.imageUrl ?? '',
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
      notify(`${product.productId} 저장 완료`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '상품 정보를 저장하지 못했습니다.');
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
    const count = selectedProductIds.length;
    for (const productId of selectedProductIds) {
      await deleteProductRow(productId, { silent: true });
    }
    notify(`선택 상품 ${count}개 삭제 완료`);
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

        <nav data-testid="admin-tabs" role="tablist" aria-label="관리자 메뉴" className="grid grid-cols-3 gap-2 rounded-[1.5rem] border border-slate-300/70 bg-white/90 p-2 shadow-sm sm:grid-cols-6">
          <AdminNavLink href="/" title="매점 바로가기" description="키오스크" />
          <AdminNavLink href="/admin/student-qrs" title="학생 QR 출력" description="QR 카드" />
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
                  <button type="button" onClick={applyBulkStudentBalance} className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-black text-white">선택 학생 재화 적용</button>
                  <button type="button" onClick={deleteSelectedStudents} className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-black text-white">선택 학생 삭제</button>
                </div>
              </div>

              <div data-testid="student-list" className="overflow-hidden rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100">
                {students.map((student) => (
                  <div data-testid="student-row" className="grid grid-cols-[24px_44px_minmax(3.8rem,1fr)_34px_48px_46px_38px_40px] items-center gap-0.5 px-1.5 py-1 text-[11px]" key={student.studentId}>
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
                    <button aria-label={`${student.studentId} 학생 저장`} className="h-8 rounded-lg bg-slate-950 px-1 text-xs font-black text-white" onClick={() => saveStudent(student)} type="button">
                      저장
                    </button>
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
                <button type="button" onClick={deleteSelectedProducts} className="mt-2 rounded-xl bg-rose-600 px-4 py-2 text-sm font-black text-white">선택 상품 삭제</button>
              </div>
              <div data-testid="product-list" className="overflow-hidden rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100">
                {products.map((product) => (
                  <div data-testid="product-row" className="grid grid-cols-[24px_30px_minmax(3rem,1fr)_32px_32px_36px_minmax(3rem,0.8fr)_28px_30px_34px_34px] items-center gap-0.5 px-1.5 py-1 text-[11px]" key={product.productId}>
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
                    <button aria-label={`${product.productId} 상품 저장`} className="h-8 rounded-lg bg-slate-950 px-1 text-[10px] font-black text-white" onClick={() => saveProduct(product)} type="button">
                      저장
                    </button>
                    <button aria-label={`${product.productId} 상품 삭제`} className="h-8 rounded-lg bg-rose-100 px-1 text-[10px] font-black text-rose-700" onClick={() => deleteProductRow(product.productId)} type="button">
                      삭제
                    </button>
                  </div>
                ))}
              </div>
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
    <section className={`rounded-[1.25rem] border border-slate-300/70 bg-white/90 shadow-sm sm:rounded-[1.75rem] ${compact ? 'p-3 md:p-4' : 'p-4 md:p-5'}`}>
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
