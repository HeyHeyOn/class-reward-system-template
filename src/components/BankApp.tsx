'use client';

import styles from './classroom.module.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { getFontFamilyCss } from '@/lib/fontSettings';
import { normalizeThemeColor, themeStyles } from './uiTheme';
import { Button, Callout, Icon, IconButton, LoadingOverlay, Modal, Spinner } from './ui';
import {
  DEFAULT_BANK_SETTINGS,
  fetchBankSettings,
  fetchSession,
  fetchTasks,
  fetchTransactions,
  fetchBag,
  fetchTree,
  isSessionRequired,
  login,
  logout,
  type BankSettings,
  type ClassTreeStudentViewDto,
  type StudentBagDto,
  type StudentBankProfileDto,
  type StudentBankTaskDto,
  type StudentBankTransactionDto,
  waterTree,
} from './bank/bankClient';
import { BankHistory } from './bank/BankHistory';
import { BankHome, BankTasksMenu } from './bank/BankHome';
import { BankLogin } from './bank/BankLogin';
import { GlobalHeader } from './brand/GlobalHeader';
import { BankTasks } from './bank/BankTasks';
import { BankBagMenu, BankBagView } from './bank/BankBag';
import { BankTreeCard } from './bank/BankTreeCard';
import { BankPetCard } from './pet/BankPetCard';
import { fetchPet } from './pet/petBankClient';
import type { PetStudentViewDto } from '@/lib/petApi';
import type { TreePlay } from './classTree/TreeCanvas';
import { formatMoney } from './bank/format';
import { useTaskCompletion, type CompletionOutcome, type CompletionSuccess } from './bank/useTaskCompletion';
import { usePadletTaskRefresh } from './bank/usePadletTaskRefresh';

const BankTreeView = dynamic(() => import('./bank/BankTree').then((module) => module.BankTreeView));
const BankPetView = dynamic(() => import('./pet/BankPet').then((module) => module.BankPetView));

type Phase = 'checking' | 'unavailable' | 'login' | 'home';
type View = 'home' | 'history' | 'tasks' | 'tree' | 'bag' | 'pet';

const SESSION_ENDED = '로그인 시간이 끝났어요. 다시 로그인해 주세요.';
const LOAD_FAILED = '은행에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.';

/**
 * Personal bank for a student's own device. Before login only the QR login page is shown; the
 * session lives in an HttpOnly cookie, so every request below derives the student on the server.
 */
export function BankApp() {
  const [settings, setSettings] = useState<BankSettings>(DEFAULT_BANK_SETTINGS);
  const [settingsFailed, setSettingsFailed] = useState(false);
  const [phase, setPhase] = useState<Phase>('checking');
  const [profile, setProfile] = useState<StudentBankProfileDto | null>(null);
  const [view, setView] = useState<View>('home');
  const [tasks, setTasks] = useState<StudentBankTaskDto[] | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState('');
  const [transactions, setTransactions] = useState<StudentBankTransactionDto[] | null>(null);
  const [transactionLimit, setTransactionLimit] = useState(100);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [transactionsError, setTransactionsError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [loginNotice, setLoginNotice] = useState('');
  const [homeNotice, setHomeNotice] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [treeView, setTreeView] = useState<ClassTreeStudentViewDto | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState('');
  const [treeNotice, setTreeNotice] = useState('');
  const [watering, setWatering] = useState(false);
  const [treePlay, setTreePlay] = useState<TreePlay | null>(null);
  const [bag, setBag] = useState<StudentBagDto | null>(null);
  const [bagLoading, setBagLoading] = useState(false);
  const [bagError, setBagError] = useState('');
  const [petView, setPetView] = useState<PetStudentViewDto | null>(null);
  const [petLoading, setPetLoading] = useState(false);
  const [petError, setPetError] = useState('');
  // A watering whose answer was lost is resent with the same operation ID, so it is paid only once.
  const pendingWater = useRef<string | null>(null);
  // Bumped on every login/logout/expiry so responses from an earlier session are ignored.
  const generation = useRef(0);
  // Reads from before a confirmed mutation cannot replace its balance. Per-view tickets also
  // prevent an older request (or a replaced current view) from winning by arriving last.
  const mutationVersion = useRef(0);
  const reads = useRef({ tasks: 0, tree: 0, pet: 0, bag: 0, profile: 0, transactions: 0 });
  const taskReadsInFlight = useRef(new Set<{ generation: number }>());
  const historyPushed = useRef(false);
  const homeHeadingRef = useRef<HTMLHeadingElement>(null);
  const historyHeadingRef = useRef<HTMLHeadingElement>(null);
  const tasksHeadingRef = useRef<HTMLHeadingElement>(null);
  const treeHeadingRef = useRef<HTMLHeadingElement>(null);
  const bagHeadingRef = useRef<HTMLHeadingElement>(null);
  const petHeadingRef = useRef<HTMLHeadingElement>(null);

  const themeColor = normalizeThemeColor(settings.themeColor);
  const semantic = themeStyles(themeColor);
  const fontFamilyCss = getFontFamilyCss(settings.fontFamily);
  const unit = settings.currencyUnit || '원';

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await fetchBankSettings());
      setSettingsFailed(false);
    } catch {
      setSettingsFailed(true);
    }
  }, []);

  const expireSession = useCallback((notice = SESSION_ENDED) => {
    generation.current += 1;
    setProfile(null);
    setTasks(null);
    setTransactions(null);
    setTreeView(null);
    setPetView(null);
    setPetError('');
    setBag(null);
    setBagError('');
    setTreeError('');
    setTreeNotice('');
    pendingWater.current = null;
    setView('home');
    setLoginError('');
    setLoginNotice(notice);
    setPhase('login');
  }, []);

  const loadTasks = useCallback(async (silent = false) => {
    const current = generation.current;
    if (silent && [...taskReadsInFlight.current].some((read) => read.generation === current)) return;
    const ticket = ++reads.current.tasks;
    if (!silent) {
      setTasksLoading(true);
      setTasksError('');
    }
    const pendingRead = { generation: current };
    taskReadsInFlight.current.add(pendingRead);
    const result = await fetchTasks().finally(() => { taskReadsInFlight.current.delete(pendingRead); });
    if (current !== generation.current || ticket !== reads.current.tasks) return;
    if (!silent) setTasksLoading(false);
    if (result.ok) { setTasks(result.data.tasks); setTasksError(''); }
    else if (isSessionRequired(result)) expireSession();
    else if (!silent) setTasksError(result.error ?? '과제를 불러오지 못했어요.');
  }, [expireSession]);
  const refreshPadletTasks = useCallback(() => loadTasks(true), [loadTasks]);

  const loadTree = useCallback(async () => {
    const current = generation.current;
    const ticket = ++reads.current.tree;
    const beforeWrite = mutationVersion.current;
    setTreeLoading(true);
    setTreeError('');
    const result = await fetchTree();
    if (current !== generation.current || ticket !== reads.current.tree) return;
    setTreeLoading(false);
    if (result.ok) {
      setTreeView(result.data.tree);
      const balance = result.data.balance;
      if (beforeWrite === mutationVersion.current) {
        setProfile((existing) => existing ? { ...existing, student: { ...existing.student, balance } } : existing);
      }
    } else if (isSessionRequired(result)) {
      expireSession();
    } else if (result.status === 404) {
      setTreeView(null);
    } else {
      setTreeError(result.error ?? '학급 나무를 불러오지 못했어요.');
    }
  }, [expireSession]);

  const loadPet = useCallback(async () => {
    const current = generation.current;
    const ticket = ++reads.current.pet;
    const beforeWrite = mutationVersion.current;
    setPetLoading(true);
    setPetError('');
    const result = await fetchPet();
    if (current !== generation.current || ticket !== reads.current.pet) return;
    setPetLoading(false);
    if (result.ok) {
      setPetView(result.data.pet);
      const balance = result.data.balance;
      if (beforeWrite === mutationVersion.current) {
        setProfile((existing) => existing ? { ...existing, student: { ...existing.student, balance } } : existing);
      }
    } else if (isSessionRequired(result)) {
      expireSession();
    } else if (result.status === 404) {
      setPetView(null);
    } else {
      setPetError(result.error ?? '펫을 불러오지 못했어요.');
    }
  }, [expireSession]);

  const loadBag = useCallback(async () => {
    const current = generation.current;
    const ticket = ++reads.current.bag;
    setBagLoading(true);
    setBagError('');
    const result = await fetchBag();
    if (current !== generation.current || ticket !== reads.current.bag) return;
    setBagLoading(false);
    if (result.ok) setBag(result.data.bag);
    else if (isSessionRequired(result)) expireSession();
    else if (result.status === 404) setBag(null);
    else setBagError(result.error ?? '보관함을 열지 못했어요.');
  }, [expireSession]);

  const refreshProfile = useCallback(async () => {
    const current = generation.current;
    const ticket = ++reads.current.profile;
    const beforeWrite = mutationVersion.current;
    const result = await fetchSession();
    if (current !== generation.current || ticket !== reads.current.profile) return;
    if (result.ok) { if (beforeWrite === mutationVersion.current) setProfile(result.data); }
    else if (isSessionRequired(result)) expireSession();
  }, [expireSession]);

  const loadTransactions = useCallback(async () => {
    const current = generation.current;
    const ticket = ++reads.current.transactions;
    const beforeWrite = mutationVersion.current;
    setTransactionsLoading(true);
    setTransactionsError('');
    const result = await fetchTransactions();
    if (current !== generation.current || ticket !== reads.current.transactions) return;
    setTransactionsLoading(false);
    if (result.ok) {
      setTransactions(result.data.transactions);
      setTransactionLimit(result.data.limit);
      const balance = result.data.balance;
      if (beforeWrite === mutationVersion.current) {
        setProfile((existing) => existing ? { ...existing, student: { ...existing.student, balance } } : existing);
      }
    } else if (isSessionRequired(result)) {
      expireSession();
    } else {
      setTransactionsError(result.error ?? '거래 내역을 불러오지 못했어요.');
    }
  }, [expireSession]);

  const onCompletionSuccess = useCallback((payload: CompletionSuccess) => {
    mutationVersion.current += 1;
    reads.current.profile += 1;
    reads.current.tasks += 1;
    reads.current.transactions += 1;
    setTasksLoading(false);
    setTransactionsLoading(false);
    // An empty list means the server could not attach it to the (finished) completion: re-read it.
    if (payload.tasks.length > 0) setTasks(payload.tasks);
    else void loadTasks();
    setTransactions(null);
    if (payload.student) {
      const { name, balance } = payload.student;
      setProfile((existing) => existing ? { ...existing, student: { ...existing.student, name, balance } } : existing);
    } else {
      void refreshProfile();
    }
    // The task also grew the class tree or the pet: their cards show the new progress.
    // Also replaces initial in-flight reads, even if this completion did not grow a feature.
    void loadTree(); void loadPet();
  }, [loadPet, loadTasks, loadTree, refreshProfile]);
  const completion = useTaskCompletion({
    onSuccess: onCompletionSuccess,
    onPolicyFailure: () => { void loadTasks(); },
    onSessionExpired: () => expireSession(),
    onOutcome: (result) => setAnnouncement(result.kind === 'success'
      ? `보상 ${formatMoney(result.reward, unit)} 받았어요.${result.growth?.pet ? ` 펫 성장 +${result.growth.pet}.` : ''}${result.growth?.tree ? ` 나무 성장 +${result.growth.tree}.` : ''}`
      : result.message),
  });
  const { restore: restoreCompletion, reset: resetCompletion, reconcile: reconcileCompletion } = completion;
  usePadletTaskRefresh(phase === 'home' && (view === 'home' || view === 'tasks')
    && !completion.inFlight && !loggingOut && !!tasks?.some((task) => task.padlet || task.board), refreshPadletTasks);
  useEffect(() => {
    if (tasks) reconcileCompletion(tasks);
  }, [tasks, reconcileCompletion]);

  const enterHome = useCallback((next: StudentBankProfileDto) => {
    generation.current += 1;
    setProfile(next);
    setTasks(null);
    setTransactions(null);
    setTasksError('');
    setHomeNotice('');
    setView('home');
    setPhase('home');
    restoreCompletion(next.student.studentId);
    void loadTasks();
    void loadTree();
    void loadPet();
    void loadBag();
  }, [loadBag, loadPet, loadTasks, loadTree, restoreCompletion]);

  const checkSession = useCallback(async () => {
    setPhase('checking');
    const result = await fetchSession();
    if (result.ok) {
      enterHome(result.data);
    } else if (isSessionRequired(result)) {
      setPhase('login');
    } else {
      setPhase('unavailable');
    }
  }, [enterHome]);

  useEffect(() => {
    void Promise.resolve().then(() => {
      void loadSettings();
      void checkSession();
    });
  }, [checkSession, loadSettings]);

  useEffect(() => {
    const onPopState = () => {
      historyPushed.current = false;
      setView('home');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (phase !== 'home') return;
    (view === 'history' ? historyHeadingRef.current : view === 'tasks' ? tasksHeadingRef.current
      : view === 'tree' ? treeHeadingRef.current : view === 'bag' ? bagHeadingRef.current : view === 'pet' ? petHeadingRef.current : homeHeadingRef.current)?.focus();
  }, [phase, view]);

  async function handleLogin(studentQr: string): Promise<boolean> {
    setLoginBusy(true);
    setLoginError('');
    try {
      const result = await login(studentQr);
      if (result.ok) {
        setLoginNotice('');
        setAnnouncement(`${result.data.student.name}님, 로그인했어요.`);
        enterHome(result.data);
        return true;
      }
      setLoginError(result.error ?? '로그인하지 못했어요. 다시 시도해 주세요.');
      return false;
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setHomeNotice('');
    const result = await logout();
    setLoggingOut(false);
    if (!result.ok) {
      setHomeNotice('로그아웃하지 못했어요. 다시 눌러 주세요.');
      return;
    }
    resetCompletion();
    setAnnouncement('로그아웃했어요.');
    expireSession('로그아웃했어요. 다음에 또 만나요!');
  }

  async function refreshAll() {
    setRefreshing(true);
    try {
      await Promise.all([refreshProfile(), loadTasks(), loadTree(), loadPet(), loadBag()]);
    } finally {
      setRefreshing(false);
    }
  }

  function openSubView(next: Exclude<View, 'home'>) {
    setView(next);
    try {
      window.history.pushState({ crsBankView: next }, '');
      historyPushed.current = true;
    } catch {
      historyPushed.current = false;
    }
  }

  function openHistory() {
    void loadTransactions();
    openSubView('history');
  }

  function openTasks() {
    void loadTasks();
    openSubView('tasks');
  }

  function openBag() {
    void loadBag();
    openSubView('bag');
  }

  function openPet() {
    void loadPet();
    openSubView('pet');
  }

  function openTree() {
    setTreeNotice('');
    void loadTree();
    openSubView('tree');
  }

  async function handleWater() {
    if (watering) return;
    const operationId = pendingWater.current ?? crypto.randomUUID();
    pendingWater.current = operationId;
    setWatering(true);
    setTreeError('');
    setTreeNotice('');
    const current = generation.current;
    const before = treeView?.tree ? { drops: treeView.tree.drops, goal: treeView.tree.goal, apples: treeView.apples } : null;
    const result = await waterTree(operationId);
    if (current !== generation.current) return;
    setWatering(false);
    if (result.ok) {
      pendingWater.current = null;
      mutationVersion.current += 1;
      reads.current.profile += 1;
      reads.current.tree += 1;
      reads.current.transactions += 1;
      setTreeLoading(false);
      setTransactionsLoading(false);
      if (before) setTreePlay({ key: Date.now(), kind: 'feed', before, amount: 1 });
      setTreeView(result.data.tree);
      const balance = result.data.result.balanceAfter;
      setProfile((existing) => existing ? { ...existing, student: { ...existing.student, balance } } : existing);
      setTransactions(null);
      const message = result.data.result.ready ? '양분을 줬어요! 나무가 다 자랐어요.' : '양분을 줬어요! 나무가 조금 더 자랐어요.';
      setTreeNotice(message);
      setAnnouncement(message);
      return;
    }
    if (isSessionRequired(result)) { expireSession(); return; }
    // No answer: keep the operation ID so pressing again cannot pay twice.
    if (result.status !== 0) pendingWater.current = null;
    setTreeError(result.error ?? '양분을 주지 못했어요. 다시 눌러 주세요.');
    if (result.status === 409) void loadTree();
  }

  function closeHistory() {
    // An animation left unfinished must not replay when the tree opens again.
    setTreePlay(null);
    setView('home');
    if (historyPushed.current) {
      historyPushed.current = false;
      try { window.history.back(); } catch { /* the in-app view already changed */ }
    }
  }

  const outcome = completion.outcome;

  const shellStyle = useMemo(() => ({ ...semantic.variables, ...(fontFamilyCss ? { fontFamily: fontFamilyCss } : {}) }), [fontFamilyCss, semantic.variables]);

  return (
    <main data-testid="bank-shell" data-theme={themeColor} style={shellStyle}
      className={`${styles.bank} min-h-[100dvh] bg-[var(--theme-shell)] text-[var(--theme-text)]`}>
      <GlobalHeader audience="student" place={settings.className || settings.bankTitle}
        studentName={phase === 'home' && profile ? profile.student.name : null} />
      <div className="mx-auto w-full max-w-[640px] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:px-6">
        {settingsFailed ? (
          <div role="status" className="flex items-center justify-between gap-2 pt-[max(0.75rem,env(safe-area-inset-top))] text-[13px] font-semibold text-[var(--crs-warning-text)]">
            <span>기본 설정으로 보여 주고 있어요.</span>
            <Button size="sm" variant="secondary" onClick={() => void loadSettings()}>설정 다시 불러오기</Button>
          </div>
        ) : null}

        {phase === 'checking' ? (
          <div role="status" className="flex min-h-[70dvh] flex-col items-center justify-center gap-3 text-[15px] font-bold text-[var(--theme-muted-text)]">
            <Spinner size={28} className="text-[var(--theme-accent-text)]" />
            은행을 여는 중이에요.
          </div>
        ) : null}

        {phase === 'unavailable' ? (
          <div className="flex min-h-[70dvh] flex-col justify-center gap-4">
            <h1 className="text-[24px] font-black tracking-[-0.03em]">{settings.bankTitle}</h1>
            <div role="alert"><Callout tone="danger" title="은행을 열지 못했어요">{LOAD_FAILED}</Callout></div>
            <Button variant="primary" size="lg" block icon="refresh" onClick={() => void checkSession()}>다시 시도</Button>
          </div>
        ) : null}

        {phase === 'login' ? (
          <BankLogin title={settings.bankTitle} manualInputEnabled={settings.qrManualInputEnabled}
            busy={loginBusy} error={loginError} notice={loginNotice} onLogin={handleLogin} />
        ) : null}

        {phase === 'home' && profile && view === 'home' ? (
          <BankHome ref={homeHeadingRef} title={settings.bankTitle} name={profile.student.name} balance={profile.student.balance}
            currencyUnit={unit} refreshing={refreshing} loggingOut={loggingOut}
            onOpenHistory={openHistory} onRefresh={() => void refreshAll()} onLogout={() => void handleLogout()}>
            {homeNotice ? <div role="alert" className="mt-4"><Callout tone="danger">{homeNotice}</Callout></div> : null}
            <BankTasksMenu loading={tasks === null && tasksLoading}
              completable={(tasks ?? []).filter((task) => task.stage === 'READY' && task.completable).length}
              waiting={(tasks ?? []).filter((task) => task.stage === 'PENDING' || (task.stage === 'READY' && !task.completable)).length}
              completed={(tasks ?? []).filter((task) => task.stage === 'COMPLETED').length}
              attention={Boolean(completion.pending)} onOpen={openTasks} />
            {bag ? <BankBagMenu bag={bag} onOpen={openBag} /> : null}
            {petView ? <BankPetCard view={petView} onOpen={openPet} /> : null}
            {treeView ? <BankTreeCard view={treeView} onOpen={openTree} /> : null}
          </BankHome>
        ) : null}

        {phase === 'home' && profile && view === 'tasks' ? (
          <div className="pb-[max(2rem,calc(env(safe-area-inset-bottom)+1.5rem))] pt-[max(1rem,env(safe-area-inset-top))]">
            <header className="flex items-center gap-2">
              <IconButton icon="chevronLeft" label="홈으로 돌아가기" onClick={closeHistory} className="-ml-2" size="lg" />
              <h2 ref={tasksHeadingRef} tabIndex={-1} className="min-w-0 flex-1 truncate text-[22px] font-black tracking-[-0.03em] outline-none">내 과제</h2>
              <IconButton icon="refresh" label="과제 새로고침" onClick={() => void loadTasks()} disabled={tasksLoading} />
            </header>
            <BankTasks tasks={tasks} loading={tasksLoading} error={tasksError} currencyUnit={unit} showHeading={false}
              pending={completion.pending} busy={completion.inFlight}
              onComplete={(task) => completion.complete(task, profile.student.studentId)}
              onRecheck={completion.recheck} onRetry={() => void loadTasks()} />
          </div>
        ) : null}

        {phase === 'home' && profile && view === 'tree' ? (
          <BankTreeView ref={treeHeadingRef} view={treeView} balance={profile.student.balance} currencyUnit={unit}
            loading={treeLoading} watering={watering} error={treeError} notice={treeNotice} play={treePlay}
            onPlayEnd={() => setTreePlay(null)}
            onBack={closeHistory} onRefresh={() => void loadTree()} onWater={() => void handleWater()} />
        ) : null}

        {phase === 'home' && profile && view === 'pet' ? (
          <BankPetView ref={petHeadingRef} view={petView} balance={profile.student.balance} currencyUnit={unit}
            loading={petLoading} error={petError} onBack={closeHistory} onRefresh={() => void loadPet()}
            onChanged={(next, balance) => {
              mutationVersion.current += 1;
              reads.current.profile += 1;
              reads.current.pet += 1;
              reads.current.transactions += 1;
              setPetLoading(false);
              setTransactionsLoading(false);
              if (petView?.pet && !next.pet) void loadBag();
              setPetView(next);
              setTransactions(null);
              setProfile((existing) => existing ? { ...existing, student: { ...existing.student, balance } } : existing);
            }}
            onSessionExpired={() => expireSession()} onAnnounce={setAnnouncement} />
        ) : null}

        {phase === 'home' && profile && view === 'bag' ? (
          <BankBagView ref={bagHeadingRef} bag={bag} loading={bagLoading} error={bagError}
            onBack={closeHistory} onRefresh={() => void loadBag()} />
        ) : null}

        {phase === 'home' && profile && view === 'history' ? (
          <BankHistory ref={historyHeadingRef} name={profile.student.name} balance={profile.student.balance} currencyUnit={unit}
            transactions={transactions} limit={transactionLimit} loading={transactionsLoading} error={transactionsError}
            onBack={closeHistory} onRetry={() => void loadTransactions()} />
        ) : null}
      </div>

      <div role="status" aria-live="polite" data-testid="bank-announcer" className="sr-only">{announcement}</div>

      {completion.busyMessage ? <LoadingOverlay title="과제 완료 처리 중" message={completion.busyMessage} /> : null}
      {outcome && phase === 'home' ? (
        <CompletionDialog outcome={outcome} currencyUnit={unit} onClose={completion.dismissOutcome}
          onRecheck={() => { completion.dismissOutcome(); completion.recheck(); }} />
      ) : null}
    </main>
  );
}

function CompletionDialog({ outcome, currencyUnit, onClose, onRecheck }: {
  outcome: CompletionOutcome; currencyUnit: string; onClose: () => void; onRecheck: () => void;
}) {
  if (outcome.kind === 'success') {
    return (
      <Modal size="sm" tone="success" title="보상을 받았어요!" onClose={onClose}
        footer={<Button variant="primary" size="lg" block data-autofocus onClick={onClose}>확인</Button>}>
        <p className="text-[15px] font-semibold">&lsquo;{outcome.taskTitle}&rsquo; 과제를 완료했어요.</p>
        <p className="mt-3 text-center text-[34px] font-black tabular-nums tracking-[-0.04em] text-[var(--crs-success-text)]">+{formatMoney(outcome.reward, currencyUnit)}</p>
        {typeof outcome.balance === 'number' ? (
          <p className="mt-1 text-center text-sm font-semibold text-[var(--theme-muted-text)]">지금 잔액 {formatMoney(outcome.balance, currencyUnit)}</p>
        ) : null}
        {outcome.growth && (outcome.growth.pet > 0 || outcome.growth.tree > 0) ? (
          <ul aria-label="함께 자란 것" className="mt-3 flex flex-wrap justify-center gap-2">
            {outcome.growth.pet > 0 ? (
              <li className="inline-flex items-center gap-1.5 rounded-full bg-[var(--theme-accent-soft)] px-3 py-1 text-[14px] font-black text-[var(--theme-accent-text)]">
                <Icon name="paw" size={16} />펫 성장 +{outcome.growth.pet}
              </li>
            ) : null}
            {outcome.growth.tree > 0 ? (
              <li className="inline-flex items-center gap-1.5 rounded-full bg-[var(--theme-accent-soft)] px-3 py-1 text-[14px] font-black text-[var(--theme-accent-text)]">
                <Icon name="sprout" size={16} />나무 성장 +{outcome.growth.tree}
              </li>
            ) : null}
          </ul>
        ) : null}
      </Modal>
    );
  }
  const title = outcome.kind === 'policy' ? '아직 완료할 수 없어요'
    : outcome.kind === 'unknown' ? '완료 결과를 확인하지 못했어요'
      : outcome.kind === 'conflict' ? '완료 요청을 확인해야 해요'
        : '선생님 확인이 필요해요';
  return (
    <Modal size="sm" tone={outcome.kind === 'policy' || outcome.kind === 'unknown' ? 'warning' : 'danger'} title={title} onClose={onClose}
      footer={outcome.kind === 'unknown' ? (
        <>
          <Button variant="ghost" onClick={onClose}>나중에 확인</Button>
          <Button variant="primary" icon="refresh" data-autofocus onClick={onRecheck}>상태 다시 확인</Button>
        </>
      ) : <Button variant="primary" data-autofocus onClick={onClose}>확인</Button>}>
      <p className="text-[15px] leading-relaxed">{outcome.message}</p>
    </Modal>
  );
}
