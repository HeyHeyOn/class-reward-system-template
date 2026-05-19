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

  function updateStudent(studentId: string, patch: Partial<StudentDraft>) {
    setStudents((current) => current.map((student) => (student.studentId === studentId ? { ...student, ...patch } : student)));
  }

  function updateProduct(productId: string, patch: Partial<ProductDraft>) {
    setProducts((current) => current.map((product) => (product.productId === productId ? { ...product, ...patch } : product)));
  }

  function addCreateMessage(messageText: string) {
    addCreateMessages((current) => [...current, messageText].slice(-4));
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
    <main data-testid="admin-shell" className="min-h-screen bg-[#dbeaf6] p-3 text-slate-950 sm:p-4 md:p-6">
      <section className="mx-auto flex w-full max-w-[1100px] flex-col gap-4">
        <header className="rounded-[1.75rem] border border-slate-300/70 bg-white px-5 py-5 text-center shadow-sm md:px-7">
          <p className="text-sm font-black tracking-[0.24em] text-sky-600">CLASS STORE ADMIN</p>
          <h1 className="mt-2 text-4xl font-black tracking-tight md:text-5xl">관리자 센터</h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm font-bold text-slate-500 md:text-base">
            시트 연결, 학생 잔액, 상품 재고를 한 곳에서 관리합니다.
          </p>
          <div className="mt-5 grid gap-2 sm:grid-cols-3">
            <SummaryCard label="학생" value={`${summary.students}명`} />
            <SummaryCard label="판매 상품" value={`${summary.activeProducts}개`} />
            <SummaryCard label="전체 재고" value={`${summary.totalStock}개`} />
          </div>
          {message ? <p className="mt-4 rounded-2xl bg-rose-100 p-3 font-bold text-rose-700">{message}</p> : null}
        </header>

        <section aria-label="관리자 바로가기" className="grid gap-2 rounded-[1.5rem] border border-slate-300/70 bg-white/90 p-2 shadow-sm sm:grid-cols-2">
          <AdminLink href="/admin/student-qrs" title="학생 QR 출력" description="학생별 QR 카드를 인쇄합니다." />
          <AdminLink href="/admin/transactions" title="결제 내역 확인" description="Transactions 시트에 기록된 결제 기록을 확인합니다." />
        </section>

        <nav data-testid="admin-tabs" role="tablist" aria-label="관리자 메뉴" className="grid gap-2 rounded-[1.5rem] border border-slate-300/70 bg-white/90 p-2 shadow-sm md:grid-cols-3">
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
                className={`rounded-[1.15rem] px-4 py-3 text-left transition ${selected ? 'bg-sky-500 text-white shadow-sm' : 'bg-sky-50 text-slate-700 hover:bg-sky-100'}`}
              >
                <span className="block text-lg font-black">{tab.label}</span>
                <span className={`mt-1 block text-xs font-bold ${selected ? 'text-sky-50' : 'text-slate-500'}`}>{tab.description}</span>
              </button>
            );
          })}
        </nav>

        {createMessages.length > 0 ? (
          <div className="space-y-2">
            {createMessages.map((item, index) => (
              <p className="rounded-2xl bg-sky-100 p-3 font-bold text-sky-900" key={`${item}-${index}`}>
                {item}
              </p>
            ))}
          </div>
        ) : null}

        {activeTab === 'settings' ? (
          <section role="tabpanel" aria-label="시트 설정" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <SettingsForm
              linkedStudentCount={students.length}
              linkedProductCount={products.length}
              onSettingsSaved={() => loadLinkedSheetData()}
            />
            <InfoPanel />
          </section>
        ) : null}

        {activeTab === 'students' ? (
          <section role="tabpanel" aria-label="학생 명단" className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <SectionCard title="새 학생 추가" description="QR에 들어갈 학생 ID와 초기 잔액을 등록합니다.">
              <form onSubmit={createNewStudent} className="space-y-3">
                <TextInput label="새 학생 ID" value={newStudent.studentId} onChange={(value) => setNewStudent((current) => ({ ...current, studentId: value }))} />
                <TextInput label="새 학생 이름" value={newStudent.name} onChange={(value) => setNewStudent((current) => ({ ...current, name: value }))} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <NumberInput label="새 학생 번호" value={newStudent.number} onChange={(value) => setNewStudent((current) => ({ ...current, number: value }))} />
                  <NumberInput label="새 학생 잔액" value={newStudent.balance} onChange={(value) => setNewStudent((current) => ({ ...current, balance: value }))} />
                </div>
                <button className="w-full rounded-2xl bg-sky-500 py-3 font-black text-white shadow-sm" type="submit">새 학생 추가</button>
              </form>
            </SectionCard>

            <SectionCard title="학생 명단" description="이름, 번호, 학급 화폐 잔액, 사용 상태를 수정합니다.">
              <div className="grid gap-3">
                {students.map((student) => (
                  <article className="rounded-3xl border border-slate-200 bg-sky-50/60 p-4" key={student.studentId}>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <strong className="text-lg font-black">{student.studentId}</strong>
                        <p className="text-sm font-bold text-slate-500">{student.number}번 · {student.name}</p>
                      </div>
                      <span className="text-sm font-bold text-sky-700">{saveState[student.studentId]}</span>
                    </div>
                    <div className="grid gap-3 md:grid-cols-4">
                      <TextInput label={`${student.studentId} 이름`} value={student.name} onChange={(value) => updateStudent(student.studentId, { name: value })} />
                      <NumberInput label={`${student.studentId} 번호`} value={student.number} onChange={(value) => updateStudent(student.studentId, { number: value })} />
                      <NumberInput label={`${student.studentId} 잔액`} value={student.balance} onChange={(value) => updateStudent(student.studentId, { balance: value })} />
                      <label className="text-sm font-bold text-slate-700">
                        상태
                        <select aria-label={`${student.studentId} 상태`} className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3" onChange={(event) => updateStudent(student.studentId, { status: event.target.value as Student['status'] })} value={student.status}>
                          <option value="ACTIVE">활성</option>
                          <option value="INACTIVE">비활성</option>
                        </select>
                      </label>
                    </div>
                    <button className="mt-4 w-full rounded-2xl bg-slate-950 py-3 font-black text-white" onClick={() => saveStudent(student)} type="button">
                      {student.studentId} 학생 저장
                    </button>
                  </article>
                ))}
              </div>
            </SectionCard>
          </section>
        ) : null}

        {activeTab === 'products' ? (
          <section role="tabpanel" aria-label="재고 관리" className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <SectionCard title="새 상품 추가" description="매점에 보여줄 상품과 가격, 재고를 등록합니다.">
              <form onSubmit={createNewProduct} className="space-y-3">
                <TextInput label="새 상품 ID" value={newProduct.productId} onChange={(value) => setNewProduct((current) => ({ ...current, productId: value }))} />
                <TextInput label="새 상품명" value={newProduct.name} onChange={(value) => setNewProduct((current) => ({ ...current, name: value }))} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <NumberInput label="새 상품 가격" value={newProduct.price} onChange={(value) => setNewProduct((current) => ({ ...current, price: value }))} />
                  <NumberInput label="새 상품 재고" value={newProduct.stock} onChange={(value) => setNewProduct((current) => ({ ...current, stock: value }))} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextInput label="새 상품 카테고리" value={newProduct.category} onChange={(value) => setNewProduct((current) => ({ ...current, category: value }))} />
                  <NumberInput label="새 상품 정렬" value={newProduct.sortOrder} onChange={(value) => setNewProduct((current) => ({ ...current, sortOrder: value }))} />
                </div>
                <button className="w-full rounded-2xl bg-sky-500 py-3 font-black text-white shadow-sm" type="submit">새 상품 추가</button>
              </form>
            </SectionCard>

            <SectionCard title="상품 · 재고 관리" description="상품명, 가격, 재고, 판매 상태를 수정합니다.">
              <div className="grid gap-3">
                {products.map((product) => (
                  <article className="rounded-3xl border border-slate-200 bg-sky-50/60 p-4" key={product.productId}>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <strong className="text-lg font-black">{product.productId}</strong>
                        <p className="text-sm font-bold text-slate-500">{product.name} · 재고 {product.stock}</p>
                      </div>
                      <span className="text-sm font-bold text-sky-700">{saveState[product.productId]}</span>
                    </div>
                    <div className="grid gap-3 md:grid-cols-3">
                      <TextInput label={`${product.productId} 상품명`} value={product.name} onChange={(value) => updateProduct(product.productId, { name: value })} />
                      <NumberInput label={`${product.productId} 가격`} value={product.price} onChange={(value) => updateProduct(product.productId, { price: value })} />
                      <NumberInput label={`${product.productId} 재고`} value={product.stock} onChange={(value) => updateProduct(product.productId, { stock: value })} />
                      <TextInput label={`${product.productId} 카테고리`} value={product.category ?? ''} onChange={(value) => updateProduct(product.productId, { category: value })} />
                      <NumberInput label={`${product.productId} 정렬`} value={product.sortOrder} onChange={(value) => updateProduct(product.productId, { sortOrder: value })} />
                      <label className="flex items-center gap-3 rounded-2xl bg-white px-3 py-3 text-sm font-bold text-slate-700">
                        <input aria-label={`${product.productId} 판매중`} checked={product.isActive} onChange={(event) => updateProduct(product.productId, { isActive: event.target.checked })} type="checkbox" />
                        판매중
                      </label>
                    </div>
                    <button className="mt-4 w-full rounded-2xl bg-slate-950 py-3 font-black text-white" onClick={() => saveProduct(product)} type="button">
                      {product.productId} 상품 저장
                    </button>
                  </article>
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
    <Link className="rounded-[1.15rem] bg-sky-50 px-4 py-3 text-left text-slate-700 transition hover:bg-sky-100" href={href}>
      <span className="block text-lg font-black">{title}</span>
      <span className="mt-1 block text-xs font-bold text-slate-500">{description}</span>
    </Link>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-sky-50 px-4 py-3 text-left">
      <p className="text-xs font-black text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-black text-sky-700">{value}</p>
    </div>
  );
}

function SectionCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="rounded-[1.75rem] border border-slate-300/70 bg-white/90 p-4 shadow-sm md:p-5">
      <h2 className="text-2xl font-black">{title}</h2>
      <p className="mt-1 text-sm font-bold text-slate-500">{description}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function TextInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-sm font-bold text-slate-700">
      <span>{label.replace(/^새 |^[SP]\d+ /, '')}</span>
      <input aria-label={label} className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 outline-none transition focus:border-sky-400" onChange={(event) => onChange(event.target.value)} value={value} />
    </label>
  );
}

function NumberInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="block text-sm font-bold text-slate-700">
      <span>{label.replace(/^새 |^[SP]\d+ /, '')}</span>
      <input aria-label={label} className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 outline-none transition focus:border-sky-400" onChange={(event) => onChange(Number(event.target.value))} type="number" value={value} />
    </label>
  );
}

function InfoPanel() {
  return (
    <aside className="rounded-[1.75rem] border border-slate-300/70 bg-white/90 p-5 shadow-sm">
      <h2 className="text-2xl font-black">사용 전 확인</h2>
      <ul className="mt-4 space-y-3 text-sm font-bold text-slate-600">
        <li>• Students, Products, Transactions, Adjustments 시트가 필요합니다.</li>
        <li>• 서비스 계정 이메일을 스프레드시트 편집자로 공유해야 합니다.</li>
        <li>• QR 코드에는 이름이 아니라 S001 같은 studentId만 넣습니다.</li>
      </ul>
    </aside>
  );
}
