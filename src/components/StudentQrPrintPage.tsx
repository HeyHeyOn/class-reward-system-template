'use client';

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from 'react';
import type { Student } from '@/domain/types';
import { useQrObjectUrls } from '@/lib/qrCodeClient';
import { tenantApiPath, tenantFetch } from '@/lib/tenantApiPath';
import { themeStyles } from './uiTheme';
import { buttonClass } from './ui';

type LoadState = 'loading' | 'ready' | 'error';

export function StudentQrPrintPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [message, setMessage] = useState('학생 목록을 불러오는 중이에요.');
  const [qrAttempt, setQrAttempt] = useState(0);

  useEffect(() => {
    let isMounted = true;

    async function loadStudents() {
      setLoadState('loading');
      setMessage('학생 목록을 불러오는 중이에요.');

      try {
        const response = await tenantFetch('/api/students');
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error ?? '학생 목록을 불러오지 못했어요.');
        }

        if (isMounted) {
          setStudents(payload);
          setLoadState('ready');
          setMessage(payload.length === 0 ? '인쇄할 활성 학생이 없어요.' : '');
        }
      } catch (error) {
        if (isMounted) {
          setLoadState('error');
          setMessage(error instanceof Error ? error.message : '학생 목록을 불러오지 못했어요.');
        }
      }
    }

    void Promise.resolve().then(() => {
      if (isMounted) return loadStudents();
    });

    return () => {
      isMounted = false;
    };
  }, []);

  const studentCountText = useMemo(() => `총 ${students.length}명`, [students.length]);
  const qrRequests = useMemo(() => students.map((student) => ({
    key: `${qrAttempt}:${student.studentId}`,
    endpoint: tenantApiPath('/api/qrcode'),
    body: { kind: 'student' as const, studentId: student.studentId },
  })), [qrAttempt, students]);
  const qrUrls = useQrObjectUrls(qrRequests);
  const qrUrlFor = (studentId: string) => qrUrls[`${qrAttempt}:${studentId}`];
  const hasQrFailure = students.some((student) => qrUrlFor(student.studentId) === null);
  const allQrsReady = students.length > 0
    && students.every((student) => Boolean(qrUrlFor(student.studentId)));

  return (
    <main style={themeStyles('white').variables} className="min-h-screen bg-[var(--theme-shell)] px-4 py-6 text-[var(--theme-text)] sm:px-6 lg:py-10 print:bg-white print:px-0 print:py-0">
      <section className="mx-auto max-w-6xl print:max-w-none">
        <header className="mb-6 flex flex-col gap-4 print:hidden md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-[13px] font-semibold text-[var(--theme-muted-text)]">학급 관리자</p>
            <h1 className="mt-1 text-[28px] font-black tracking-[-0.035em]">학생 QR 카드 인쇄</h1>
            <p className="mt-1.5 text-sm text-[var(--theme-muted-text)]">
              활성 학생의 QR 카드를 인쇄해 잘라 쓸 수 있어요.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[var(--crs-subtle-hover)] px-3.5 py-1.5 text-[13px] font-bold text-[var(--theme-muted-text)]">{studentCountText}</span>
            {hasQrFailure ? (
              <button className={buttonClass({ variant: 'secondary' })} onClick={() => setQrAttempt((current) => current + 1)} type="button">
                QR 생성 다시 시도
              </button>
            ) : null}
            <button className={buttonClass({ variant: 'primary' })} disabled={!allQrsReady} onClick={() => window.print()} type="button">
              QR 카드 인쇄하기
            </button>
          </div>
        </header>

        {message ? (
          <p className={`mb-6 rounded-[14px] px-4 py-3 text-[13px] font-semibold print:hidden ${
            loadState === 'error' ? 'bg-[var(--crs-danger-bg)] text-[var(--crs-danger-text)]' : 'bg-[var(--crs-subtle-hover)] text-[var(--theme-muted-text)]'
          }`}>
            {message}
          </p>
        ) : null}

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3 print:gap-3">
          {students.map((student) => (
            <article
              className="break-inside-avoid rounded-[20px] border border-[var(--crs-line)] bg-white p-5 text-center text-slate-900 shadow-[var(--crs-shadow-sm)] print:rounded-2xl print:border-slate-300 print:p-4 print:shadow-none"
              key={student.studentId}
            >
              <div className="mx-auto mb-4 flex h-44 w-44 items-center justify-center rounded-2xl bg-white print:h-40 print:w-40">
                {qrUrlFor(student.studentId) ? (
                  <img
                    alt={`${student.name} QR 코드`}
                    className="h-full w-full"
                    src={qrUrlFor(student.studentId) as string}
                  />
                ) : qrUrlFor(student.studentId) === null ? (
                  <span className="text-sm font-bold text-red-700">QR 생성 실패</span>
                ) : (
                  <span className="text-sm font-semibold text-slate-500">QR 생성 중</span>
                )}
              </div>
              <h2 className="text-xl font-black tracking-[-0.02em]">{student.name}</h2>
              <p className="mt-0.5 text-sm font-semibold text-slate-500">
                {student.studentId}
              </p>
              <p className="mt-4 rounded-xl bg-slate-50 px-4 py-2.5 text-xs font-semibold leading-relaxed text-slate-600 print:bg-white print:p-0">
                학급 은행과 매점에서<br />
                이 QR을 찍어 주세요.
              </p>
            </article>
          ))}
        </section>
      </section>
    </main>
  );
}
