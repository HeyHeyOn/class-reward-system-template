'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { parseClassRewardArgs, renderCliResult } from '@/generator/cli.ts';

const THEMES = [
  { value: 'blue', label: '파랑' },
  { value: 'pink', label: '분홍' },
  { value: 'yellow', label: '노랑' },
  { value: 'green', label: '초록' },
  { value: 'purple', label: '보라' },
  { value: 'white', label: '흰색' },
  { value: 'black', label: '검은색' },
  { value: 'navy', label: '남색' },
];

export function AdminGeneratorPage() {
  const [className, setClassName] = useState('');
  const [appTitle, setAppTitle] = useState('학급 매점');
  const [bankTitle, setBankTitle] = useState('학급 은행');
  const [currencyUnit, setCurrencyUnit] = useState('원');
  const [themeColor, setThemeColor] = useState('blue');
  const [adminPasswordConfigured, setAdminPasswordConfigured] = useState(false);

  const preview = useMemo(() => {
    const args = ['create', '--dry-run'];
    if (className.trim()) args.push('--class-name', className.trim());
    args.push('--app-title', appTitle);
    args.push('--bank-title', bankTitle);
    args.push('--currency-unit', currencyUnit);
    args.push('--theme', themeColor);
    if (adminPasswordConfigured) args.push('--admin-password-set');
    return renderCliResult(parseClassRewardArgs(args));
  }, [adminPasswordConfigured, appTitle, bankTitle, className, currencyUnit, themeColor]);

  return (
    <main className="min-h-screen bg-[#dbeaf6] p-3 text-slate-950 sm:p-5">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        <header className="rounded-[1.75rem] border border-slate-300/70 bg-white px-5 py-5 shadow-sm sm:px-7">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-black tracking-[0.22em] text-purple-600">CLASS STORE GENERATOR</p>
              <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-5xl">시스템 생성기</h1>
              <p className="mt-2 max-w-2xl text-sm font-bold text-slate-500 sm:text-base">
                새 학급 매점 인스턴스를 만들기 전에 Google Sheets 구조와 배포 환경을 안전하게 미리 확인합니다.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/admin" className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-200">
                관리자 센터로 돌아가기
              </Link>
              <Link href="/" className="rounded-2xl bg-sky-500 px-4 py-3 text-sm font-black text-white hover:bg-sky-600">
                현재 운영 매점 열기
              </Link>
            </div>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
          <form className="rounded-[1.75rem] border border-slate-300/70 bg-white p-5 shadow-sm" onSubmit={(event) => event.preventDefault()}>
            <h2 className="text-2xl font-black">새 시스템 기본값</h2>
            <p className="mt-1 text-sm font-bold text-slate-500">이 단계는 dry-run 미리보기만 생성합니다.</p>

            <div className="mt-5 space-y-4">
              <GeneratorInput label="학급명" value={className} onChange={setClassName} placeholder="예: 4학년 1반" />
              <GeneratorInput label="매점 이름" value={appTitle} onChange={setAppTitle} />
              <GeneratorInput label="은행 이름" value={bankTitle} onChange={setBankTitle} />
              <GeneratorInput label="화폐 단위" value={currencyUnit} onChange={setCurrencyUnit} />

              <label className="block text-sm font-black text-slate-700">
                테마
                <select
                  aria-label="테마"
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base font-bold outline-none transition focus:border-purple-500 focus:bg-white"
                  value={themeColor}
                  onChange={(event) => setThemeColor(event.target.value)}
                >
                  {THEMES.map((theme) => <option key={theme.value} value={theme.value}>{theme.label}</option>)}
                </select>
              </label>

              <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-black text-slate-700">
                <input
                  aria-label="관리자 암호 설정 완료"
                  type="checkbox"
                  checked={adminPasswordConfigured}
                  onChange={(event) => setAdminPasswordConfigured(event.target.checked)}
                />
                관리자 암호 설정 완료
              </label>
            </div>

            <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900">
              <p className="font-black">실제 생성은 아직 비활성화되어 있습니다.</p>
              <p className="mt-1">라이브 데이터 수정 없음 · 시트 생성 없음 · Vercel 설정 변경 없음</p>
            </div>

            <button type="button" disabled className="mt-4 w-full rounded-2xl bg-slate-300 py-4 text-lg font-black text-slate-600">
              실제 생성 준비 중
            </button>
          </form>

          <section className="rounded-[1.75rem] border border-slate-300/70 bg-slate-950 p-5 text-white shadow-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-black tracking-[0.22em] text-purple-300">DRY-RUN MANIFEST</p>
                <h2 className="text-2xl font-black">생성 계획 미리보기</h2>
              </div>
              <span className="rounded-full bg-emerald-400/15 px-3 py-1 text-xs font-black text-emerald-200">라이브 데이터 수정 없음</span>
            </div>
            <pre data-testid="generator-preview" className="mt-4 max-h-[620px] overflow-auto whitespace-pre-wrap rounded-2xl bg-black/40 p-4 text-xs leading-6 text-slate-100 sm:text-sm">
              {preview}
            </pre>
          </section>
        </section>

        <aside className="rounded-[1.75rem] border border-slate-300/70 bg-white p-5 shadow-sm">
          <h2 className="text-xl font-black">4페이즈 범위</h2>
          <ul className="mt-3 grid gap-2 text-sm font-bold text-slate-600 sm:grid-cols-3">
            <li className="rounded-2xl bg-sky-50 p-3">폼 입력값으로 create dry-run manifest를 즉시 렌더링합니다.</li>
            <li className="rounded-2xl bg-sky-50 p-3">비밀값은 받지 않고 설정 여부만 표시합니다.</li>
            <li className="rounded-2xl bg-sky-50 p-3">다음 단계는 승인 후 Google Sheets 템플릿 생성과 Vercel 환경 준비입니다.</li>
          </ul>
        </aside>
      </section>
    </main>
  );
}

function GeneratorInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="block text-sm font-black text-slate-700">
      {label}
      <input
        aria-label={label}
        className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base font-bold outline-none transition focus:border-purple-500 focus:bg-white"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
