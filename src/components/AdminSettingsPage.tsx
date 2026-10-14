'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { FONT_FAMILY_OPTIONS, getFontFamilyCss, normalizeFontFamily, type FontFamily } from '@/lib/fontSettings';
import { THEME_PALETTES, type ThemeColor } from './uiTheme';
import { Button, Card, CardHeader, Field, Icon, Input, Select, Switch, cx } from './ui';
import { useQrObjectUrl } from '@/lib/qrCodeClient';
import { tenantApiPath, tenantFetch } from '@/lib/tenantApiPath';

type SettingsResponse = {
  spreadsheetId: string;
  currencyUnit: string;
  appTitle: string;
  bankTitle: string;
  themeColor: string;
  fontFamily: FontFamily;
  qrManualInputEnabled: boolean;
  source: 'runtime' | 'sheet' | 'env' | 'unset' | 'database';
  settingsVersion?: number;
  adminPasswordConfigured?: boolean;
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
  const [loadStatus, setLoadStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const isDatabase = currentSettings?.source === 'database';
  const saveAttempt = useRef<string | null>(null);
  const saveInFlight = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const adminQrUrl = useQrObjectUrl(savedAdminPassword ? {
    key: 'admin', endpoint: tenantApiPath('/api/qrcode'),
    body: { kind: 'admin', password: savedAdminPassword },
  } : null);

  useEffect(() => {
    let ignore = false;

    async function loadSettings() {
      const response = await tenantFetch('/api/settings', { cache: 'no-store' });
      const settings = (await response.json()) as SettingsResponse | { error: string };
      if (!response.ok || 'error' in settings) throw new Error('Settings unavailable');

      if (!ignore) {
        setCurrentSettings(settings);
        setLoadStatus('ready');
        setNeedsReload(false);
        setUncertain(false);
        saveAttempt.current = null;
        setSpreadsheetIdOrUrl(settings.spreadsheetId ?? '');
        setCurrencyUnit(settings.currencyUnit ?? '원');
        setAppTitle(settings.appTitle ?? '학급 매점');
        setBankTitle(settings.bankTitle ?? '학급 은행');
        setThemeColor(settings.themeColor ?? 'blue');
        setFontFamily(normalizeFontFamily(settings.fontFamily));
        setQrManualInputEnabled(Boolean(settings.qrManualInputEnabled));
      }
    }

    loadSettings().catch(() => {
      if (!ignore) {
        setLoadStatus('error');
        setMessage('현재 설정을 불러오지 못했어요.');
      }
    });

    return () => {
      ignore = true;
    };
  }, [loadAttempt]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loadStatus !== 'ready' || saveInFlight.current || needsReload) return;
    if (isDatabase && !saveAttempt.current) {
      if (!Number.isSafeInteger(currentSettings.settingsVersion)) {
        setNeedsReload(true); setMessage('설정을 다시 불러온 뒤 저장해 주세요.'); return;
      }
      saveAttempt.current = JSON.stringify({ operationId: crypto.randomUUID(), expectedSettingsVersion: currentSettings.settingsVersion,
        currencyUnit, appTitle, bankTitle, themeColor, fontFamily, qrManualInputEnabled });
    }
    saveInFlight.current = true;
    setIsSaving(true);
    setMessage('');

    try {
      const response = await tenantFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: isDatabase ? saveAttempt.current! : JSON.stringify({ spreadsheetIdOrUrl, currencyUnit, appTitle, bankTitle, themeColor, fontFamily, qrManualInputEnabled, adminPassword: adminPassword.trim() || undefined }),
      });
      const payload = (await response.json()) as SettingsResponse | { error: string };

      if (!response.ok || 'error' in payload) {
        if (isDatabase) {
          const definite = response.status >= 400 && response.status < 500;
          setUncertain(!definite);
          if (definite) saveAttempt.current = null;
          if (response.status === 409) setNeedsReload(true);
        }
        setMessage('error' in payload ? payload.error : '설정을 저장하지 못했어요.');
        return;
      }

      if (isDatabase && (payload.source !== 'database' || !Number.isSafeInteger(payload.settingsVersion))) {
        throw new Error('저장 결과를 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요.');
      }
      saveAttempt.current = null;
      setUncertain(false);
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
      try { await onSettingsSaved?.(); }
      catch { setMessage('설정은 저장했어요. 관리자 목록은 새로고침해 주세요.'); return; }
      setMessage(isDatabase ? '학급 설정을 저장했어요.' : '시스템 설정을 저장했고, 관리자 목록도 같은 시트에서 다시 불러왔어요.');
    } catch (error) {
      if (isDatabase) setUncertain(true);
      setMessage(isDatabase ? '저장 결과를 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요.'
        : error instanceof Error ? error.message : '설정을 저장하지 못했어요.');
    } finally {
      saveInFlight.current = false;
      setIsSaving(false);
    }
  }

  const unchanged = Boolean(currentSettings) && currencyUnit === (currentSettings?.currencyUnit ?? '원') && appTitle === (currentSettings?.appTitle ?? '학급 매점')
    && bankTitle === (currentSettings?.bankTitle ?? '학급 은행') && themeColor === (currentSettings?.themeColor ?? 'blue')
    && fontFamily === normalizeFontFamily(currentSettings?.fontFamily) && qrManualInputEnabled === Boolean(currentSettings?.qrManualInputEnabled)
    && (isDatabase || (spreadsheetIdOrUrl === (currentSettings?.spreadsheetId ?? '') && !adminPassword.trim()));
  const fontCss = getFontFamilyCss(fontFamily);
  const success = /저장했/.test(message) && !/새로고침/.test(message);

  return (
    <form method="post" onSubmit={handleSubmit} className="space-y-5">
      <fieldset disabled={isSaving || loadStatus !== 'ready' || uncertain} className="space-y-5 disabled:opacity-70">
        {!isDatabase && (
          <Card>
            <CardHeader title="Google Sheets 연결" description="이 학급이 쓰는 스프레드시트예요." />
            <Field label="Google Sheets 주소 또는 시트 ID" htmlFor="settings-sheet" className="mt-5"
              hint="개인 Sheets 배포는 Vercel 환경변수에 CLASS_STORE_STORAGE=sheets와 GOOGLE_SHEET_ID를 설정한 뒤 재배포해야 해요. 시트 ID는 관리자 화면에서 영구 변경할 수 없어요.">
              <Input id="settings-sheet" value={spreadsheetIdOrUrl} onChange={(event) => setSpreadsheetIdOrUrl(event.target.value)} placeholder="https://docs.google.com/spreadsheets/d/.../edit" />
            </Field>
          </Card>
        )}

        <Card data-tour="settings-names">
          <CardHeader title="이름과 화폐" description="매점과 은행 화면 맨 위에 보이는 이름, 학급에서 쓰는 화폐 단위예요." />
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <Field label="매점 이름" htmlFor="settings-app-title">
              <Input id="settings-app-title" aria-label="매점 제목" value={appTitle} onChange={(event) => setAppTitle(event.target.value)} placeholder="학급 매점" />
            </Field>
            <Field label="은행 이름" htmlFor="settings-bank-title">
              <Input id="settings-bank-title" aria-label="은행 제목" value={bankTitle} onChange={(event) => setBankTitle(event.target.value)} placeholder="학급 은행" />
            </Field>
            <Field label="화폐 단위" htmlFor="settings-currency" hint={`예: 1,000${currencyUnit || '원'}`}>
              <Input id="settings-currency" aria-label="학급 화폐 단위" value={currencyUnit} onChange={(event) => setCurrencyUnit(event.target.value)} placeholder="원, 별, 포인트" />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="화면 모양" description="학생이 보는 매점과 은행 화면의 색상과 글꼴이에요." />
          <fieldset className="mt-5">
            <legend className="mb-2 text-[13px] font-bold">테마 색상</legend>
            <div role="radiogroup" aria-label="테마 색상" className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {THEME_OPTIONS.map((option) => {
                const palette = THEME_PALETTES[option.value];
                const selected = themeColor === option.value;
                return (
                  <label key={option.value} className={cx('relative flex cursor-pointer flex-col gap-2.5 rounded-[14px] border p-2.5 transition-colors',
                    selected ? 'border-[var(--theme-accent-text)] ring-2 ring-[color-mix(in_srgb,var(--theme-accent-text)_25%,transparent)]' : 'border-[var(--crs-line)] hover:border-[var(--crs-line-strong)]')}>
                    <input type="radio" name="theme-color" value={option.value} checked={selected} onChange={() => setThemeColor(option.value)} aria-label={option.label} className="sr-only" />
                    <span aria-hidden="true" className="flex h-14 overflow-hidden rounded-[10px] border border-black/5" style={{ background: palette.shell }}>
                      <span className="m-2 flex flex-1 flex-col justify-between rounded-md p-1.5" style={{ background: palette.surface }}>
                        <span className="h-1.5 w-8 rounded-full" style={{ background: palette.text, opacity: 0.8 }} />
                        <span className="h-3 w-full rounded" style={{ background: palette.accentSolid }} />
                      </span>
                    </span>
                    <span className="flex items-center justify-between px-0.5 text-[13px] font-bold">
                      {option.label}
                      {selected ? <Icon name="check" size={15} className="text-[var(--theme-accent-text)]" /> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <Field label="글꼴" htmlFor="settings-font" className="mt-5">
            <Select id="settings-font" aria-label="글꼴" value={fontFamily} onChange={(event) => setFontFamily(normalizeFontFamily(event.target.value))}>
              {FONT_FAMILY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </Field>
          <p aria-hidden="true" data-tour="settings-font-preview" className="mt-3 rounded-[12px] bg-[var(--crs-subtle)] px-4 py-3 text-lg" style={fontCss ? { fontFamily: fontCss } : undefined}>
            {appTitle || '학급 매점'}, 연필 100{currencyUnit || '원'}
          </p>
        </Card>

        <Card>
          <CardHeader title="보안" description="학생이 다른 친구 번호로 결제하지 못하게 막아요." />
          <div className="mt-5 space-y-3">
            <Switch checked={qrManualInputEnabled} onChange={setQrManualInputEnabled} ariaLabel="QR 값 직접 입력 허용"
              label="QR 번호 직접 입력 허용" description="끄면 매점 결제와 은행에서 카메라로 QR을 찍어야만 해요." />
            {!isDatabase && (
              <Field label="관리자 암호" htmlFor="settings-admin-password" hint="암호는 해시로 Settings 시트에 저장돼요. QR은 저장 직후 이 화면에서만 보여요.">
                <Input id="settings-admin-password" aria-label="관리자 암호 설정" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)}
                  placeholder={currentSettings?.adminPasswordConfigured ? '새 암호를 입력하면 변경됩니다' : '관리자 로그인 암호'} />
              </Field>
            )}
            {!isDatabase && savedAdminPassword ? (
              <div className="rounded-[var(--crs-radius)] bg-[var(--crs-subtle)] p-4 text-center">
                <p className="text-sm font-bold">관리자 QR 로그인 코드</p>
                {adminQrUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="mx-auto mt-3 h-44 w-44 rounded-xl bg-white p-2" alt="관리자 로그인 QR" src={adminQrUrl} />
                ) : adminQrUrl === null ? (
                  <p className="mt-3 text-sm font-bold text-[var(--crs-danger-text)]">QR 생성 실패</p>
                ) : (
                  <p className="mt-3 text-sm text-[var(--theme-muted-text)]">QR 생성 중</p>
                )}
                <p className="mt-2 text-xs text-[var(--theme-muted-text)]">로그인 화면의 QR 로그인으로 찍으면 암호가 자동 입력돼요.</p>
              </div>
            ) : null}
          </div>
        </Card>
      </fieldset>

      <div data-tour="settings-save-bar" className="sticky bottom-4 z-40 flex flex-wrap items-center gap-3 rounded-[18px] border border-[var(--crs-line)] bg-[color-mix(in_srgb,var(--theme-surface)_92%,transparent)] px-4 py-3 shadow-[var(--crs-shadow)] backdrop-blur-md">
        <p role="status" className={cx('min-w-0 flex-1 text-[13px] font-semibold', message ? (success ? 'text-[var(--crs-success-text)]' : 'text-[var(--crs-warning-text)]') : 'text-[var(--theme-muted-text)]')}>
          {message || (loadStatus === 'loading' ? '설정을 불러오는 중이에요.' : unchanged ? '모든 변경 사항이 저장되어 있어요.' : '저장하지 않은 변경 사항이 있어요.')}
          {!isDatabase && loadStatus === 'ready' ? <span className="ml-2 font-medium text-[var(--theme-muted-text)]">학생 {linkedStudentCount ?? 0}명, 상품 {linkedProductCount ?? 0}개 연결됨</span> : null}
        </p>
        {loadStatus === 'error' || needsReload ? (
          <Button size="md" icon="refresh" onClick={() => {
            setLoadStatus('loading');
            setMessage('');
            setLoadAttempt((attempt) => attempt + 1);
          }}>설정 다시 불러오기</Button>
        ) : null}
        <Button type="submit" data-tour="settings-save" variant="primary" icon="check" loading={isSaving} disabled={isSaving || loadStatus !== 'ready' || needsReload || (unchanged && !uncertain)}>
          {isSaving ? '저장 중...' : uncertain ? '같은 요청으로 다시 확인' : '설정 저장'}
        </Button>
      </div>
    </form>
  );
}

// Stored values stay as they were; only the names changed: 'white' is the white page with blue
// accents (파랑), 'blue' the pastel blue (하늘).
const THEME_OPTIONS: Array<{ value: ThemeColor; label: string }> = [
  { value: 'white', label: '파랑' },
  { value: 'blue', label: '하늘' },
  { value: 'pink', label: '분홍' },
  { value: 'yellow', label: '노랑' },
  { value: 'green', label: '초록' },
  { value: 'purple', label: '보라' },
  { value: 'navy', label: '남색' },
  { value: 'black', label: '검은색' },
];
