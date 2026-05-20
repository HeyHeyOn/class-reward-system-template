'use client';

import { FormEvent, useEffect, useState } from 'react';

type SettingsResponse = {
  spreadsheetId: string;
  currencyUnit: string;
  appTitle: string;
  themeColor: string;
  source: 'runtime' | 'env' | 'unset';
  adminPasswordConfigured?: boolean;
};

type SettingsFormProps = {
  linkedStudentCount?: number;
  linkedProductCount?: number;
  onSettingsSaved?: () => Promise<void> | void;
};

export function SettingsForm({ linkedStudentCount, linkedProductCount, onSettingsSaved }: SettingsFormProps) {
  const [spreadsheetIdOrUrl, setSpreadsheetIdOrUrl] = useState('');
  const [currencyUnit, setCurrencyUnit] = useState('원');
  const [appTitle, setAppTitle] = useState('학급 매점');
  const [themeColor, setThemeColor] = useState('blue');
  const [currentSettings, setCurrentSettings] = useState<SettingsResponse | null>(null);
  const [message, setMessage] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [savedAdminPassword, setSavedAdminPassword] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let ignore = false;

    async function loadSettings() {
      const response = await fetch('/api/settings', { cache: 'no-store' });
      const settings = (await response.json()) as SettingsResponse;

      if (!ignore) {
        setCurrentSettings(settings);
        setSpreadsheetIdOrUrl(settings.spreadsheetId);
        setCurrencyUnit(settings.currencyUnit ?? '원');
        setAppTitle(settings.appTitle ?? '학급 매점');
        setThemeColor(settings.themeColor ?? 'blue');
      }
    }

    loadSettings().catch(() => {
      if (!ignore) setMessage('현재 설정을 불러오지 못했습니다.');
    });

    return () => {
      ignore = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setMessage('');

    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheetIdOrUrl, currencyUnit, appTitle, themeColor, adminPassword: adminPassword.trim() || undefined }),
      });
      const payload = (await response.json()) as SettingsResponse | { error: string };

      if (!response.ok || 'error' in payload) {
        setMessage('error' in payload ? payload.error : '설정을 저장하지 못했습니다.');
        return;
      }

      setCurrentSettings(payload);
      setSpreadsheetIdOrUrl(payload.spreadsheetId);
      setCurrencyUnit(payload.currencyUnit);
      setAppTitle(payload.appTitle);
      setThemeColor(payload.themeColor ?? 'blue');
      if (adminPassword.trim()) {
        setSavedAdminPassword(adminPassword.trim());
        setAdminPassword('');
      }
      await onSettingsSaved?.();
      setMessage('시트 ID를 저장했고, 관리자 목록도 같은 시트에서 다시 불러왔습니다.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-[2rem] bg-white p-6 shadow-sm ring-1 ring-black/5">
      <div className="space-y-2">
        <p className="text-sm font-bold tracking-[0.2em] text-amber-700">GOOGLE SHEETS</p>
        <h2 className="text-3xl font-black">스프레드시트 연결</h2>
        <p className="text-slate-600">
          Google Sheets 주소 전체 또는 `/d/` 사이의 시트 ID만 넣어도 됩니다. 저장할 때 서비스 계정으로 실제 접근 가능한지 확인한 뒤,
          이 설치본의 `data/settings.json`에 보관합니다.
        </p>
      </div>

      <label className="mt-6 block">
        <span className="text-sm font-bold text-slate-700">Google Sheets 주소 또는 시트 ID</span>
        <input
          value={spreadsheetIdOrUrl}
          onChange={(event) => setSpreadsheetIdOrUrl(event.target.value)}
          placeholder="https://docs.google.com/spreadsheets/d/.../edit"
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-lg outline-none transition focus:border-amber-500 focus:bg-white"
        />
      </label>

      <label className="mt-4 block">
        <span className="text-sm font-bold text-slate-700">학급 화폐 단위</span>
        <input
          aria-label="학급 화폐 단위"
          value={currencyUnit}
          onChange={(event) => setCurrencyUnit(event.target.value)}
          placeholder="원, 별, 포인트 등"
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-lg outline-none transition focus:border-amber-500 focus:bg-white"
        />
      </label>

      <label className="mt-4 block">
        <span className="text-sm font-bold text-slate-700">매점 제목</span>
        <input
          aria-label="매점 제목"
          value={appTitle}
          onChange={(event) => setAppTitle(event.target.value)}
          placeholder="학급 매점"
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-lg outline-none transition focus:border-amber-500 focus:bg-white"
        />
      </label>


      <label className="mt-4 block">
        <span className="text-sm font-bold text-slate-700">테마 색상</span>
        <select
          aria-label="테마 색상"
          value={themeColor}
          onChange={(event) => setThemeColor(event.target.value)}
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-lg font-bold outline-none transition focus:border-amber-500 focus:bg-white"
        >
          <option value="blue">파랑</option>
          <option value="pink">분홍</option>
          <option value="yellow">노랑</option>
          <option value="green">초록</option>
          <option value="purple">보라</option>
          <option value="white">흰색</option>
          <option value="black">검은색</option>
          <option value="navy">남색</option>
        </select>
      </label>

      <label className="mt-4 block">
        <span className="text-sm font-bold text-slate-700">관리자 암호 설정</span>
        <input
          aria-label="관리자 암호 설정"
          value={adminPassword}
          onChange={(event) => setAdminPassword(event.target.value)}
          placeholder={currentSettings?.adminPasswordConfigured ? '새 암호를 입력하면 변경됩니다' : '관리자 로그인 암호'}
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-lg outline-none transition focus:border-amber-500 focus:bg-white"
        />
        <p className="mt-2 text-xs font-bold text-slate-500">암호는 해시로 Settings 시트에 저장됩니다. QR은 저장 직후 이 화면에서만 표시됩니다.</p>
      </label>

      {savedAdminPassword ? (
        <div className="mt-4 rounded-2xl bg-sky-50 p-4 text-center">
          <p className="text-sm font-black text-sky-900">관리자 QR 로그인 코드</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="mx-auto mt-3 h-48 w-48 rounded-xl bg-white p-2" alt="관리자 로그인 QR" src={`/api/qrcode?value=${encodeURIComponent(`class-store-admin:${savedAdminPassword}`)}`} />
          <p className="mt-2 text-xs font-bold text-slate-500">로그인 화면의 QR 로그인으로 인식하면 암호가 자동 입력됩니다.</p>
        </div>
      ) : null}

      <div className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
        <p>
          현재 상태:{' '}
          <strong className="text-slate-950">
            {currentSettings?.spreadsheetId ? '연결 ID 있음' : '미설정'}
          </strong>
        </p>
        <p>설정 출처: {currentSettings?.source ?? '확인 중'}</p>
        <p>화폐 단위: {currentSettings?.currencyUnit ?? currencyUnit}</p>
        <p>매점 제목: {currentSettings?.appTitle ?? appTitle}</p>
        <p>테마 색상: {currentSettings?.themeColor ?? themeColor}</p>
        <p>관리자 암호: {currentSettings?.adminPasswordConfigured ? '설정됨' : '미설정'}</p>
        <p className="mt-2 font-bold text-sky-800">
          관리자 목록도 이 설정을 사용합니다: 학생 {linkedStudentCount ?? 0}명 · 상품 {linkedProductCount ?? 0}개
        </p>
      </div>

      {message ? <p className="mt-4 font-bold text-amber-700">{message}</p> : null}

      <button
        type="submit"
        disabled={isSaving}
        className="mt-6 w-full rounded-2xl bg-slate-950 py-4 text-xl font-black text-white shadow-lg transition hover:bg-slate-800 disabled:cursor-wait disabled:bg-slate-400"
      >
        {isSaving ? '저장 중...' : '시트 ID 저장'}
      </button>
    </form>
  );
}
