'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Callout, Modal, Spinner, cx } from '@/components/ui';
import {
  BULK_IMPORT_MAX_FILE_BYTES,
  BULK_IMPORT_MAX_ROWS,
  XLSX_CONTENT_TYPE,
  parseBulkImportFailure,
  type BulkImportCommitResult,
  type BulkImportIssue,
  type BulkImportPreview,
} from '@/lib/bulkImport';
import { tenantFetch } from '@/lib/tenantApiPath';

export type BulkImportColumn<TRow> = Readonly<{
  label: string;
  render: (row: TRow) => ReactNode;
  align?: 'left' | 'right';
}>;

export type BulkImportConfig<TRow extends { rowNumber: number }, TItem> = Readonly<{
  /** '학생' | '상품' */
  noun: string;
  /** 12 → '12명' */
  countLabel: (count: number) => string;
  /** 12 → '학생 12명을 추가했어요' */
  successMessage: (count: number) => string;
  templatePath: string;
  previewPath: string;
  commitPath: string;
  templateFileName: string;
  parsePreview: (value: unknown) => BulkImportPreview<TRow> | null;
  parseCommit: (value: unknown) => BulkImportCommitResult<TItem> | null;
  columns: (unit: string) => ReadonlyArray<BulkImportColumn<TRow>>;
}>;

export type BulkImportControlsProps = Readonly<{
  /** Called once the server confirmed the import; refresh the list here. */
  onImported: (count: number) => void;
  disabled?: boolean;
  /** Class currency unit for money columns (e.g. '원'). */
  unit?: string;
}>;

type CommitFailure = Readonly<{ message: string; issues: ReadonlyArray<BulkImportIssue>; retry: 'same' | 'recheck' | 'none' }>;

type Phase<TRow> =
  | Readonly<{ kind: 'closed' }>
  | Readonly<{ kind: 'checking'; file: File }>
  | Readonly<{ kind: 'fileError'; file: File; message: string }>
  | Readonly<{ kind: 'templateError'; message: string }>
  | Readonly<{
    kind: 'preview';
    file: File;
    preview: BulkImportPreview<TRow>;
    operationId: string;
    committing: boolean;
    failure: CommitFailure | null;
  }>
  | Readonly<{ kind: 'done'; file: File; created: number; replayed: boolean }>;

const ISSUE_DISPLAY_LIMIT = 50;
const CONNECTION_PROBLEM = '서버와 연결하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.';

function clientFileProblem(file: File): string | null {
  const name = file.name.toLowerCase();
  if (/\.(xls|xlsm|xlsb|xltm)$/.test(name)) {
    return "옛 엑셀 형식이나 매크로 파일은 올릴 수 없어요. 엑셀에서 '다른 이름으로 저장 → Excel 통합 문서(*.xlsx)'로 저장한 뒤 올려 주세요.";
  }
  if (/\.(csv|tsv|txt|numbers|ods|hwp|hwpx)$/.test(name)) {
    return "엑셀(.xlsx) 파일만 올릴 수 있어요. 엑셀에서 'Excel 통합 문서(*.xlsx)'로 저장한 뒤 올려 주세요.";
  }
  if (!name.endsWith('.xlsx')) return '엑셀(.xlsx) 파일만 올릴 수 있어요.';
  if (file.size === 0) return '빈 파일이에요. 내용을 적은 엑셀 파일을 올려 주세요.';
  if (file.size > BULK_IMPORT_MAX_FILE_BYTES) return '파일이 너무 커요. 2MB 이하의 엑셀 파일을 올려 주세요.';
  return null;
}

function statusMessage(status: number, body: unknown, fallback: string): string {
  const failure = parseBulkImportFailure(body);
  if (failure) return failure.error;
  if (status === 401 || status === 403) return '관리자 로그인이 필요해요. 다시 로그인해 주세요.';
  if (status === 413) return '파일이 너무 커요. 2MB 이하의 엑셀 파일을 올려 주세요.';
  return fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function BulkImportControls<TRow extends { rowNumber: number }, TItem>({
  config,
  onImported,
  disabled = false,
  unit = '',
}: BulkImportControlsProps & { config: BulkImportConfig<TRow, TItem> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const requestToken = useRef(0);
  const [phase, setPhase] = useState<Phase<TRow>>({ kind: 'closed' });
  const [downloading, setDownloading] = useState(false);
  const { noun } = config;

  function chooseFile() {
    if (inputRef.current) {
      inputRef.current.value = '';
      inputRef.current.click();
    }
  }

  function close() {
    if (phase.kind === 'preview' && phase.committing) return;
    requestToken.current += 1;
    setPhase({ kind: 'closed' });
  }

  async function checkFile(file: File) {
    const problem = clientFileProblem(file);
    const token = ++requestToken.current;
    if (problem) {
      setPhase({ kind: 'fileError', file, message: problem });
      return;
    }
    setPhase({ kind: 'checking', file });
    let next: Phase<TRow>;
    try {
      const response = await tenantFetch(config.previewPath, {
        method: 'POST',
        headers: { 'Content-Type': XLSX_CONTENT_TYPE },
        body: file,
        cache: 'no-store',
      });
      const body = await readJson(response);
      const preview = response.ok ? config.parsePreview(body) : null;
      next = preview
        ? { kind: 'preview', file, preview, operationId: crypto.randomUUID(), committing: false, failure: null }
        : {
          kind: 'fileError',
          file,
          message: statusMessage(response.status, body, '파일을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.'),
        };
    } catch {
      next = { kind: 'fileError', file, message: CONNECTION_PROBLEM };
    }
    if (token === requestToken.current) setPhase(next);
  }

  async function commit() {
    if (phase.kind !== 'preview' || phase.committing || phase.preview.rows.length === 0) return;
    if (phase.failure && phase.failure.retry !== 'same') return;
    const current = phase;
    const token = requestToken.current;
    setPhase({ ...current, committing: true, failure: null });
    let failure: CommitFailure;
    try {
      const response = await tenantFetch(config.commitPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: current.operationId, rows: current.preview.rows }),
        cache: 'no-store',
      });
      const body = await readJson(response);
      if (response.ok) {
        const result = config.parseCommit(body);
        if (result && result.operationId === current.operationId) {
          if (token === requestToken.current) {
            setPhase({ kind: 'done', file: current.file, created: result.created, replayed: result.replayed });
          }
          onImported(result.created);
          return;
        }
        failure = uncertainFailure();
      } else {
        const parsed = parseBulkImportFailure(body);
        if (!parsed || parsed.code === 'OUTCOME_UNCERTAIN' || parsed.code === 'INTERNAL'
          || (response.status >= 500 && response.status !== 501)) {
          failure = uncertainFailure();
        } else {
          failure = {
            message: parsed.error,
            issues: parsed.errors ?? [],
            retry: parsed.code === 'VALIDATION_FAILED' ? 'recheck' : 'none',
          };
        }
      }
    } catch {
      failure = uncertainFailure();
    }
    if (token === requestToken.current) setPhase({ ...current, committing: false, failure });
  }

  async function downloadTemplate() {
    if (downloading) return;
    setDownloading(true);
    try {
      const response = await tenantFetch(config.templatePath, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(statusMessage(response.status, await readJson(response), '양식 파일을 받지 못했어요. 잠시 후 다시 시도해 주세요.'));
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = config.templateFileName;
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) {
      setPhase({
        kind: 'templateError',
        message: error instanceof Error && error.message ? error.message : CONNECTION_PROBLEM,
      });
    } finally {
      setDownloading(false);
    }
  }

  const title = `엑셀로 ${noun} 추가`;
  const busy = phase.kind === 'preview' && phase.committing;

  return (
    <>
      <Button variant="secondary" icon="receipt" aria-label={`${noun} 양식 다운로드`} loading={downloading}
        disabled={disabled || downloading} onClick={(event) => { setOpener(event.currentTarget); void downloadTemplate(); }}>
        양식 다운로드
      </Button>
      <Button variant="secondary" icon="plus" aria-label={`${noun} 엑셀로 일괄 추가`}
        disabled={disabled || phase.kind === 'checking' || busy}
        onClick={(event) => { setOpener(event.currentTarget); chooseFile(); }}>
        엑셀로 일괄 추가
      </Button>
      <input ref={inputRef} type="file" tabIndex={-1} className="sr-only"
        accept={`.xlsx,${XLSX_CONTENT_TYPE}`} aria-label={`${noun} 엑셀 파일 선택`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void checkFile(file);
        }} />

      {phase.kind === 'templateError' ? (
        <Modal size="sm" tone="danger" title="양식 파일을 받지 못했어요" ariaLabel={`${noun} 양식 다운로드 실패`}
          opener={opener} onClose={close}
          footer={<>
            <Button variant="ghost" onClick={close}>확인</Button>
            <Button variant="primary" data-autofocus onClick={() => { close(); void downloadTemplate(); }}>다시 받기</Button>
          </>}>
          <p className="text-sm leading-relaxed">{phase.message}</p>
        </Modal>
      ) : null}

      {phase.kind === 'checking' || phase.kind === 'fileError' || phase.kind === 'preview' || phase.kind === 'done' ? (
        <Modal size={phase.kind === 'preview' ? 'lg' : 'md'} title={title} ariaLabel={title}
          description={<span className="break-all">{phase.file.name}</span>}
          opener={opener} busy={busy} onClose={close}
          footer={dialogFooter()}>
          {dialogBody()}
        </Modal>
      ) : null}
    </>
  );

  function dialogFooter(): ReactNode {
    if (phase.kind === 'checking') {
      return <Button variant="ghost" onClick={close}>취소</Button>;
    }
    if (phase.kind === 'fileError') {
      return <>
        <Button variant="ghost" onClick={close}>확인</Button>
        <Button variant="primary" data-autofocus onClick={chooseFile}>다른 파일 선택</Button>
      </>;
    }
    if (phase.kind === 'done') {
      return <Button variant="primary" data-autofocus onClick={close}>확인</Button>;
    }
    if (phase.kind !== 'preview') return null;
    const count = phase.preview.rows.length;
    const failure = phase.failure;
    const primary = failure?.retry === 'recheck'
      ? <Button variant="primary" icon="refresh" data-autofocus onClick={() => void checkFile(phase.file)}>파일 다시 확인</Button>
      : (
        <Button variant="primary" icon="check" data-autofocus loading={phase.committing}
          disabled={count === 0 || phase.committing || failure?.retry === 'none'} onClick={() => void commit()}>
          {phase.committing ? '추가하는 중…' : failure?.retry === 'same' ? '다시 시도' : `${noun} ${config.countLabel(count)} 추가`}
        </Button>
      );
    return <>
      <Button variant="ghost" disabled={phase.committing} onClick={close}>취소</Button>
      <Button variant="secondary" disabled={phase.committing} onClick={chooseFile}>다른 파일 선택</Button>
      {primary}
    </>;
  }

  function dialogBody(): ReactNode {
    if (phase.kind === 'checking') {
      return (
        <div role="status" className="flex items-center gap-3 py-6">
          <Spinner size={24} className="text-[var(--theme-accent-text)]" />
          <div>
            <p className="text-[15px] font-bold">파일을 확인하고 있어요</p>
            <p className="mt-0.5 text-[13px] text-[var(--theme-muted-text)]">아직 아무것도 추가하지 않았어요.</p>
          </div>
        </div>
      );
    }
    if (phase.kind === 'fileError') {
      return (
        <div className="space-y-3">
          <Callout tone="danger" title="이 파일은 올릴 수 없어요">{phase.message}</Callout>
          <p className="text-[13px] leading-relaxed text-[var(--theme-muted-text)]">
            &lsquo;양식 다운로드&rsquo;로 받은 파일에 적어 올리면 가장 정확해요.
            한 번에 {BULK_IMPORT_MAX_ROWS}줄, 2MB까지 올릴 수 있어요.
          </p>
        </div>
      );
    }
    if (phase.kind === 'done') {
      return (
        <div role="status" className="space-y-3">
          <Callout tone="success" title={config.successMessage(phase.created)}>
            {phase.replayed ? '이미 처리된 요청이라 한 번만 추가됐어요. 목록에서 확인해 보세요.' : '목록에서 바로 확인할 수 있어요.'}
          </Callout>
        </div>
      );
    }
    if (phase.kind !== 'preview') return null;
    const { preview, failure } = phase;
    const count = preview.rows.length;
    const errorRows = new Set(preview.errors.map((issue) => issue.rowNumber)).size;
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={count ? 'success' : 'neutral'} dot>추가할 {noun} {config.countLabel(count)}</Badge>
          {errorRows ? <Badge tone="danger" dot>오류 {errorRows}줄</Badge> : null}
          <span className="text-xs text-[var(--theme-muted-text)]">&lsquo;{preview.sheetName}&rsquo; 시트에서 {preview.readRowCount}줄을 읽었어요.</span>
        </div>

        {failure ? (
          <Callout tone={failure.retry === 'same' ? 'warning' : 'danger'}
            title={failure.retry === 'same' ? '추가 결과를 확인하지 못했어요' : '추가하지 못했어요'}>
            <p>{failure.message}</p>
            {failure.issues.length ? <IssueList issues={failure.issues} /> : null}
          </Callout>
        ) : null}

        {preview.errors.length ? (
          <Callout tone={count ? 'warning' : 'danger'}
            title={count ? `오류가 있는 ${errorRows}줄은 추가되지 않아요` : '추가할 수 있는 줄이 없어요'}>
            <p>파일을 고친 뒤 &lsquo;다른 파일 선택&rsquo;으로 다시 올리면 모두 추가할 수 있어요.</p>
            <IssueList issues={preview.errors} />
          </Callout>
        ) : null}

        {preview.notices.length ? (
          <Callout tone="info">
            <ul className="space-y-0.5">{preview.notices.map((notice) => <li key={notice}>{notice}</li>)}</ul>
          </Callout>
        ) : null}

        {count ? (
          <PreviewTable caption={`추가할 ${noun} 미리 보기`} rows={preview.rows} columns={config.columns(unit)} />
        ) : null}

        {count && !failure ? (
          <p className="text-[13px] leading-relaxed text-[var(--theme-muted-text)]">
            확인을 누르기 전에는 아무것도 추가되지 않아요. 전부 한꺼번에 추가되고, 중간에 문제가 생기면 하나도 추가되지 않아요.
          </p>
        ) : null}
      </div>
    );
  }

  function uncertainFailure(): CommitFailure {
    return {
      message: "인터넷 연결이 끊겼거나 서버가 답하지 않았어요. '다시 시도'를 누르면 같은 요청으로 확인해요. 두 번 추가되지는 않아요.",
      issues: [],
      retry: 'same',
    };
  }
}

function IssueList({ issues }: { issues: ReadonlyArray<BulkImportIssue> }) {
  const shown = issues.slice(0, ISSUE_DISPLAY_LIMIT);
  return (
    <ul aria-label="오류 목록" className="mt-2 max-h-48 space-y-1 overflow-y-auto pr-1">
      {shown.map((issue, index) => (
        <li key={`${issue.rowNumber ?? 'file'}-${index}`} className="flex gap-2">
          {issue.rowNumber !== null ? <span className="shrink-0 font-bold tabular-nums">{issue.rowNumber}행</span> : null}
          <span className="min-w-0">{issue.column ? <span className="font-semibold">{issue.column}: </span> : null}{issue.message}</span>
        </li>
      ))}
      {issues.length > shown.length ? <li className="font-semibold">외 {issues.length - shown.length}개</li> : null}
    </ul>
  );
}

function PreviewTable<TRow extends { rowNumber: number }>({ caption, rows, columns }: {
  caption: string;
  rows: ReadonlyArray<TRow>;
  columns: ReadonlyArray<BulkImportColumn<TRow>>;
}) {
  return (
    <div className="max-h-72 overflow-auto rounded-[var(--crs-radius)] border border-[var(--crs-line)]">
      <table aria-label={caption} className="w-full min-w-[420px] border-collapse text-left text-[13px]">
        <thead className="sticky top-0 bg-[var(--crs-subtle)] text-xs font-bold text-[var(--theme-muted-text)]">
          <tr>
            <th scope="col" className="w-14 px-3 py-2">행</th>
            {columns.map((column) => (
              <th key={column.label} scope="col" className={cx('px-3 py-2', column.align === 'right' && 'text-right')}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--crs-line)]">
          {rows.map((row) => (
            <tr key={row.rowNumber}>
              <td className="px-3 py-2 tabular-nums text-[var(--theme-muted-text)]">{row.rowNumber}</td>
              {columns.map((column) => (
                <td key={column.label} className={cx('px-3 py-2', column.align === 'right' && 'text-right tabular-nums')}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function formatAmount(value: number, unit: string): string {
  return `${value.toLocaleString('ko-KR')}${unit}`;
}
