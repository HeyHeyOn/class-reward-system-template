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

type WizardStep = 'choose' | 'notice' | 'google' | 'vercel' | 'github' | 'settings' | 'deploy' | 'update';

export function AdminGeneratorPage() {
  const [session, setSession] = useState<GoogleSessionState>({ loading: true, enabled: true, authenticated: false });
  const [step, setStep] = useState<WizardStep>('choose');
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
        setStep((current) => current);
      } catch {
        if (!cancelled) {
          setSession({ loading: false, enabled: true, authenticated: false, error: '로그인 상태를 확인하지 못했습니다.' });
          setStep((current) => current);
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
          <p className="text-xs font-black tracking-[0.22em] text-slate-500">CLASS REWARD GENERATOR</p>
          <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-5xl">학급 보상 시스템 생성기</h1>
          <p className="mt-2 max-w-2xl text-sm font-bold text-slate-500 sm:text-base">
            구글 스프레드시트와 개인 Vercel 서버를 이용해 학급 매점·은행·관리자 페이지를 만드는 도구입니다.
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
        {!session.loading && step === 'choose' ? <ChooseStep onCreate={() => setStep('notice')} onUpdate={() => setStep('update')} /> : null}
        {!session.loading && step === 'notice' ? (
          <NoticeStep
            acknowledged={selfServiceAcknowledged}
            onAcknowledgedChange={setSelfServiceAcknowledged}
            onBack={() => setStep('choose')}
            onNext={() => setStep('google')}
          />
        ) : null}
        {!session.loading && step === 'google' ? (
          <GoogleLoginStep session={session} onBack={() => setStep('notice')} onNext={() => setStep('vercel')} />
        ) : null}
        {!session.loading && step === 'vercel' ? (
          <ExternalAccountStep
            eyebrow="VERCEL ACCOUNT"
            title="Vercel 로그인하기"
            description="Vercel 사이트에 회원가입 및 로그인을 진행해 주세요. 전 단계에서 쓰신 Google 계정을 이용하면 관리가 편리합니다."
            linkHref="https://vercel.com/login"
            linkLabel="Vercel 열기"
            onBack={() => setStep('google')}
            onNext={() => setStep('github')}
          />
        ) : null}
        {!session.loading && step === 'github' ? (
          <ExternalAccountStep
            eyebrow="GITHUB ACCOUNT"
            title="GitHub 로그인하기"
            description="GitHub 사이트에 회원가입 및 로그인을 진행해 주세요. 전 단계에서 쓰신 Google 계정을 이용하면 관리가 편리합니다."
            linkHref="https://github.com/login"
            linkLabel="GitHub 열기"
            onBack={() => setStep('vercel')}
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
            onBack={() => setStep('github')}
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
    { id: 'choose', label: '선택' },
    { id: 'notice', label: '일러두기' },
    { id: 'google', label: 'Google' },
    { id: 'vercel', label: 'Vercel' },
    { id: 'github', label: 'GitHub' },
    { id: 'settings', label: '생성' },
    { id: 'deploy', label: '완료' },
    { id: 'update', label: '업데이트' },
  ];
  const activeIndex = steps.findIndex((item) => item.id === step);
  return (
    <ol className="grid grid-cols-3 gap-2 rounded-[1.25rem] bg-white p-2 text-center text-xs font-black text-slate-500 shadow-sm sm:grid-cols-8">
      {steps.map((item, index) => (
        <li key={item.id} className={`rounded-xl px-2 py-2 ${index <= activeIndex ? 'bg-slate-950 text-white' : 'bg-slate-100'}`}>{item.label}</li>
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

function GoogleLoginStep({ session, onBack, onNext }: { session: GoogleSessionState; onBack: () => void; onNext: () => void }) {
  return (
    <section className="rounded-[1.75rem] border border-slate-300/70 bg-white p-8 shadow-sm">
      <p className="text-xs font-black tracking-[0.22em] text-slate-500">GOOGLE ACCOUNT</p>
      <h2 className="mt-1 text-2xl font-black">Google 로그인하기</h2>
      <p className="mt-2 max-w-2xl text-sm font-bold text-slate-500">
        이용하실 Google 계정으로 로그인하여 스프레드시트 권한을 부여해 주세요. 해당 계정으로 시스템 전용 스프레드시트를 생성하여 데이터를 읽고 씁니다.
      </p>
      <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-950">
        생성되는 시트를 임의로 삭제하거나 직접 수정하면 시스템이 정상 작동하지 않을 수 있습니다.
      </div>
      {session.error ? <p className="mt-3 rounded-2xl bg-red-50 p-3 text-sm font-black text-red-700">{session.error}</p> : null}
      {session.authenticated ? (
        <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-black text-emerald-800">
          Google 로그인 완료: {session.email ?? session.name}
        </div>
      ) : (
        <Link href="/api/google/login" className="mt-5 inline-flex rounded-2xl bg-slate-950 px-6 py-4 text-lg font-black text-white hover:bg-slate-800">
          Google로 로그인하기
        </Link>
      )}
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" onClick={onBack} className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-200">이전</button>
        <button type="button" disabled={!session.authenticated} onClick={onNext} className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-black text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600">Google 로그인 완료, 다음</button>
      </div>
    </section>
  );
}

function ExternalAccountStep({ eyebrow, title, description, linkHref, linkLabel, onBack, onNext }: { eyebrow: string; title: string; description: string; linkHref: string; linkLabel: string; onBack: () => void; onNext: () => void }) {
  return (
    <section className="rounded-[1.75rem] border border-slate-300/70 bg-white p-8 shadow-sm">
      <p className="text-xs font-black tracking-[0.22em] text-slate-500">{eyebrow}</p>
      <h2 className="mt-1 text-2xl font-black">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm font-bold text-slate-500">{description}</p>
      <a href={linkHref} target="_blank" rel="noreferrer" className="mt-5 inline-flex rounded-2xl bg-slate-950 px-6 py-4 text-lg font-black text-white hover:bg-slate-800">
        {linkLabel}
      </a>
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" onClick={onBack} className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-200">이전</button>
        <button type="button" onClick={onNext} className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-black text-white hover:bg-slate-800">로그인/가입을 완료했습니다</button>
      </div>
    </section>
  );
}

function ChooseStep({ onCreate, onUpdate }: { onCreate: () => void; onUpdate: () => void }) {
  return (
    <section className="rounded-[1.75rem] border border-slate-300/70 bg-white p-6 shadow-sm">
      <h2 className="text-2xl font-black">학급 보상 시스템 만들기</h2>
      <p className="mt-2 text-sm font-bold text-slate-500">새 시스템을 만들거나, 이미 만든 시스템을 최신 버전으로 업데이트할 수 있습니다.</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <button type="button" aria-label="새 시스템 생성하기" onClick={onCreate} className="rounded-3xl border border-slate-300 bg-slate-50 p-6 text-left hover:bg-slate-100">
          <span className="text-xl font-black text-slate-950">새 시스템 생성하기</span>
          <span className="mt-2 block text-sm font-bold text-slate-600">새 Google Sheet를 만들고 Vercel 배포까지 안내합니다.</span>
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
      <h2 className="mt-1 text-2xl font-black">시스템 업데이트하기</h2>
      <p className="mt-2 text-sm font-bold text-slate-500">
        기존 시스템 업데이트는 Google 로그인이 필요하지 않습니다. 기존 Google Sheet와 Vercel 환경변수는 그대로 두고, GitHub 저장소의 코드를 최신 템플릿으로 갱신합니다.
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
        href="https://github.com"
        target="_blank"
        rel="noreferrer"
      >
        GitHub 열기
      </a>
      <ol className="mt-5 space-y-3 text-sm font-bold text-slate-700">
        <DeploymentStep title="1단계: GitHub에 로그인하세요.">
          학급 보상 시스템을 만들 때 사용한 GitHub 계정으로 로그인합니다.
        </DeploymentStep>
        <DeploymentStep title="2단계: 자신의 학급 보상 시스템 저장소(repository)로 이동하세요.">
          Vercel 프로젝트의 Settings → Git에 표시된 저장소가 보통 선생님 계정에 복제된 학급 보상 시스템 저장소입니다.
        </DeploymentStep>
        <DeploymentStep title="3단계: Actions 탭으로 이동하세요.">
          저장소 상단 메뉴에서 Actions를 선택합니다.
        </DeploymentStep>
        <DeploymentStep title="4단계: Update from template 워크플로우를 선택하세요.">
          왼쪽 워크플로 목록에서 Update from template을 엽니다. 보이지 않으면 기존 개인 배포 저장소가 워크플로 파일을 아직 갖고 있지 않은 상태이므로 관리자에게 저장소 주소를 보내 워크플로 1회 추가를 요청하세요.
        </DeploymentStep>
        <DeploymentStep title="5단계: Run workflow를 눌러 업데이트 워크플로우를 시작하세요.">
          실행이 성공하면 최신 템플릿 코드가 선생님 복사본 저장소에 반영되고, 연결된 Vercel 프로젝트가 자동으로 새 배포를 시작합니다.
        </DeploymentStep>
        <DeploymentStep title="6단계: 실행 완료 후 2~3분 정도 기다리세요.">
          Vercel 배포가 Ready 상태가 되면 업데이트가 개인 서버에 반영됩니다. 기존 주소로 접속해 관리자 페이지, 학급 매점, 학급 은행이 정상적으로 열리는지 확인하세요.
        </DeploymentStep>
      </ol>
      <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-950">
        만약 Vercel에 Git 연결이 없는 프로젝트라면 GitHub Actions만으로는 업데이트되지 않습니다. 이 경우 기존 환경변수는 보존한 채 최신 템플릿 코드를 같은 Vercel 프로젝트에 다시 배포해야 합니다.
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
      <h2 className="text-2xl font-black">중요한 일러두기</h2>
      <p className="mt-2 text-sm font-bold text-slate-500">권한을 부여하기 전에 학급 보상 시스템의 작동 방식과 보안 책임을 먼저 확인해 주세요.</p>
      <div className="mt-5 space-y-4 text-sm font-bold text-slate-700">
        <NoticeBlock title="1) 학급 보상 시스템의 작동 방식">
          <li>학급 보상 시스템은 개인 서버를 이용하여 작동하는 온라인 웹 애플리케이션입니다.</li>
          <li>이용자 개인별 웹 앱 서버를 구축하여 전용 접속 URL을 생성하고, 어느 기기에서든 온라인으로 접속할 수 있습니다.</li>
          <li>학급 보상 시스템은 Google 스프레드시트를 데이터 저장소로 사용합니다.</li>
          <li>개인 Google 계정으로 시스템 전용 스프레드시트를 생성하고, 해당 시트를 이용해 데이터를 읽고 쓰는 방식으로 작동합니다.</li>
          <li>해당 시트가 삭제되면 작동이 불가하며, 가능하면 직접 수정하지 않는 것이 좋습니다.</li>
        </NoticeBlock>
        <NoticeBlock title="2) 필요한 권한 및 로그인 안내">
          <li>학급 보상 시스템은 Google, Vercel, GitHub 세 사이트의 로그인을 필요로 합니다.</li>
          <li>Google: 데이터를 읽고 쓰는 데 사용하며, Google 스프레드시트 권한을 이용합니다.</li>
          <li>Vercel: 시스템 운영을 위한 서버를 열고, 온라인 접속 URL을 만드는 데 사용합니다.</li>
          <li>Vercel 서버는 개인별 서버이며, 생성되는 URL 주소도 사용자 전용입니다. URL을 타인에게 공유하지 마세요.</li>
          <li>GitHub: 개발진이 업로드한 프로젝트에서 최신 버전을 복사해 서버에 설치 및 업데이트하는 데 사용합니다.</li>
        </NoticeBlock>
        <NoticeBlock title="3) 개인정보 및 보안 관련 안내">
          <li>이 시스템은 사용자의 개인 서버를 이용해 운영되므로, 개인정보 및 보안에 대한 책임은 사용자 본인에게 있습니다.</li>
          <li>개인 서버 URL과 암호가 함께 유출될 경우 Google Sheet 데이터에 접근하여 개인정보가 유출될 수 있습니다.</li>
          <li>접속 URL과 암호를 철저히 관리하시기 바랍니다.</li>
          <li>사용자의 정보보안 미흡으로 인해 발생하는 사고에 대해서는 개발진이 책임지지 않습니다.</li>
          <li>학생 명단에 실명이 아닌 번호, 별명 등을 이용하는 것도 개인정보 보호를 위한 방법이 될 수 있습니다.</li>
        </NoticeBlock>
      </div>
      <label className="mt-5 flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm font-black text-amber-950">
        <input
          aria-label="위 안내를 읽었으며 개인 서버 URL, 비밀번호, 구글 시트 관리 책임을 이해했습니다."
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledgedChange(event.target.checked)}
        />
        위 안내를 읽었으며, 개인 서버 URL·비밀번호·Google 시트 관리 책임을 이해했습니다.
      </label>
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" onClick={onBack} className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-200">이전</button>
        <button type="button" disabled={!acknowledged} onClick={onNext} className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-black text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600">Google 로그인으로 이동</button>
      </div>
    </section>
  );
}

function NoticeBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl bg-amber-50 p-4">
      <h3 className="font-black text-amber-950">{title}</h3>
      <ul className="mt-2 list-disc space-y-1 pl-5">{children}</ul>
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
        <h2 className="text-2xl font-black">Vercel 배포 준비하기</h2>
        <p className="mt-1 text-sm font-bold text-slate-500">복제할 템플릿과 학급 기본값을 확인하고, 시스템 전용 Google Sheet를 생성합니다.</p>

        <div className="mt-5 space-y-4">
          <GeneratorInput label="학급명" value={props.classNameValue} onChange={props.onClassNameChange} placeholder="예: 4학년 1반" />
          <GeneratorInput label="매점 이름" value={props.appTitle} onChange={props.onAppTitleChange} />
          <GeneratorInput label="은행 이름" value={props.bankTitle} onChange={props.onBankTitleChange} />
          <GeneratorInput label="화폐 단위" value={props.currencyUnit} onChange={props.onCurrencyUnitChange} />

          <label className="block text-sm font-black text-slate-700">
            테마
            <select
              aria-label="테마"
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base font-bold outline-none transition focus:border-slate-500 focus:bg-white"
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
            className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-black text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600"
          >
            {props.isCreating ? '생성 중...' : '주요 환경변수 만들고 배포 안내 보기'}
          </button>
        </div>

        {props.createError ? (
          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-black text-red-700" role="alert">
            {props.createError}
          </div>
        ) : null}
      </form>

      <section className="rounded-[1.75rem] border border-slate-300/70 bg-slate-950 p-5 text-white shadow-sm">
        <p className="text-xs font-black tracking-[0.22em] text-slate-300">CREATE MANIFEST</p>
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
      <h2 className="mt-1 text-2xl font-black">학급 보상 시스템 구축 완료</h2>
      <p className="mt-2 text-sm font-bold text-slate-500">시스템 전용 Google Sheet 생성이 완료되었습니다. 아래 순서대로 Vercel에서 개인 웹 앱 서버를 배포하세요.</p>
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
            <h3 className="text-xl font-black text-slate-950">Vercel에서 GitHub 프로젝트 복제 및 배포하기</h3>
            <p className="mt-1 text-slate-600">아래 순서대로 하면 선생님 전용 URL까지 만들 수 있습니다. 중간에 영어 화면이 나와도 버튼 이름만 따라가면 됩니다.</p>
            <a
              className="mt-4 inline-flex rounded-2xl bg-sky-600 px-4 py-3 font-black text-white hover:bg-sky-700"
              href={result.deploymentGuide.vercelImportUrl}
              target="_blank"
              rel="noreferrer"
            >
              Vercel 배포 페이지 열기
            </a>
            <ol className="mt-4 space-y-3">
              <DeploymentStep title="1단계: 복제할 템플릿과 GitHub 계정 확인">
                복제할 학급 보상 시스템 템플릿과 연결할 GitHub 계정을 확인하고, 저장소 이름을 입력합니다.
              </DeploymentStep>
              <DeploymentStep title="2단계: 주요 환경변수 붙여넣기">
                아래 값들을 Vercel Environment Variables에 붙여넣고 Deploy 버튼을 누릅니다. 비밀값은 외부에 공유하지 마세요.
              </DeploymentStep>
              <DeploymentStep title="3단계: 배포 완료까지 기다리기">
                배포가 완료될 때까지 기다립니다. 보통 2~3분 정도 걸립니다.
              </DeploymentStep>
              <DeploymentStep title="4단계: 도메인 주소 확인">
                배포가 완료되면 대시보드로 들어가서 도메인 주소를 복사해 보관합니다.
              </DeploymentStep>
              <DeploymentStep title="5단계: 시스템 주소 확인">
                관리자 페이지, 학급 매점, 학급 은행 주소를 확인합니다. 초기 비밀번호는 사용한 Google 계정 메일 주소입니다.
              </DeploymentStep>
              <DeploymentStep title="6단계: 보안 정보 보관">
                관리자 페이지 주소와 비밀번호는 절대로 유출하지 마세요. 이후 시스템 설정 탭에서 비밀번호를 수정할 수 있습니다.
              </DeploymentStep>
              <DeploymentStep title="7단계: 학생용 주소 배포">
                학급 매점 주소와 학급 은행 주소만 필요한 대상에게 안내하고, 관리자 주소는 별도로 관리합니다.
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
        className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base font-bold outline-none transition focus:border-slate-500 focus:bg-white"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}


