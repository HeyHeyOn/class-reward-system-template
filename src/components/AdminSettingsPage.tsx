'use client';

import { FormEvent, useEffect, useState } from 'react';
import { FONT_FAMILY_OPTIONS, normalizeFontFamily, type FontFamily } from '@/lib/fontSettings';

type SettingsResponse = {
  spreadsheetId: string;
  currencyUnit: string;
  appTitle: string;
  bankTitle: string;
  themeColor: string;
  fontFamily: FontFamily;
  qrManualInputEnabled: boolean;
  source: 'runtime' | 'env' | 'unset';
  adminPasswordConfigured?: boolean;
  classTimeZone?: string;
};

type AdminSettingsPageProps = {
  linkedStudentCount?: number;
  linkedProductCount?: number;
  onSettingsSaved?: () => Promise<void> | void;
};

export function AdminSettingsPage({ linkedStudentCount, linkedProductCount, onSettingsSaved }: AdminSettingsPageProps) {
  const [spreadsheetIdOrUrl, setSpreadsheetIdOrUrl] = useState('');
  const [currencyUnit, setCurrencyUnit] = useState('원');
  const [appTitle, setAppTitle] = useState('학급 매점');
  const [bankTitle, setBankTitle] = useState('학급 은행');
  const [themeColor, setThemeColor] = useState('blue');
  const [fontFamily, setFontFamily] = useState<FontFamily>('default');
  const [qrManualInputEnabled, setQrManualInputEnabled] = useState(false);
  const [currentSettings, setCurrentSettings] = useState<SettingsResponse | null>(null);
  const [message, setMessage] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [savedAdminPassword, setSavedAdminPassword] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [classTimeZone, setClassTimeZone] = useState('Asia/Seoul');
  const [isSavingTimeZone, setIsSavingTimeZone] = useState(false);
  const [timeZoneMessage, setTimeZoneMessage] = useState('');

  useEffect(() => {
    let ignore = false;

    async function loadSettings() {
      const response = await fetch('/api/settings', { cache: 'no-store' });
      const settings = (await response.json()) as SettingsResponse;

      if (!ignore) {
        setCurrentSettings(settings);
        setSpreadsheetIdOrUrl(settings.spreadsheetId ?? '');
        setCurrencyUnit(settings.currencyUnit ?? '원');
        setAppTitle(settings.appTitle ?? '학급 매점');
        setBankTitle(settings.bankTitle ?? '학급 은행');
        setThemeColor(settings.themeColor ?? 'blue');
        setFontFamily(normalizeFontFamily(settings.fontFamily));
        setQrManualInputEnabled(Boolean(settings.qrManualInputEnabled));
        setClassTimeZone(settings.classTimeZone ?? 'Asia/Seoul');
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
        body: JSON.stringify({ spreadsheetIdOrUrl, currencyUnit, appTitle, bankTitle, themeColor, fontFamily, qrManualInputEnabled, adminPassword: adminPassword.trim() || undefined }),
      });
      const payload = (await response.json()) as SettingsResponse | { error: string };

      if (!response.ok || 'error' in payload) {
        setMessage('error' in payload ? payload.error : '설정을 저장하지 못했습니다.');
        return;
      }

      setCurrentSettings(payload);
      setSpreadsheetIdOrUrl(payload.spreadsheetId ?? '');
      setCurrencyUnit(payload.currencyUnit ?? '원');
      setAppTitle(payload.appTitle ?? '학급 매점');
      setBankTitle(payload.bankTitle ?? '학급 은행');
      setThemeColor(payload.themeColor ?? 'blue');
      setFontFamily(normalizeFontFamily(payload.fontFamily));
      setQrManualInputEnabled(Boolean(payload.qrManualInputEnabled));
      if (adminPassword.trim()) {
        setSavedAdminPassword(adminPassword.trim());
        setAdminPassword('');
      }
      await onSettingsSaved?.();
      setMessage('시스템 설정을 저장했고, 관리자 목록도 같은 시트에서 다시 불러왔습니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '설정을 저장하지 못했습니다.');
    } finally {
      setIsSaving(false);
    }
  }

  async function saveClassTimeZone() {
    setIsSavingTimeZone(true);
    setTimeZoneMessage('');
    try {
      const response = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classTimeZone: classTimeZone.trim() }),
      });
      const payload = (await response.json()) as SettingsResponse | { error: string };
      if (!response.ok || 'error' in payload) {
        setTimeZoneMessage('error' in payload ? payload.error : '학급 시간대를 저장하지 못했습니다.');
        return;
      }
      setCurrentSettings(payload);
      setClassTimeZone(payload.classTimeZone ?? classTimeZone.trim());
      await onSettingsSaved?.();
      setTimeZoneMessage('학급 시간대를 저장했습니다.');
    } catch (error) {
      setTimeZoneMessage(error instanceof Error ? error.message : '학급 시간대를 저장하지 못했습니다.');
    } finally {
      setIsSavingTimeZone(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-[2rem] bg-white p-6 shadow-sm ring-1 ring-black/5">
      <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <label className="block">
          <span className="text-sm font-black text-slate-800">학급 시간대 (IANA)</span>
          <input
            aria-label="학급 시간대 (IANA)"
            value={classTimeZone}
            onChange={(event) => setClassTimeZone(event.target.value)}
            placeholder="Asia/Seoul"
            className="mt-2 w-full rounded-xl border border-amber-200 bg-white px-3 py-3 text-sm font-bold text-slate-950 outline-none focus:border-amber-500"
          />
        </label>
        <p className="mt-2 text-xs font-bold leading-relaxed text-amber-900">시간대와 과제 반복 규칙 변경은 즉시 적용됩니다. 직전 완료 상태는 보상 없이 새 회차에 승계되며, 다음 경계부터 자연 초기화가 시작됩니다.</p>
        {timeZoneMessage ? <p role="status" className="mt-2 text-sm font-bold text-rose-700">{timeZoneMessage}</p> : null}
        <button type="button" disabled={isSavingTimeZone} onClick={saveClassTimeZone} className="mt-3 w-full rounded-xl bg-amber-300 py-3 font-black text-amber-950 disabled:opacity-60">
          {isSavingTimeZone ? '시간대 저장 중...' : '학급 시간대 저장'}
        </button>
      </section>
      <label className="mt-6 block">
        <span className="text-sm font-bold text-slate-700">Google Sheets 주소 또는 시트 ID</span>
        <input
          value={spreadsheetIdOrUrl}
          onChange={(event) => setSpreadsheetIdOrUrl(event.target.value)}
          placeholder="https://docs.google.com/spreadsheets/d/.../edit"
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-lg text-slate-950 outline-none transition focus:border-amber-500 focus:bg-white"
        />
      </label>

      <label className="mt-4 block">
        <span className="text-sm font-bold text-slate-700">학급 화폐 단위</span>
        <input
          aria-label="학급 화폐 단위"
          value={currencyUnit}
          onChange={(event) => setCurrencyUnit(event.target.value)}
          placeholder="원, 별, 포인트 등"
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-lg text-slate-950 outline-none transition focus:border-amber-500 focus:bg-white"
        />
      </label>

      <label className="mt-4 block">
        <span className="text-sm font-bold text-slate-700">매점 제목</span>
        <input
          aria-label="매점 제목"
          value={appTitle}
          onChange={(event) => setAppTitle(event.target.value)}
          placeholder="학급 매점"
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-lg text-slate-950 outline-none transition focus:border-amber-500 focus:bg-white"
        />
      </label>

      <label className="mt-4 block">
        <span className="text-sm font-bold text-slate-700">은행 제목</span>
        <input
          aria-label="은행 제목"
          value={bankTitle}
          onChange={(event) => setBankTitle(event.target.value)}
          placeholder="학급 은행"
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-lg text-slate-950 outline-none transition focus:border-amber-500 focus:bg-white"
        />
      </label>


      <label className="mt-4 block">
        <span className="text-sm font-bold text-slate-700">테마 색상</span>
        <select
          aria-label="테마 색상"
          value={themeColor}
          onChange={(event) => setThemeColor(event.target.value)}
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-lg font-bold text-slate-950 outline-none transition focus:border-amber-500 focus:bg-white"
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
        <span className="text-sm font-bold text-slate-700">글꼴</span>
        <select
          aria-label="글꼴"
          value={fontFamily}
          onChange={(event) => setFontFamily(normalizeFontFamily(event.target.value))}
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-lg font-bold text-slate-950 outline-none transition focus:border-amber-500 focus:bg-white"
        >
          {FONT_FAMILY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <label className="mt-4 flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <input
          aria-label="QR 값 직접 입력 허용"
          type="checkbox"
          checked={qrManualInputEnabled}
          onChange={(event) => setQrManualInputEnabled(event.target.checked)}
          className="mt-1 h-5 w-5 rounded border-slate-300 accent-slate-950"
        />
        <span>
          <span className="block text-sm font-black text-slate-800">QR 값 직접 입력 허용</span>
          <span className="mt-1 block text-xs font-bold text-slate-500">꺼두면 매점 결제와 은행/과제 화면에서 카메라 QR 인식만 사용할 수 있어, 다른 학생 번호를 직접 입력하는 악용을 줄일 수 있습니다.</span>
        </span>
      </label>

      <label className="mt-4 block">
        <span className="text-sm font-bold text-slate-700">관리자 암호 설정</span>
        <input
          aria-label="관리자 암호 설정"
          value={adminPassword}
          onChange={(event) => setAdminPassword(event.target.value)}
          placeholder={currentSettings?.adminPasswordConfigured ? '새 암호를 입력하면 변경됩니다' : '관리자 로그인 암호'}
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-lg text-slate-950 outline-none transition focus:border-amber-500 focus:bg-white"
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
        <p>은행 제목: {currentSettings?.bankTitle ?? bankTitle}</p>
        <p>테마 색상: {currentSettings?.themeColor ?? themeColor}</p>
        <p>글꼴: {FONT_FAMILY_OPTIONS.find((option) => option.value === (currentSettings?.fontFamily ?? fontFamily))?.label ?? '기본 글꼴'}</p>
        <p>QR 직접 입력: {(currentSettings?.qrManualInputEnabled ?? qrManualInputEnabled) ? '허용' : '차단'}</p>
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
        {isSaving ? '저장 중...' : '시스템 설정 저장'}
      </button>
    </form>
  );
}
