'use client';

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from 'react';
import type { Student } from '@/domain/types';

type LoadState = 'loading' | 'ready' | 'error';

export function StudentQrPrintPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [message, setMessage] = useState('학생 목록을 불러오는 중입니다.');

  useEffect(() => {
    let isMounted = true;

    async function loadStudents() {
      setLoadState('loading');
      setMessage('학생 목록을 불러오는 중입니다.');

      try {
        const response = await fetch('/api/students');
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error ?? '학생 목록을 불러오지 못했습니다.');
        }

        if (isMounted) {
          setStudents(payload);
          setLoadState('ready');
          setMessage(payload.length === 0 ? '인쇄할 활성 학생이 없습니다.' : '');
        }
      } catch (error) {
        if (isMounted) {
          setLoadState('error');
          setMessage(error instanceof Error ? error.message : '학생 목록을 불러오지 못했습니다.');
        }
      }
    }

    loadStudents();

    return () => {
      isMounted = false;
    };
  }, []);

  const studentCountText = useMemo(() => `총 ${students.length}명`, [students.length]);

  return (
    <main className="min-h-screen bg-[#f6f1e8] px-6 py-8 text-slate-950 print:bg-white print:px-0 print:py-0">
      <section className="mx-auto max-w-6xl print:max-w-none">
        <header className="mb-8 flex flex-col gap-4 rounded-3xl bg-white p-6 shadow-sm print:hidden md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-bold text-amber-700">학급 매점 관리자</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight">학생 QR 카드 인쇄</h1>
            <p className="mt-2 text-slate-600">
              활성 학생 목록을 Google Sheets에서 불러와 학생증/쿠폰처럼 잘라 쓸 수 있는 QR 카드를 만듭니다.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-amber-100 px-4 py-2 text-sm font-bold text-amber-900">{studentCountText}</span>
            <button
              className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              disabled={students.length === 0}
              onClick={() => window.print()}
              type="button"
            >
              QR 카드 인쇄하기
            </button>
          </div>
        </header>

        {message ? (
          <p
            className={`mb-6 rounded-2xl p-4 text-sm font-bold print:hidden ${
              loadState === 'error' ? 'bg-red-100 text-red-800' : 'bg-white text-slate-600'
            }`}
          >
            {message}
          </p>
        ) : null}

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3 print:gap-3">
          {students.map((student) => (
            <article
              className="break-inside-avoid rounded-3xl border-2 border-slate-200 bg-white p-5 text-center shadow-sm print:rounded-2xl print:border print:p-4 print:shadow-none"
              key={student.studentId}
            >
              <div className="mx-auto mb-4 flex h-48 w-48 items-center justify-center rounded-3xl border border-slate-100 bg-white p-3 print:h-40 print:w-40">
                <img
                  alt={`${student.name} QR 코드`}
                  className="h-full w-full"
                  src={`/api/qrcode?value=${encodeURIComponent(student.studentId)}`}
                />
              </div>
              <h2 className="text-2xl font-black">{student.name}</h2>
              <p className="mt-1 text-lg font-bold text-slate-600">
                {student.number}번 · {student.studentId}
              </p>
              <p className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900 print:bg-white print:p-0 print:text-slate-700">
                학급 은행 및 매점에서<br />
                이 QR을 스캔해 주세요.
              </p>
            </article>
          ))}
        </section>
      </section>
    </main>
  );
}
