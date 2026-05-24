'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
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

type GeneratorCreateResult = {
  ok: true;
  spreadsheetId: string;
  spreadsheetUrl: string;
  title: string;
  initializedSheets: string[];
  authMode: string;
  requiredVercelEnv: Array<{ name: string; value: string; secret: boolean }>;
  nextSteps: string[];
  deploymentGuide?: {
    ownership: string;
    vercelImportUrl: string;
    checklist: string[];
  };
};

type GoogleSessionState = {
  loading: boolean;
  enabled: boolean;
  authenticated: boolean;
  email?: string;
  name?: string;
  error?: string;
};

type WizardStep = 'login' | 'choose' | 'notice' | 'settings' | 'deploy' | 'update';

export function AdminGeneratorPage() {
  const [session, setSession] = useState<GoogleSessionState>({ loading: true, enabled: true, authenticated: false });
  const [step, setStep] = useState<WizardStep>('login');
  const [className, setClassName] = useState('');
  const [appTitle, setAppTitle] = useState('학급 매점');
  const [bankTitle, setBankTitle] = useState('학급 은행');
  const [currencyUnit, setCurrencyUnit] = useState('원');
  const [themeColor, setThemeColor] = useState('white');
  const [adminPasswordConfigured, setAdminPasswordConfigured] = useState(false);
  const [selfServiceAcknowledged, setSelfServiceAcknowledged] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createResult, setCreateResult] = useState<GeneratorCreateResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadSession() {
      try {
        const response = await fetch('/api/google/session');
        const data = await response.json();
        if (cancelled) return;
        const authenticated = Boolean(data.authenticated);
        setSession({
          loading: false,
          enabled: data.enabled !== false,
          authenticated,
          email: typeof data.email === 'string' ? data.email : undefined,
          name: typeof data.name === 'string' ? data.name : undefined,
        });
        setStep(authenticated ? 'choose' : 'login');
      } catch {
        if (!cancelled) {
          setSession({ loading: false, enabled: true, authenticated: false, error: '로그인 상태를 확인하지 못했습니다.' });
          setStep('login');
        }
      }
    }
    loadSession();
    return () => {
      cancelled = true;
    };
  }, []);

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

  async function handleCreate() {
    setIsCreating(true);
    setCreateError('');
    setCreateResult(null);
    try {
      const response = await fetch('/api/generator/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ className, appTitle, bankTitle, currencyUnit, themeColor, adminPasswordConfigured, selfServiceAcknowledged: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? '시스템을 생성하지 못했습니다.');
      setCreateResult(data as GeneratorCreateResult);
      setStep('deploy');
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : '시스템을 생성하지 못했습니다.');
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-100 p-3 text-slate-950 sm:p-5">
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <header className="rounded-[1.75rem] border border-slate-300/70 bg-white px-5 py-5 shadow-sm sm:px-7">
          <p className="text-xs font-black tracking-[0.22em] text-purple-600">CLASS REWARD GENERATOR</p>
          <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-5xl">학급 보상 시스템 생성기</h1>
          <p className="mt-2 max-w-2xl text-sm font-bold text-slate-500 sm:text-base">
            Google Sheets 템플릿을 만들고, 선생님 개인 Vercel에 배포하는 과정을 단계별로 안내합니다.
          </p>
          {session.authenticated ? (
            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm font-black">
              <span className="rounded-full bg-emerald-50 px-3 py-2 text-emerald-700">Google 로그인됨: {session.email ?? session.name}</span>
              <Link href="/api/google/logout" className="rounded-full bg-slate-100 px-3 py-2 text-slate-600 hover:bg-slate-200">로그아웃</Link>
            </div>
          ) : null}
        </header>

        <StepBar step={step} />

        {session.loading ? <CenteredCard title="로그인 상태 확인 중" description="잠시만 기다려 주세요." /> : null}
        {!session.loading && step === 'login' ? <LoginStep error={session.error} /> : null}
        {!session.loading && step === 'choose' ? <ChooseStep onCreate={() => setStep('notice')} onUpdate={() => setStep('update')} /> : null}
        {!session.loading && step === 'notice' ? (
          <NoticeStep
            acknowledged={selfServiceAcknowledged}
            onAcknowledgedChange={setSelfServiceAcknowledged}
            onBack={() => setStep('choose')}
            onNext={() => setStep('settings')}
          />
        ) : null}
        {!session.loading && step === 'settings' ? (
          <SettingsStep
            classNameValue={className}
            appTitle={appTitle}
            bankTitle={bankTitle}
            currencyUnit={currencyUnit}
            themeColor={themeColor}
            adminPasswordConfigured={adminPasswordConfigured}
            preview={preview}
            isCreating={isCreating}
            createError={createError}
            onClassNameChange={setClassName}
            onAppTitleChange={setAppTitle}
            onBankTitleChange={setBankTitle}
            onCurrencyUnitChange={setCurrencyUnit}
            onThemeColorChange={setThemeColor}
            onAdminPasswordConfiguredChange={setAdminPasswordConfigured}
            onBack={() => setStep('notice')}
            onCreate={handleCreate}
          />
        ) : null}
        {!session.loading && step === 'deploy' && createResult ? <CreateResultPanel result={createResult} /> : null}
        {!session.loading && step === 'update' ? <UpdateGuide onBack={() => setStep('choose')} /> : null}
      </section>
    </main>
  );
}

function StepBar({ step }: { step: WizardStep }) {
  const steps: Array<{ id: WizardStep; label: string }> = [
    { id: 'login', label: '로그인' },
    { id: 'choose', label: '선택' },
    { id: 'notice', label: '확인' },
    { id: 'settings', label: '설정' },
    { id: 'deploy', label: '배포' },
    { id: 'update', label: '업데이트' },
  ];
  const activeIndex = steps.findIndex((item) => item.id === step);
  return (
    <ol className="grid grid-cols-3 gap-2 rounded-[1.25rem] bg-white p-2 text-center text-xs font-black text-slate-500 shadow-sm sm:grid-cols-6">
      {steps.map((item, index) => (
        <li key={item.id} className={`rounded-xl px-2 py-2 ${index <= activeIndex ? 'bg-purple-600 text-white' : 'bg-slate-100'}`}>{item.label}</li>
      ))}
    </ol>
  );
}

function CenteredCard({ title, description }: { title: string; description: string }) {
  return (
    <section className="rounded-[1.75rem] border border-slate-300/70 bg-white p-8 text-center shadow-sm">
      <h2 className="text-2xl font-black">{title}</h2>
      <p className="mt-2 text-sm font-bold text-slate-500">{description}</p>
    </section>
  );
}

function LoginStep({ error }: { error?: string }) {
  return (
    <section className="rounded-[1.75rem] border border-slate-300/70 bg-white p-8 text-center shadow-sm">
      <h2 className="text-2xl font-black">먼저 Google 로그인을 해 주세요</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm font-bold text-slate-500">
        선생님 Google 계정에 새 스프레드시트를 만들기 위해 최초 1회 로그인이 필요합니다. 로그인 전에는 다른 설정을 보여주지 않습니다.
      </p>
      {error ? <p className="mt-3 rounded-2xl bg-red-50 p-3 text-sm font-black text-red-700">{error}</p> : null}
      <Link href="/api/google/login" className="mt-6 inline-flex rounded-2xl bg-purple-600 px-6 py-4 text-lg font-black text-white hover:bg-purple-700">
        Google로 시작하기
      </Link>
    </section>
  );
}

function ChooseStep({ onCreate, onUpdate }: { onCreate: () => void; onUpdate: () => void }) {
  return (
    <section className="rounded-[1.75rem] border border-slate-300/70 bg-white p-6 shadow-sm">
      <h2 className="text-2xl font-black">무엇을 할까요?</h2>
      <p className="mt-2 text-sm font-bold text-slate-500">필요한 작업을 먼저 고르면, 그 작업에 필요한 설명만 단계별로 보여드립니다.</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <button type="button" aria-label="새 시스템 생성하기" onClick={onCreate} className="rounded-3xl border border-purple-200 bg-purple-50 p-6 text-left hover:bg-purple-100">
          <span className="text-xl font-black text-purple-800">새 시스템 생성하기</span>
          <span className="mt-2 block text-sm font-bold text-purple-700">새 Google Sheet를 만들고 Vercel 배포까지 안내합니다.</span>
        </button>
        <button type="button" aria-label="기존 시스템 업데이트하기" onClick={onUpdate} className="rounded-3xl border border-sky-200 bg-sky-50 p-6 text-left hover:bg-sky-100" aria-describedby="update-help">
          <span className="text-xl font-black text-sky-800">기존 시스템 업데이트하기</span>
          <span id="update-help" className="mt-2 block text-sm font-bold text-sky-700">이미 만든 학급 앱을 최신 버전으로 다시 배포하는 방법을 안내합니다.</span>
        </button>
      </div>
    </section>
  );
}

function UpdateGuide({ onBack }: { onBack: () => void }) {
  return (
    <section className="rounded-[1.75rem] border border-sky-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-black tracking-[0.22em] text-sky-600">UPDATE GUIDE</p>
      <h2 className="mt-1 text-2xl font-black">기존 앱 업데이트 안내</h2>
      <p className="mt-2 text-sm font-bold text-slate-500">
        데이터가 들어 있는 Google 스프레드시트는 그대로 사용합니다. 다만 Redeploy만 누르면 최신 템플릿을 가져오는 것이 아니라, Vercel 프로젝트가 최신 코드가 들어 있는 Git 저장소와 연결되어 있어야 합니다.
      </p>
      <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-900">
        <p className="font-black">업데이트 전에 안심해도 되는 점</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>학생 명단, 재고, 거래 내역은 Google Sheets에 남아 있습니다.</li>
          <li>환경변수를 다시 만들 필요는 없습니다. 기존 Vercel 프로젝트의 값을 그대로 사용합니다.</li>
          <li>새 시스템 생성 버튼을 다시 누르지 않습니다. 그러면 새 시트가 생겨 기존 데이터와 분리됩니다.</li>
        </ul>
      </div>
      <a
        className="mt-5 inline-flex rounded-2xl bg-sky-600 px-5 py-3 font-black text-white hover:bg-sky-700"
        href="https://vercel.com/dashboard"
        target="_blank"
        rel="noreferrer"
      >
        Vercel 프로젝트 목록 열기
      </a>
      <ol className="mt-5 space-y-3 text-sm font-bold text-slate-700">
        <DeploymentStep title="1단계: 기존 프로젝트 찾기">
          Vercel 대시보드에서 class-store 또는 학급 보상 시스템 프로젝트를 선택합니다. 새 프로젝트를 만들지 말고, 이미 학생들이 접속하던 주소의 프로젝트를 엽니다.
        </DeploymentStep>
        <DeploymentStep title="2단계: Settings → Git 연결 상태 확인">
          프로젝트의 Settings → Git 화면에서 Git 저장소가 연결되어 있는지 확인합니다. Git 저장소가 연결되어 있지 않음 상태라면 Redeploy는 예전 업로드본을 다시 빌드할 뿐 최신 템플릿을 가져오지 못합니다.
        </DeploymentStep>
        <DeploymentStep title="3단계: 연결된 GitHub 저장소 열기">
          Settings → Git에 표시된 GitHub 저장소를 엽니다. Vercel은 원본 템플릿이 아니라 선생님 계정의 복사본 저장소를 배포하므로, 이 저장소를 먼저 최신화해야 합니다.
        </DeploymentStep>
        <DeploymentStep title="4단계: Actions → Update from template 실행">
          GitHub 저장소에서 Actions → Update from template을 열고 Run workflow 버튼을 누릅니다. 성공하면 최신 템플릿 코드가 선생님 복사본 저장소에 커밋되고, Vercel이 자동으로 새 배포를 시작합니다.
          <span className="mt-2 block rounded-xl bg-amber-50 px-3 py-2 text-xs font-black text-amber-900">
            Update from template이 보이지 않으면 기존 개인 배포 저장소는 워크플로 파일이 아직 복사되지 않은 상태입니다. 관리자에게 저장소 주소를 보내 워크플로 1회 추가를 요청하세요. 이후부터는 이 버튼으로 직접 업데이트할 수 있습니다.
          </span>
        </DeploymentStep>
        <DeploymentStep title="5단계: Deployments 탭에서 새 배포 확인">
          Vercel 프로젝트의 Deployments 탭을 열어 새 배포가 Ready가 되었는지 확인합니다. 자동 배포가 시작되지 않았다면 그때 최근 배포의 Redeploy를 누릅니다.
        </DeploymentStep>
        <DeploymentStep title="6단계: Git 연결이 없으면 관리자에게 재배포 요청">
          Git 연결이 없는 프로젝트는 Vercel 화면의 Redeploy만으로 업데이트할 수 없습니다. 기존 프로젝트 이름과 앱 주소를 관리자에게 전달해 최신 템플릿 코드를 같은 Vercel 프로젝트에 다시 배포해야 합니다.
        </DeploymentStep>
        <DeploymentStep title="7단계: 환경변수는 건드리지 않기">
          GOOGLE_SHEET_ID, GOOGLE_REFRESH_TOKEN, ADMIN_PASSWORD 같은 값은 기존 그대로 둡니다. 값을 지우거나 새로 만들면 기존 앱이 시트를 읽지 못할 수 있습니다.
        </DeploymentStep>
        <DeploymentStep title="8단계: Ready 확인 후 기존 주소로 접속">
          배포 상태가 Ready가 되면 기존 vercel.app 주소로 접속합니다. 주소가 바뀌지 않아야 학생용 QR이나 즐겨찾기를 다시 나눠줄 필요가 없습니다.
        </DeploymentStep>
      </ol>
      <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-950">
        업데이트 뒤에는 관리자 페이지에서 생성기 탭이 사라졌는지 확인하고, 학생 명단/재고 관리/과제 설정 상단 버튼명이 짧게 바뀌었는지 확인하세요.
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" onClick={onBack} className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-200">처음 선택으로 돌아가기</button>
      </div>
    </section>
  );
}

function NoticeStep({ acknowledged, onAcknowledgedChange, onBack, onNext }: { acknowledged: boolean; onAcknowledgedChange: (value: boolean) => void; onBack: () => void; onNext: () => void }) {
  return (
    <section className="rounded-[1.75rem] border border-amber-200 bg-white p-6 shadow-sm">
      <h2 className="text-2xl font-black">시작 전에 확인해 주세요</h2>
      <p className="mt-2 text-sm font-bold text-slate-500">이 생성기는 운영비를 줄이기 위해 선생님 개인 계정 기반 셀프 배포 방식을 사용합니다.</p>
      <ul className="mt-5 space-y-3 text-sm font-bold text-slate-700">
        <li className="rounded-2xl bg-amber-50 p-4">운영 앱은 선생님 개인 Vercel 프로젝트에 배포됩니다.</li>
        <li className="rounded-2xl bg-amber-50 p-4">데이터는 선생님 개인 Google 계정의 스프레드시트에 저장됩니다.</li>
        <li className="rounded-2xl bg-amber-50 p-4">생성기는 시트 생성과 배포 안내를 도와주며, 여러 학급 앱을 대신 호스팅하지 않습니다.</li>
        <li className="rounded-2xl bg-amber-50 p-4">배포 중 막히면 오류 문구를 복사해 전달하면 이어서 도와드릴 수 있습니다.</li>
      </ul>
      <label className="mt-5 flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm font-black text-amber-950">
        <input
          aria-label="위 내용을 충분히 숙지했습니다."
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledgedChange(event.target.checked)}
        />
        위 내용을 충분히 숙지했습니다.
      </label>
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" onClick={onBack} className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-200">이전</button>
        <button type="button" disabled={!acknowledged} onClick={onNext} className="rounded-2xl bg-purple-600 px-4 py-3 text-sm font-black text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600">기본 설정으로 이동</button>
      </div>
    </section>
  );
}

function SettingsStep(props: {
  classNameValue: string;
  appTitle: string;
  bankTitle: string;
  currencyUnit: string;
  themeColor: string;
  adminPasswordConfigured: boolean;
  preview: string;
  isCreating: boolean;
  createError: string;
  onClassNameChange: (value: string) => void;
  onAppTitleChange: (value: string) => void;
  onBankTitleChange: (value: string) => void;
  onCurrencyUnitChange: (value: string) => void;
  onThemeColorChange: (value: string) => void;
  onAdminPasswordConfiguredChange: (value: boolean) => void;
  onBack: () => void;
  onCreate: () => void;
}) {
  return (
    <section className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
      <form className="rounded-[1.75rem] border border-slate-300/70 bg-white p-5 shadow-sm" onSubmit={(event) => event.preventDefault()}>
        <h2 className="text-2xl font-black">시트 생성을 위한 기본 설정</h2>
        <p className="mt-1 text-sm font-bold text-slate-500">입력한 값으로 Google Sheets 템플릿이 만들어집니다.</p>

        <div className="mt-5 space-y-4">
          <GeneratorInput label="학급명" value={props.classNameValue} onChange={props.onClassNameChange} placeholder="예: 4학년 1반" />
          <GeneratorInput label="매점 이름" value={props.appTitle} onChange={props.onAppTitleChange} />
          <GeneratorInput label="은행 이름" value={props.bankTitle} onChange={props.onBankTitleChange} />
          <GeneratorInput label="화폐 단위" value={props.currencyUnit} onChange={props.onCurrencyUnitChange} />

          <label className="block text-sm font-black text-slate-700">
            테마
            <select
              aria-label="테마"
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base font-bold outline-none transition focus:border-purple-500 focus:bg-white"
              value={props.themeColor}
              onChange={(event) => props.onThemeColorChange(event.target.value)}
            >
              {THEMES.map((theme) => <option key={theme.value} value={theme.value}>{theme.label}</option>)}
            </select>
          </label>

          <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-black text-slate-700">
            <input
              aria-label="관리자 암호 설정 완료"
              type="checkbox"
              checked={props.adminPasswordConfigured}
              onChange={(event) => props.onAdminPasswordConfiguredChange(event.target.checked)}
            />
            관리자 암호 설정 완료
          </label>
        </div>

        <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-900">
          <p className="font-black">실제 Google Sheets 템플릿 생성을 실행합니다.</p>
          <p className="mt-1">학생 정보는 자동 수집하지 않고, 필수 시트/헤더/설정값만 만듭니다.</p>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={props.onBack} className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-200">이전</button>
          <button
            type="button"
            disabled={props.isCreating}
            onClick={props.onCreate}
            className="rounded-2xl bg-purple-600 px-4 py-3 text-sm font-black text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600"
          >
            {props.isCreating ? '생성 중...' : 'Google Sheets 생성하고 Vercel 안내 보기'}
          </button>
        </div>

        {props.createError ? (
          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-black text-red-700" role="alert">
            {props.createError}
          </div>
        ) : null}
      </form>

      <section className="rounded-[1.75rem] border border-slate-300/70 bg-slate-950 p-5 text-white shadow-sm">
        <p className="text-xs font-black tracking-[0.22em] text-purple-300">CREATE MANIFEST</p>
        <h2 className="text-2xl font-black">생성 계획 미리보기</h2>
        <pre data-testid="generator-preview" className="mt-4 max-h-[620px] overflow-auto whitespace-pre-wrap rounded-2xl bg-black/40 p-4 text-xs leading-6 text-slate-100 sm:text-sm">
          {props.preview}
        </pre>
      </section>
    </section>
  );
}

function CreateResultPanel({ result }: { result: GeneratorCreateResult }) {
  return (
    <section className="rounded-[1.75rem] border border-emerald-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-black tracking-[0.22em] text-emerald-600">FINAL STEP</p>
      <h2 className="mt-1 text-2xl font-black">생성 완료</h2>
      <p className="mt-2 text-sm font-bold text-slate-500">이제 아래 순서대로 Vercel에서 선생님 전용 URL을 만들면 됩니다.</p>
      <div className="mt-4 grid gap-3 text-sm font-bold text-slate-700 lg:grid-cols-2">
        <div className="rounded-2xl bg-emerald-50 p-4">
          <p className="text-slate-500">스프레드시트</p>
          <a className="break-all text-emerald-700 underline" href={result.spreadsheetUrl} target="_blank" rel="noreferrer">{result.title}</a>
        </div>
        <div className="rounded-2xl bg-slate-50 p-4">
          <p className="text-slate-500">GOOGLE_SHEET_ID</p>
          <code className="break-all text-slate-950">{result.spreadsheetId}</code>
        </div>
      </div>
      {result.deploymentGuide ? (
        <div className="mt-4 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm font-bold text-slate-700">
          <p className="text-slate-500">운영 소유 구조</p>
          <p className="mt-1 text-lg font-black text-slate-950">{result.deploymentGuide.ownership}</p>

          <div className="mt-4 rounded-2xl border border-sky-200 bg-white p-4">
            <h3 className="text-xl font-black text-slate-950">이제 Vercel에서 이렇게 누르세요</h3>
            <p className="mt-1 text-slate-600">아래 순서대로 하면 선생님 전용 URL까지 만들 수 있습니다. 중간에 영어 화면이 나와도 버튼 이름만 따라가면 됩니다.</p>
            <a
              className="mt-4 inline-flex rounded-2xl bg-sky-600 px-4 py-3 font-black text-white hover:bg-sky-700"
              href={result.deploymentGuide.vercelImportUrl}
              target="_blank"
              rel="noreferrer"
            >
              1단계: Vercel 배포 페이지 열기
            </a>
            <ol className="mt-4 space-y-3">
              <DeploymentStep title="2단계: Vercel에 로그인">
                GitHub 계정으로 Vercel에 로그인합니다. Google로 Vercel에 로그인한 경우에도 프로젝트 가져오기 단계에서는 GitHub 연결을 한 번 더 요구할 수 있습니다.
              </DeploymentStep>
              <DeploymentStep title="3단계: GitHub 연결하기">
                화면에 Continue with GitHub가 보이면 그 버튼을 누릅니다. 이 버튼은 배포 버튼이 아니라, Vercel이 GitHub 저장소 목록을 볼 수 있도록 연결하는 단계입니다.
              </DeploymentStep>
              <DeploymentStep title="4단계: 학급 보상 시스템 저장소 선택">
                GitHub 연결이 끝나면 Import Git Repository 목록에서 학급 보상 시스템 템플릿 저장소를 찾고 Import를 누릅니다. 저장소가 보이지 않으면 검색창에 저장소 주소를 붙여넣거나, GitHub 권한 화면에서 해당 저장소 접근을 허용해야 합니다.
              </DeploymentStep>
              <DeploymentStep title="5단계: 연결되는 저장소 구조 이해">
                Vercel은 템플릿 원본이 아니라 선생님 GitHub 계정에 만든 복사본 저장소를 연결합니다. 그래서 나중에 업데이트하려면 GitHub의 템플릿 동기화 워크플로를 실행한 뒤 Vercel이 다시 배포되도록 해야 합니다.
              </DeploymentStep>
              <DeploymentStep title="6단계: 환경변수 6개 입력">
                운영 앱이 생성된 시트를 읽고 쓰려면 6개 환경변수를 모두 입력해야 합니다. GOOGLE_SHEET_ID, GOOGLE_CLIENT_ID는 일반값이고, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, ADMIN_PASSWORD, AUTH_SECRET은 비밀값입니다.
              </DeploymentStep>
              <DeploymentStep title="7단계: 배포 실행">
                Deploy 버튼을 누른 뒤 Ready가 나올 때까지 기다립니다. 보통 1~3분 정도 걸립니다.
              </DeploymentStep>
              <DeploymentStep title="8단계: 전용 URL 확인">
                배포 완료 후 제공되는 vercel.app 주소가 선생님 전용 URL입니다. 그 주소를 저장해두고 학생용 키오스크와 관리자 화면으로 사용하면 됩니다.
              </DeploymentStep>
            </ol>
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-amber-950">
              막히면 화면을 닫지 말고 오류 문구를 복사해서 관리자에게 전달하세요. 특히 Environment Variables, Deploy, Ready, Error 문구가 중요합니다.
            </div>
          </div>

          <div className="mt-4 rounded-2xl bg-white p-4">
            <p className="font-black text-slate-950">붙여넣을 값 요약</p>
            <p className="mt-1 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-black text-red-700">
              비밀값은 다른 사람에게 공유하지 말고 Vercel 환경변수 칸에만 붙여넣으세요. 화면 캡처를 공유할 때는 GOOGLE_CLIENT_SECRET과 GOOGLE_REFRESH_TOKEN을 가려야 합니다.
            </p>
            <ul className="mt-2 space-y-2">
              {result.requiredVercelEnv.map((env) => (
                <li key={env.name} className="rounded-xl bg-slate-50 p-3">
                  <p className="text-slate-500">{env.name}{env.secret ? ' (비밀값)' : ''}</p>
                  <code className="break-all text-slate-950">{env.value}</code>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function DeploymentStep({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="rounded-2xl bg-slate-50 p-3">
      <p className="font-black text-slate-950">{title}</p>
      <p className="mt-1 text-slate-600">{children}</p>
    </li>
  );
}

function GeneratorInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="block text-sm font-black text-slate-700">
      {label}
      <input
        aria-label={label}
        className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base font-bold outline-none transition focus:border-purple-500 focus:bg-white"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
