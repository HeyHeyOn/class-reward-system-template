'use client';

import { useId, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import { Badge, Button, Callout, Icon, LoadingOverlay, Modal, buttonClass, cx } from '@/components/ui';

export const XLSX_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const subscribe = () => () => {};
const SHEET_LABELS: Record<string, string> = {
  Students: '학생', Products: '상품', Settings: '설정', Tasks: '과제', Promotions: '행사', PromotionProducts: '행사 상품',
  Transactions: '거래 내역', Adjustments: '지급·회수 내역', TaskAssignments: '과제 부여 기록', TaskCompletions: '과제 완료 기록',
};

type Issue = { level: 'error' | 'warning'; sheet: string | null; row: number | null; message: string };
type Summary = {
  students: number; activeStudents: number; totalBalance: number; products: number; activeProducts: number; totalStock: number;
  promotions: number; tasks: number; activeTasks: number; readyAssignments: number; completedAssignments: number;
  history: { transactions: number; adjustments: number; taskAssignments: number; taskCompletions: number };
  settings: { currencyUnit: string; appTitle: string; bankTitle: string };
};
export type XlsxImportPreview = {
  ok: true; mode: 'start' | 'import'; fileName: string; fileDigest: string; canImport: boolean;
  blocked: 'NOT_EMPTY' | null; blockedMessage?: string; summary: Summary; issues: Issue[];
  students: { studentId: string; name: string; balance: number; status: 'ACTIVE' | 'INACTIVE' }[];
  products: { productId: string; name: string; price: number; stock: number; isActive: boolean }[];
  promotions: { promotionId: string; name: string; isActive: boolean; products: number }[];
  tasks: { taskId: string; title: string; reward: number; isActive: boolean; schedule: string; ready: number; completed: number;
    availableFrom?: string | null; dueAt?: string | null }[];
};
type Phase = 'select' | 'previewing' | 'preview' | 'committing' | 'uncertain' | 'done';

function newOperationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isPreview(value: unknown): value is XlsxImportPreview {
  return !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === true
    && typeof (value as { fileDigest?: unknown }).fileDigest === 'string' && Array.isArray((value as { issues?: unknown }).issues)
    && !!(value as { summary?: unknown }).summary;
}

function errorText(value: unknown, fallback: string): string {
  return value && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string'
    ? (value as { error: string }).error : fallback;
}

function where(issue: Issue): string | null {
  if (!issue.sheet) return null;
  const sheet = SHEET_LABELS[issue.sheet] ? `${SHEET_LABELS[issue.sheet]} 시트` : `'${issue.sheet}' 시트`;
  return issue.row ? `${sheet} ${issue.row}행` : sheet;
}

const number = (value: number) => value.toLocaleString('ko-KR');
const when = (value: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: '2-digit' }).format(new Date(value));

function IssueList({ issues, tone, title }: { issues: Issue[]; tone: 'danger' | 'warning'; title: string }) {
  if (!issues.length) return null;
  return (
    <Callout tone={tone} title={title}>
      <ul className="mt-1 max-h-64 space-y-1 overflow-y-auto pr-1">
        {issues.map((issue, index) => (
          <li key={index} className="leading-relaxed">
            {where(issue) ? <span className="font-bold">{where(issue)} · </span> : null}{issue.message}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-[var(--crs-radius)] border border-[var(--crs-line)] bg-[var(--theme-surface)] px-4 py-3">
      <p className="truncate text-[12px] font-semibold text-[var(--theme-muted-text)]">{label}</p>
      <p className="mt-0.5 truncate text-[20px] font-black tabular-nums tracking-[-0.02em]">{value}</p>
      {hint ? <p className="mt-0.5 truncate text-[11.5px] text-[var(--theme-muted-text)]">{hint}</p> : null}
    </div>
  );
}

function Details({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-[var(--crs-radius)] border border-[var(--crs-line)] bg-[var(--theme-surface)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-[13px] font-bold">
        {title}<span className="transition-transform group-open:rotate-180"><Icon name="chevronDown" size={16} /></span>
      </summary>
      <div className="max-h-72 overflow-y-auto border-t border-[var(--crs-line)] px-4 py-2 text-[13px]">{children}</div>
    </details>
  );
}

/**
 * Upload → preview → confirm → import of a saved CRS Google Sheets workbook (.xlsx).
 * `start` mode starts a new class together with the import; `import` fills an empty started class.
 */
export function XlsxImportPanel({ slug, mode, navigate }: Readonly<{
  slug: string; mode: 'start' | 'import'; navigate?: (href: string) => void;
}>) {
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const [phase, setPhase] = useState<Phase>('select');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<XlsxImportPreview | null>(null);
  const [operationId, setOperationId] = useState('');
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [doneHref, setDoneHref] = useState('');
  const endpoint = (action: 'preview' | 'commit') => `/api/c/${slug}/migrations/xlsx/${action}`;

  function reset() {
    setPhase('select'); setFile(null); setPreview(null); setOperationId(''); setMessage(''); setConfirming(false);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function choose(selected: File | undefined) {
    if (!selected || inFlight.current) return;
    setPreview(null); setConfirming(false);
    if (!/\.xlsx$/i.test(selected.name)) {
      setPhase('select'); setFile(null);
      setMessage('엑셀(.xlsx) 파일만 올릴 수 있어요. 구글 시트에서 [파일 → 다운로드 → Microsoft Excel(.xlsx)]로 저장해 주세요.');
      return;
    }
    if (selected.size > XLSX_UPLOAD_MAX_BYTES) {
      setPhase('select'); setFile(null); setMessage('파일이 너무 커요. 10MB 이하의 .xlsx 파일만 올릴 수 있어요.');
      return;
    }
    inFlight.current = true;
    setFile(selected); setPhase('previewing'); setMessage('');
    try {
      const body = new FormData();
      body.append('file', selected, selected.name);
      const response = await fetch(endpoint('preview'), { method: 'POST', body, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      const data: unknown = await response.json().catch(() => null);
      if (response.ok && isPreview(data)) {
        setPreview(data); setOperationId(newOperationId()); setPhase('preview');
      } else {
        setPhase('select'); setMessage(errorText(data, '파일을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.'));
      }
    } catch {
      setPhase('select'); setMessage('연결이 끊겼어요. 파일을 다시 선택해 주세요.');
    } finally { inFlight.current = false; }
  }

  async function commit() {
    if (!file || !preview || !operationId || inFlight.current) return;
    inFlight.current = true;
    setConfirming(false); setPhase('committing'); setMessage('');
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      body.append('operationId', operationId);
      body.append('fileDigest', preview.fileDigest);
      const response = await fetch(endpoint('commit'), { method: 'POST', body, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      const data: unknown = await response.json().catch(() => null);
      const href = data && typeof data === 'object' && typeof (data as { adminHref?: unknown }).adminHref === 'string'
        ? (data as { adminHref: string }).adminHref : `/c/${slug}/admin`;
      if (response.ok && data && typeof data === 'object' && (data as { ok?: unknown }).ok === true) {
        setPhase('done'); setDoneHref(href);
        setMessage(errorText({ error: (data as { message?: unknown }).message }, '가져오기를 마쳤어요.'));
        (navigate ?? ((target: string) => window.location.assign(target)))(href);
      } else if (response.status === 503 || response.status === 502 || response.status === 504
        || (data && typeof data === 'object' && (data as { retryable?: unknown }).retryable === true)) {
        setPhase('uncertain'); setMessage(errorText(data, '가져오기 결과를 확인하지 못했어요. 같은 파일로 다시 확인해 주세요.'));
      } else {
        setPhase('preview');
        setMessage(errorText(data, '가져오지 못했어요. 파일 내용을 확인해 주세요.'));
        if (data && typeof data === 'object' && Array.isArray((data as { issues?: unknown }).issues)) {
          setPreview({ ...preview, canImport: false, issues: (data as { issues: Issue[] }).issues });
        }
        // A definite refusal: a later attempt is a new request.
        setOperationId(newOperationId());
      }
    } catch {
      setPhase('uncertain'); setMessage('연결이 끊겼어요. 같은 파일로 다시 확인하면 가져오기가 끝났는지 알 수 있어요.');
    } finally { inFlight.current = false; }
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault(); setDragging(false);
    if (phase !== 'committing' && phase !== 'done') void choose(event.dataTransfer.files[0]);
  }

  const summary = preview?.summary;
  const unit = summary?.settings.currencyUnit ?? '';
  const errors = preview?.issues.filter(issue => issue.level === 'error') ?? [];
  const warnings = preview?.issues.filter(issue => issue.level === 'warning') ?? [];
  const actionLabel = mode === 'start' ? '이 파일로 학급 시작하기' : '이 파일로 가져오기';
  const locked = !ready || phase === 'previewing' || phase === 'committing' || phase === 'done' || phase === 'uncertain';

  return (
    <div className="space-y-4">
      {phase === 'select' || phase === 'previewing' ? (
        <>
          <ol className="space-y-1.5 rounded-[var(--crs-radius)] bg-[var(--crs-subtle)] px-4 py-3 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">
            <li><span className="font-bold text-[var(--theme-text)]">1.</span> 예전 CRS 구글 시트를 열어요.</li>
            <li><span className="font-bold text-[var(--theme-text)]">2.</span> [파일 → 다운로드 → Microsoft Excel(.xlsx)]로 저장해요.</li>
            <li><span className="font-bold text-[var(--theme-text)]">3.</span> 저장한 파일을 아래에 올리면 옮길 내용을 먼저 보여 드려요.</li>
          </ol>
          <label htmlFor={inputId} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
            className={cx('flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--crs-radius-lg)] border-2 border-dashed px-6 py-8 text-center transition-colors',
              dragging ? 'border-[var(--theme-accent-text)] bg-[var(--theme-accent-soft)]' : 'border-[var(--crs-line-strong)] hover:bg-[var(--crs-subtle-hover)]',
              locked && 'pointer-events-none opacity-60')}>
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--crs-subtle-hover)] text-[var(--theme-muted-text)]"><Icon name="migrate" size={20} /></span>
            <span className="text-[14px] font-extrabold">{phase === 'previewing' ? '파일을 확인하는 중…' : '.xlsx 파일 선택'}</span>
            <span className="text-[12px] text-[var(--theme-muted-text)]">여기에 끌어다 놓아도 돼요 · 10MB 이하</span>
            <input ref={inputRef} id={inputId} type="file" disabled={locked} aria-label="CRS 시트 파일(.xlsx) 선택"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only"
              onChange={event => { void choose(event.target.files?.[0]); }} />
          </label>
        </>
      ) : null}

      {preview && summary && phase !== 'select' && phase !== 'previewing' ? (
        <section aria-label="가져올 내용 미리보기" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 truncate text-[13px] font-semibold"><Icon name="box" size={15} className="mr-1 inline align-[-2px]" />{preview.fileName}</p>
            {phase === 'preview' ? <Button size="sm" variant="ghost" icon="refresh" onClick={reset}>다른 파일 고르기</Button> : null}
          </div>
          {preview.blocked ? <Callout tone="danger" title="이 학급에는 가져올 수 없어요">{preview.blockedMessage}</Callout> : null}
          <div className="grid grid-cols-2 gap-2">
            <Stat label="학생" value={`${number(summary.students)}명`} hint={summary.students !== summary.activeStudents ? `사용 중 ${number(summary.activeStudents)}명` : undefined} />
            <Stat label="총 잔액" value={`${number(summary.totalBalance)}${unit}`} hint="학생별 잔액 그대로" />
            <Stat label="상품" value={`${number(summary.products)}개`} hint={`판매 중 ${number(summary.activeProducts)}개 · 재고 ${number(summary.totalStock)}개`} />
            <Stat label="과제" value={`${number(summary.tasks)}개`} hint={`완료 가능 ${number(summary.readyAssignments)} · 완료 ${number(summary.completedAssignments)}`} />
          </div>
          <p className="text-[12.5px] leading-relaxed text-[var(--theme-muted-text)]">
            매점 이름 <b className="text-[var(--theme-text)]">{summary.settings.appTitle}</b> · 은행 이름 <b className="text-[var(--theme-text)]">{summary.settings.bankTitle}</b>
            {summary.promotions ? <> · 행사 {number(summary.promotions)}개</> : null}
          </p>
          <IssueList issues={errors} tone="danger" title={`고쳐야 할 내용 ${errors.length}건`} />
          <IssueList issues={warnings} tone="warning" title={`확인할 내용 ${warnings.length}건`} />
          {preview.students.length ? (
            <Details title={`학생 ${number(summary.students)}명 보기`}>
              <ul className="divide-y divide-[var(--crs-line)]">
                {preview.students.map(student => (
                  <li key={student.studentId} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="min-w-0 truncate"><span className="text-[var(--theme-muted-text)]">{student.studentId}</span> {student.name}
                      {student.status === 'INACTIVE' ? <Badge className="ml-1.5">비활성</Badge> : null}</span>
                    <span className="shrink-0 font-semibold tabular-nums">{number(student.balance)}{unit}</span>
                  </li>
                ))}
              </ul>
            </Details>
          ) : null}
          {preview.products.length ? (
            <Details title={`상품 ${number(summary.products)}개 보기`}>
              <ul className="divide-y divide-[var(--crs-line)]">
                {preview.products.map(product => (
                  <li key={product.productId} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="min-w-0 truncate">{product.name}{!product.isActive ? <Badge className="ml-1.5">판매 중지</Badge> : null}</span>
                    <span className="shrink-0 tabular-nums text-[var(--theme-muted-text)]">{number(product.price)}{unit} · 재고 {number(product.stock)}</span>
                  </li>
                ))}
              </ul>
            </Details>
          ) : null}
          {preview.tasks.length ? (
            <Details title={`과제 ${number(summary.tasks)}개 보기`}>
              <ul className="divide-y divide-[var(--crs-line)]">
                {preview.tasks.map(task => (
                  <li key={task.taskId} className="py-1.5">
                    <p className="flex items-center gap-1.5 font-semibold"><span className="min-w-0 truncate">{task.title}</span>
                      {!task.isActive ? <Badge>숨김</Badge> : null}</p>
                    <p className="text-[12px] text-[var(--theme-muted-text)]">보상 {number(task.reward)}{unit} · {task.schedule} · 완료 가능 {task.ready}명 · 완료 {task.completed}명</p>
                    {task.availableFrom || task.dueAt ? (
                      <p className="text-[12px] text-[var(--theme-muted-text)]">
                        {task.availableFrom ? `시작 ${when(task.availableFrom)}` : ''}{task.availableFrom && task.dueAt ? ' · ' : ''}{task.dueAt ? `기한 ${when(task.dueAt)}` : ''}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Details>
          ) : null}
          {phase === 'preview' ? (
            <Button variant="primary" size="lg" block icon="check" disabled={!ready || !preview.canImport} onClick={() => setConfirming(true)}>{actionLabel}</Button>
          ) : null}
          {!preview.canImport && !preview.blocked && phase === 'preview' ? (
            <p className="text-center text-[12.5px] text-[var(--theme-muted-text)]">시트를 고친 뒤 다시 .xlsx로 저장해 올려 주세요.</p>
          ) : null}
        </section>
      ) : null}

      {message ? (
        <div role={phase === 'done' ? 'status' : 'alert'}>
          <Callout tone={phase === 'done' ? 'success' : phase === 'uncertain' ? 'warning' : 'danger'}>{message}</Callout>
        </div>
      ) : null}
      {phase === 'uncertain' ? <Button variant="primary" block icon="refresh" disabled={!ready} onClick={() => { void commit(); }}>같은 파일로 다시 확인</Button> : null}
      {phase === 'done' ? <a href={doneHref} className={buttonClass({ variant: 'primary', size: 'lg', block: true })}>학급 관리 열기</a> : null}

      {confirming && preview && summary ? (
        <Modal title="가져오기 전에 확인해 주세요" tone="info" onClose={() => setConfirming(false)}
          footer={<><Button onClick={() => setConfirming(false)}>취소</Button><Button variant="primary" icon="check" onClick={() => { void commit(); }}>가져오기</Button></>}>
          <ul className="list-disc space-y-1.5 pl-5 text-[13.5px] leading-relaxed">
            {mode === 'start' ? <li>학급 사용을 시작하고 아래 내용을 한 번에 옮겨요.</li> : null}
            <li>학생 {number(summary.students)}명과 각자의 잔액(총 {number(summary.totalBalance)}{unit})</li>
            <li>상품 {number(summary.products)}개와 재고{summary.promotions ? `, 행사 ${number(summary.promotions)}개` : ''}</li>
            <li>과제 {number(summary.tasks)}개와 이번 회차 상태(완료 가능 {number(summary.readyAssignments)}건, 완료 {number(summary.completedAssignments)}건 — 보상은 다시 주지 않아요)</li>
            <li>이전 거래·과제 기록은 옮기지 않아요. 원본 파일에 그대로 남아 있어요.</li>
          </ul>
          <p className="mt-3 text-[12.5px] text-[var(--theme-muted-text)]">중간에 문제가 생기면 아무것도 바뀌지 않아요.</p>
        </Modal>
      ) : null}
      {phase === 'committing' ? <LoadingOverlay title="자료를 옮기는 중" message="잠시만 기다려 주세요. 창을 닫지 마세요." /> : null}
    </div>
  );
}
