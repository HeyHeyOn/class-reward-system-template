'use client';

import { FormEvent, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export function AdminLoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState(searchParams.get('error') ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage('');

    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = (await response.json()) as { error?: string };

      if (!response.ok) throw new Error(body.error ?? '로그인하지 못했습니다.');
      router.replace(searchParams.get('next') || '/admin');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '로그인하지 못했습니다.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#dbeaf6] px-4 py-10 text-[#25313f]">
      <section className="mx-auto max-w-md rounded-[2rem] bg-white p-8 shadow-[0_20px_60px_rgba(37,49,63,0.15)]">
        <p className="text-sm font-bold uppercase tracking-[0.3em] text-[#4f8fba]">Class Store Admin</p>
        <h1 className="mt-3 text-3xl font-black">관리자 로그인</h1>
        <p className="mt-3 text-sm text-[#627184]">Google 계정으로 로그인하면 서비스 계정 없이 본인 권한으로 Google Sheets를 연동합니다. 기존 관리자 비밀번호 방식도 그대로 사용할 수 있습니다.</p>

        <a
          className="mt-8 flex w-full items-center justify-center rounded-2xl bg-[#4285f4] px-5 py-3 text-center font-black text-white shadow-[0_10px_30px_rgba(66,133,244,0.25)]"
          href="/api/google/login"
        >
          Google 계정으로 로그인
        </a>

        <div className="my-6 flex items-center gap-3 text-xs font-bold uppercase tracking-[0.2em] text-[#94a3b8]">
          <span className="h-px flex-1 bg-[#e2e8f0]" />
          <span>또는</span>
          <span className="h-px flex-1 bg-[#e2e8f0]" />
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block text-sm font-bold" htmlFor="admin-password">관리자 비밀번호</label>
          <input
            id="admin-password"
            className="w-full rounded-2xl border border-[#c8d7e3] px-4 py-3 text-lg outline-none focus:border-[#4f8fba]"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
          />
          {message ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{message}</p> : null}
          <button
            className="w-full rounded-2xl bg-[#25313f] px-5 py-3 font-black text-white disabled:opacity-60"
            type="submit"
            disabled={isSubmitting}
          >
            {isSubmitting ? '확인 중...' : '관리자 페이지로 이동'}
          </button>
        </form>
      </section>
    </main>
  );
}
