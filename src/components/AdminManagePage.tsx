'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { Product, Student } from '@/domain/types';

type StudentDraft = Student;
type ProductDraft = Product;
type SaveState = Record<string, string>;

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

export function AdminManagePage() {
  const [students, setStudents] = useState<StudentDraft[]>([]);
  const [products, setProducts] = useState<ProductDraft[]>([]);
  const [message, setMessage] = useState('학생/상품 목록을 불러오는 중입니다.');
  const [saveState, setSaveState] = useState<SaveState>({});
  const [newStudent, setNewStudent] = useState<NewStudentDraft>(EMPTY_STUDENT);
  const [newProduct, setNewProduct] = useState<NewProductDraft>(EMPTY_PRODUCT);
  const [createMessages, addCreateMessages] = useState<string[]>([]);

  useEffect(() => {
    let ignore = false;

    async function load() {
      try {
        const [studentResponse, productResponse] = await Promise.all([
          fetch('/api/students'),
          fetch('/api/products?includeInactive=1'),
        ]);
        const [studentPayload, productPayload] = await Promise.all([studentResponse.json(), productResponse.json()]);

        if (!studentResponse.ok) throw new Error(studentPayload.error ?? '학생 목록을 불러오지 못했습니다.');
        if (!productResponse.ok) throw new Error(productPayload.error ?? '상품 목록을 불러오지 못했습니다.');

        if (!ignore) {
          setStudents(studentPayload);
          setProducts(productPayload);
          setMessage('');
        }
      } catch (error) {
        if (!ignore) setMessage(error instanceof Error ? error.message : '목록을 불러오지 못했습니다.');
      }
    }

    load();

    return () => {
      ignore = true;
    };
  }, []);

  const summary = useMemo(() => {
    const activeProducts = products.filter((product) => product.isActive).length;
    return `학생 ${students.length}명 · 판매 상품 ${activeProducts}개`;
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
      const body = {
        name: student.name,
        number: student.number,
        balance: student.balance,
        status: student.status,
      };
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
      setSaveState((current) => ({
        ...current,
        [student.studentId]: error instanceof Error ? error.message : '학생 정보를 저장하지 못했습니다.',
      }));
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
      setSaveState((current) => ({
        ...current,
        [product.productId]: error instanceof Error ? error.message : '상품 정보를 저장하지 못했습니다.',
      }));
    }
  }

  async function createNewStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    addCreateMessage('학생 추가 중...');

    try {
      const body = {
        studentId: newStudent.studentId,
        name: newStudent.name,
        number: newStudent.number,
        balance: newStudent.balance,
        status: newStudent.status,
      };
      const response = await fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
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
      const response = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
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
    <main className="min-h-screen bg-[#f6f1e8] px-6 py-8 text-slate-950">
      <section className="mx-auto max-w-7xl">
        <header className="mb-8 rounded-[2rem] bg-white p-6 shadow-sm ring-1 ring-black/5">
          <p className="text-sm font-bold tracking-[0.2em] text-amber-700">CLASS STORE ADMIN</p>
          <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-4xl font-black tracking-tight">학생 · 상품 관리</h1>
              <p className="mt-2 text-slate-600">스프레드시트 값을 직접 만지지 않아도 운영에 필요한 값을 빠르게 수정합니다.</p>
            </div>
            <span className="rounded-full bg-amber-100 px-4 py-2 text-sm font-black text-amber-900">{summary}</span>
          </div>
          {message ? <p className="mt-4 rounded-2xl bg-red-50 p-4 font-bold text-red-700">{message}</p> : null}
        </header>

        <section className="mb-6 grid gap-6 xl:grid-cols-2">
          <form className="rounded-[2rem] bg-white p-5 shadow-sm ring-1 ring-black/5" onSubmit={createNewStudent}>
            <h2 className="text-2xl font-black">새 학생 추가</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="text-sm font-bold text-slate-700">
                학생 ID
                <input aria-label="새 학생 ID" className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3" onChange={(event) => setNewStudent((current) => ({ ...current, studentId: event.target.value }))} value={newStudent.studentId} />
              </label>
              <label className="text-sm font-bold text-slate-700">
                이름
                <input aria-label="새 학생 이름" className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3" onChange={(event) => setNewStudent((current) => ({ ...current, name: event.target.value }))} value={newStudent.name} />
              </label>
              <label className="text-sm font-bold text-slate-700">
                번호
                <input aria-label="새 학생 번호" className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3" onChange={(event) => setNewStudent((current) => ({ ...current, number: Number(event.target.value) }))} type="number" value={newStudent.number} />
              </label>
              <label className="text-sm font-bold text-slate-700">
                초기 잔액
                <input aria-label="새 학생 잔액" className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3" onChange={(event) => setNewStudent((current) => ({ ...current, balance: Number(event.target.value) }))} type="number" value={newStudent.balance} />
              </label>
            </div>
            <button className="mt-4 w-full rounded-2xl bg-amber-600 py-3 font-black text-white" type="submit">새 학생 추가</button>
          </form>

          <form className="rounded-[2rem] bg-white p-5 shadow-sm ring-1 ring-black/5" onSubmit={createNewProduct}>
            <h2 className="text-2xl font-black">새 상품 추가</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="text-sm font-bold text-slate-700">
                상품 ID
                <input aria-label="새 상품 ID" className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3" onChange={(event) => setNewProduct((current) => ({ ...current, productId: event.target.value }))} value={newProduct.productId} />
              </label>
              <label className="text-sm font-bold text-slate-700">
                상품명
                <input aria-label="새 상품명" className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3" onChange={(event) => setNewProduct((current) => ({ ...current, name: event.target.value }))} value={newProduct.name} />
              </label>
              <label className="text-sm font-bold text-slate-700">
                가격
                <input aria-label="새 상품 가격" className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3" onChange={(event) => setNewProduct((current) => ({ ...current, price: Number(event.target.value) }))} type="number" value={newProduct.price} />
              </label>
              <label className="text-sm font-bold text-slate-700">
                재고
                <input aria-label="새 상품 재고" className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3" onChange={(event) => setNewProduct((current) => ({ ...current, stock: Number(event.target.value) }))} type="number" value={newProduct.stock} />
              </label>
              <label className="text-sm font-bold text-slate-700">
                카테고리
                <input aria-label="새 상품 카테고리" className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3" onChange={(event) => setNewProduct((current) => ({ ...current, category: event.target.value }))} value={newProduct.category} />
              </label>
              <label className="text-sm font-bold text-slate-700">
                정렬
                <input aria-label="새 상품 정렬" className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3" onChange={(event) => setNewProduct((current) => ({ ...current, sortOrder: Number(event.target.value) }))} type="number" value={newProduct.sortOrder} />
              </label>
            </div>
            <button className="mt-4 w-full rounded-2xl bg-amber-600 py-3 font-black text-white" type="submit">새 상품 추가</button>
          </form>
        </section>

        {createMessages.length > 0 ? (
          <div className="mb-6 space-y-2">
            {createMessages.map((item, index) => (
              <p className="rounded-2xl bg-amber-100 p-4 font-bold text-amber-900" key={`${item}-${index}`}>
                {item}
              </p>
            ))}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-2">
          <section className="rounded-[2rem] bg-white p-5 shadow-sm ring-1 ring-black/5">
            <h2 className="text-2xl font-black">학생 관리</h2>
            <p className="mt-1 text-sm text-slate-500">이름, 번호, 잔액, 사용 상태를 수정합니다.</p>
            <div className="mt-5 space-y-4">
              {students.map((student) => (
                <article className="rounded-3xl border border-slate-200 bg-slate-50 p-4" key={student.studentId}>
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <strong>{student.studentId}</strong>
                    <span className="text-sm font-bold text-amber-700">{saveState[student.studentId]}</span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="text-sm font-bold text-slate-700">
                      이름
                      <input
                        aria-label={`${student.studentId} 이름`}
                        className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3"
                        onChange={(event) => updateStudent(student.studentId, { name: event.target.value })}
                        value={student.name}
                      />
                    </label>
                    <label className="text-sm font-bold text-slate-700">
                      번호
                      <input
                        aria-label={`${student.studentId} 번호`}
                        className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3"
                        onChange={(event) => updateStudent(student.studentId, { number: Number(event.target.value) })}
                        type="number"
                        value={student.number}
                      />
                    </label>
                    <label className="text-sm font-bold text-slate-700">
                      잔액
                      <input
                        aria-label={`${student.studentId} 잔액`}
                        className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3"
                        onChange={(event) => updateStudent(student.studentId, { balance: Number(event.target.value) })}
                        type="number"
                        value={student.balance}
                      />
                    </label>
                    <label className="text-sm font-bold text-slate-700">
                      상태
                      <select
                        aria-label={`${student.studentId} 상태`}
                        className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3"
                        onChange={(event) => updateStudent(student.studentId, { status: event.target.value as Student['status'] })}
                        value={student.status}
                      >
                        <option value="ACTIVE">활성</option>
                        <option value="INACTIVE">비활성</option>
                      </select>
                    </label>
                  </div>
                  <button
                    className="mt-4 w-full rounded-2xl bg-slate-950 py-3 font-black text-white"
                    onClick={() => saveStudent(student)}
                    type="button"
                  >
                    {student.studentId} 학생 저장
                  </button>
                </article>
              ))}
            </div>
          </section>

          <section className="rounded-[2rem] bg-white p-5 shadow-sm ring-1 ring-black/5">
            <h2 className="text-2xl font-black">상품 관리</h2>
            <p className="mt-1 text-sm text-slate-500">상품명, 가격, 재고, 판매 상태를 수정합니다.</p>
            <div className="mt-5 space-y-4">
              {products.map((product) => (
                <article className="rounded-3xl border border-slate-200 bg-slate-50 p-4" key={product.productId}>
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <strong>{product.productId}</strong>
                    <span className="text-sm font-bold text-amber-700">{saveState[product.productId]}</span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="text-sm font-bold text-slate-700">
                      상품명
                      <input
                        aria-label={`${product.productId} 상품명`}
                        className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3"
                        onChange={(event) => updateProduct(product.productId, { name: event.target.value })}
                        value={product.name}
                      />
                    </label>
                    <label className="text-sm font-bold text-slate-700">
                      가격
                      <input
                        aria-label={`${product.productId} 가격`}
                        className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3"
                        onChange={(event) => updateProduct(product.productId, { price: Number(event.target.value) })}
                        type="number"
                        value={product.price}
                      />
                    </label>
                    <label className="text-sm font-bold text-slate-700">
                      재고
                      <input
                        aria-label={`${product.productId} 재고`}
                        className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3"
                        onChange={(event) => updateProduct(product.productId, { stock: Number(event.target.value) })}
                        type="number"
                        value={product.stock}
                      />
                    </label>
                    <label className="text-sm font-bold text-slate-700">
                      카테고리
                      <input
                        aria-label={`${product.productId} 카테고리`}
                        className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3"
                        onChange={(event) => updateProduct(product.productId, { category: event.target.value })}
                        value={product.category ?? ''}
                      />
                    </label>
                    <label className="text-sm font-bold text-slate-700">
                      정렬
                      <input
                        aria-label={`${product.productId} 정렬`}
                        className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3"
                        onChange={(event) => updateProduct(product.productId, { sortOrder: Number(event.target.value) })}
                        type="number"
                        value={product.sortOrder}
                      />
                    </label>
                    <label className="flex items-center gap-3 rounded-2xl bg-white px-3 py-3 text-sm font-bold text-slate-700">
                      <input
                        aria-label={`${product.productId} 판매중`}
                        checked={product.isActive}
                        onChange={(event) => updateProduct(product.productId, { isActive: event.target.checked })}
                        type="checkbox"
                      />
                      판매중
                    </label>
                  </div>
                  <button
                    className="mt-4 w-full rounded-2xl bg-slate-950 py-3 font-black text-white"
                    onClick={() => saveProduct(product)}
                    type="button"
                  >
                    {product.productId} 상품 저장
                  </button>
                </article>
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
