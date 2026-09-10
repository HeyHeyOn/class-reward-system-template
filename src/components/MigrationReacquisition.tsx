'use client';

import { useEffect, useRef, useState } from 'react';
import type { FreezingReacquisitionChallenge } from '@/server/migration/freezingReacquisitionContract';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const PURPOSE = 'CLASS_STORE_FREEZING_REACQUISITION';
const ACTION = 'READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE';
const button = 'rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40';
type Display = FreezingReacquisitionChallenge & { action: typeof ACTION; spreadsheetId: string; authority: 'NONAUTHORITY'; exclusion: 'NOT_PROVEN'; finalImportEligible: false; automaticRetry: false; automaticEnable: false };
type Bootstrap = { csrfToken: string; expiresAt: number; scope: 'NONEXECUTING_BOOTSTRAP' };
type Approval = { challengeId: string; display: Display; intentDigest: string; csrfToken: string };
type Reference = { challengeId: string; intentDigest: string; executionDigest: string };
type Phase = 'idle' | 'bootstrap-pending' | 'bootstrap' | 'challenge-pending' | 'approval' | 'confirm-pending' | 'terminal';
type Props = { slug: string; tenantId: string; jobId: string };
const displayKeys = ['purpose', 'bindingVersion', 'expectedStatus', 'challengeId', 'tenantId', 'migrationJobId', 'expectedStateVersion',
  'sourceId', 'spreadsheetIdDigest', 'jobSemanticFingerprint', 'sourceAcquisitionDigest', 'deploymentId', 'actorUserId', 'actorSubject',
  'sessionBinding', 'startCeremonyId', 'executionDigest', 'preflightSnapshotId', 'preflightSnapshotDigest', 'registrationDigest',
  'registrationVersion', 'issuedAt', 'expiresAt', 'action', 'spreadsheetId', 'authority', 'exclusion', 'finalImportEligible', 'automaticRetry', 'automaticEnable'];
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw Error();
  return value as Record<string, unknown>;
}
function matches(value: unknown, expression: RegExp): value is string { return typeof value === 'string' && expression.test(value); }
function fresh(expiresAt: number) { if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw Error(); }
function parseBootstrap(value: unknown): Bootstrap {
  const b = exact(value, ['csrfToken', 'expiresAt', 'scope']);
  if (!matches(b.csrfToken, HASH) || b.scope !== 'NONEXECUTING_BOOTSTRAP' || typeof b.expiresAt !== 'number' || b.expiresAt > Date.now() + 60_000) throw Error();
  fresh(b.expiresAt); return b as Bootstrap;
}
function parseApproval(value: unknown, tenantId: string, jobId: string, bootstrap: Bootstrap): Approval {
  const a = exact(value, ['challengeId', 'display', 'intentDigest', 'csrfToken']);
  const d = exact(a.display, displayKeys);
  if (!matches(a.challengeId, UUID) || !matches(a.intentDigest, HASH) || !matches(a.csrfToken, HASH) || a.csrfToken === bootstrap.csrfToken
    || d.challengeId !== a.challengeId || d.tenantId !== tenantId || d.migrationJobId !== jobId
    || d.purpose !== PURPOSE || d.bindingVersion !== 1 || d.expectedStatus !== 'FREEZING' || d.action !== ACTION
    || d.authority !== 'NONAUTHORITY' || d.exclusion !== 'NOT_PROVEN' || d.finalImportEligible !== false || d.automaticRetry !== false || d.automaticEnable !== false) throw Error();
  for (const k of ['challengeId', 'tenantId', 'migrationJobId', 'actorUserId', 'startCeremonyId']) if (!matches(d[k], UUID)) throw Error();
  for (const k of ['spreadsheetIdDigest', 'jobSemanticFingerprint', 'sourceAcquisitionDigest', 'sessionBinding', 'executionDigest', 'preflightSnapshotDigest', 'registrationDigest']) if (!matches(d[k], HASH)) throw Error();
  for (const k of ['expectedStateVersion', 'registrationVersion']) if (!matches(d[k], /^[1-9][0-9]{0,15}$/) || BigInt(d[k] as string) > BigInt(Number.MAX_SAFE_INTEGER)) throw Error();
  for (const k of ['sourceId', 'deploymentId', 'actorSubject', 'preflightSnapshotId']) {
    const s = d[k];
    if (typeof s !== 'string' || !s || s.trim() !== s || s.length > (k === 'actorSubject' ? 255 : 512) || /[\x00-\x1f\x7f]/.test(s)) throw Error();
  }
  if (!matches(d.spreadsheetId, /^[A-Za-z0-9_-]{1,512}$/) || !Number.isSafeInteger(d.issuedAt) || Number(d.issuedAt) < 0 || Number(d.issuedAt) > Date.now()
    || typeof d.expiresAt !== 'number' || d.expiresAt - Number(d.issuedAt) !== 60_000) throw Error();
  fresh(bootstrap.expiresAt); fresh(d.expiresAt);
  return a as unknown as Approval;
}
function parseFact(value: unknown, tenantId: string, ref: Reference, archival: boolean): Record<string, unknown> {
  const r = exact(value, ['purpose', 'tenantId', 'challengeId', 'authority', 'exclusion', 'finalImportEligible', 'intentDigest', 'candidateDigest',
    'auditEventId', 'nonceDigest', 'executionDigest', 'envelopeDigest', 'sheetsDigest', 'redisDigest', 'normalizationDigest', 'observationDigest',
    'status', 'automaticRetry', 'automaticEnable', ...(archival ? ['scope'] : [])]);
  if (r.purpose !== PURPOSE || r.tenantId !== tenantId || r.challengeId !== ref.challengeId || r.intentDigest !== ref.intentDigest || r.executionDigest !== ref.executionDigest
    || r.status !== 'AUTHENTIC_FREEZING_ACQUISITION' || r.authority !== 'NONAUTHORITY' || r.exclusion !== 'NOT_PROVEN' || r.finalImportEligible !== false
    || r.automaticRetry !== false || r.automaticEnable !== false || (archival && r.scope !== 'ARCHIVAL_ONLY')) throw Error();
  for (const k of ['intentDigest', 'candidateDigest', 'nonceDigest', 'executionDigest', 'envelopeDigest', 'sheetsDigest', 'redisDigest', 'normalizationDigest', 'observationDigest']) if (!matches(r[k], HASH)) throw Error();
  if (r.auditEventId !== `freezing-candidate:${ref.challengeId}:${r.candidateDigest}`) throw Error();
  return r;
}
/** Bound retained bytes before JSON parsing. The deadline also covers stalled
 * headers/body even if a transport ignores AbortSignal. No retries at this layer. */
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.redirected || ![200, 202].includes(response.status) || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) {
    void response.body?.cancel().catch(() => {}); throw Error();
  }
  const reader = response.body?.getReader(); if (!reader) throw Error();
  const chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw Error();
    while (true) {
      const { done, value } = await reader.read(); if (signal.aborted) throw Error(); if (done) break;
      size += value.byteLength; if (size > 16_384) throw Error(); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { signal.removeEventListener('abort', cancel); cancel(); }
}
const unknownMessage = 'UNKNOWN — 실행되었을 수 있어 다시 보내지 않습니다. 원래 참조로 보관 상태만 수동 조회하세요. 기록이 없어도 미실행을 뜻하지 않습니다.';

/** Parent keys this component by exact job; its enclosing form is independently
 * keyed by canonical tenant/login. Ref state is consumed before any await. */
export function MigrationReacquisition({ slug, tenantId, jobId }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [archiveResult, setArchiveResult] = useState('');
  const [reading, setReading] = useState(false);
  const guard = useRef({ phase: 'idle' as Phase, generation: 0, alive: true, pending: false, bootstrap: null as Bootstrap | null,
    approval: null as Approval | null, reference: null as Reference | null, controller: null as AbortController | null });
  const valid = UUID.test(jobId) && UUID.test(tenantId) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
  const base = `/api/c/${slug}/migrations/${jobId}/freezing/reacquisition`;
  function discard(message: string) {
    const g = guard.current; g.generation++; g.controller?.abort(); g.bootstrap = null; g.approval = null; g.pending = false; g.phase = 'terminal';
    setBootstrap(null); setApproval(null); setChecked(false); setReading(false); setPhase('terminal'); setError(message);
  }
  useEffect(() => {
    const g = guard.current; g.alive = true;
    const clear = () => {
      // No approval exists before the first deliberate action. Tab navigation
      // must not consume that untouched action or imply an external attempt.
      if (g.phase === 'idle') return;
      g.generation++; g.controller?.abort(); g.bootstrap = null; g.approval = null; g.pending = false; g.phase = 'terminal';
      setBootstrap(null); setApproval(null); setChecked(false); setReading(false); setPhase('terminal'); setResult(''); setArchiveResult(''); setError(unknownMessage);
    };
    const hidden = () => { if (document.visibilityState === 'hidden') clear(); };
    window.addEventListener('pagehide', clear); document.addEventListener('visibilitychange', hidden);
    return () => {
      g.alive = false; g.generation++; g.controller?.abort(); g.bootstrap = null; g.approval = null; g.reference = null;
      window.removeEventListener('pagehide', clear); document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  const expiresAt = approval?.display.expiresAt ?? bootstrap?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setTimeout(() => discard('확인 시간이 만료되었습니다. 자동 재발급하지 않습니다. ' + unknownMessage), Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  async function request(kind: 'bootstrap' | 'challenge' | 'confirm' | 'status') {
    const g = guard.current;
    if (!g.alive || g.pending || !valid || document.visibilityState === 'hidden') return;
    const b = g.bootstrap, a = g.approval, ref = g.reference;
    if ((kind === 'bootstrap' && g.phase !== 'idle') || (kind === 'challenge' && (g.phase !== 'bootstrap' || !b))
      || (kind === 'confirm' && (g.phase !== 'approval' || !a || !checked)) || (kind === 'status' && (g.phase !== 'terminal' || !ref))) return;
    try { if (kind === 'challenge') fresh(b!.expiresAt); if (kind === 'confirm') fresh(a!.display.expiresAt); }
    catch { discard('확인 시간이 만료되었습니다. ' + unknownMessage); return; }
    // Irreversible one-shot consumption precedes React rendering and fetch.
    g.pending = true; g.phase = kind === 'status' ? 'terminal' : `${kind}-pending`;
    g.bootstrap = null; g.approval = null; setBootstrap(null); setApproval(null); setChecked(false); setPhase(g.phase);
    setError(''); if (kind === 'status') { setReading(true); setArchiveResult(''); }
    const version = ++g.generation; const controller = new AbortController(); g.controller = controller;
    const current = () => g.alive && g.generation === version && !controller.signal.aborted && document.visibilityState !== 'hidden';
    const init: RequestInit = { method: kind === 'bootstrap' || kind === 'status' ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal };
    let url = base;
    if (kind === 'bootstrap') url += '/bootstrap';
    if (kind === 'challenge') { url += '/challenge'; init.headers = { 'content-type': 'application/json', 'x-csrf-token': b!.csrfToken }; init.body = '{}'; }
    if (kind === 'confirm') { init.headers = { 'content-type': 'application/json', 'x-csrf-token': a!.csrfToken }; init.body = JSON.stringify({ challengeId: a!.challengeId, display: a!.display }); }
    if (kind === 'status') { url += `/${ref!.challengeId}`; init.headers = { 'x-reacquisition-intent-digest': ref!.intentDigest }; }
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(Error()); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
    const timer = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const reply = await Promise.race([fetch(url, init), aborted]);
      const data = await Promise.race([readJson(reply, controller.signal), aborted]);
      if (!current()) return;
      if (kind === 'bootstrap') {
        if (reply.status !== 200) throw Error(); const next = parseBootstrap(data); g.bootstrap = next; g.phase = 'bootstrap'; setBootstrap(next);
      } else if (kind === 'challenge') {
        if (reply.status !== 200) throw Error(); const next = parseApproval(data, tenantId, jobId, b!);
        g.reference = { challengeId: next.challengeId, intentDigest: next.intentDigest, executionDigest: next.display.executionDigest };
        setReference(g.reference); g.approval = next; g.phase = 'approval'; setApproval(next);
      } else {
        g.phase = 'terminal';
        if (kind === 'confirm') {
          fresh(a!.display.expiresAt); if (reply.status !== 200) throw Error();
          setResult(JSON.stringify(parseFact(data, tenantId, ref!, false), null, 2));
        } else if (data && typeof data === 'object' && 'status' in data && data.status === 'UNKNOWN') {
          const r = exact(data, ['scope', 'status', 'automaticRetry', 'automaticEnable']);
          if (reply.status !== 200 || r.scope !== 'ARCHIVAL_ONLY' || r.automaticRetry !== false || r.automaticEnable !== false) throw Error();
          setArchiveResult('ARCHIVAL_ONLY · ' + unknownMessage);
        } else {
          if (reply.status !== 200) throw Error(); setArchiveResult(JSON.stringify(parseFact(data, tenantId, ref!, true), null, 2));
        }
      }
      setPhase(g.phase);
    } catch {
      if (g.alive && g.generation === version) discard(kind === 'bootstrap' || kind === 'challenge'
        ? '준비 또는 확인 정보 발급에 실패했습니다. 자동 재발급하지 않습니다. ' + unknownMessage : unknownMessage);
    } finally {
      window.clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAbort);
      if (g.alive && g.generation === version) { g.pending = false; setReading(false); }
    }
  }
  const busy = phase.endsWith('-pending');
  return <section aria-label="진단용 다시 읽기" className="space-y-3 rounded-lg border border-slate-300 p-4">
    <h2 className="text-lg font-semibold">FREEZING 진단용 다시 읽기</h2>
    <p>진단 전용입니다. 시작 작업과 달리 등록된 자료를 다시 읽어 진단 기록만 보관합니다. 전체 쓰기 차단을 증명하지 않으며 최종 가져오기·서비스 활성화를 하지 않습니다. 최종 작업의 별도 Google 동의를 대신하지 않습니다.</p>
    <p>입력한 작업 UUID가 이미 FREEZING 상태여야 합니다. 자동 실행·재시도는 없습니다.</p>
    <button type="button" className={button} disabled={!valid || phase !== 'idle'} onClick={() => void request('bootstrap')}>진단 준비</button>
    {bootstrap && <div className="space-y-2"><p>준비되었습니다. 다음 버튼은 서버에 이번 진단의 확인 기록을 만듭니다.</p><button type="button" className={button} onClick={() => void request('challenge')}>진단 확인 정보 받기</button></div>}
    {busy && <p role="status">진단 요청 처리 중… 다시 보내지 않습니다.</p>}
    {approval && <div className="space-y-3">
      <p>대상 학급·작업·원본 자료와 유효 시간을 확인하세요. NONAUTHORITY · NOT_PROVEN · finalImportEligible: false — 진단 기록은 최종 작업 권한이 아닙니다.</p>
      <details open><summary>서버가 보낸 원본 확인 정보</summary><pre aria-label="진단 서버 원본" className="overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-3">{JSON.stringify(approval.display, null, 2)}</pre></details>
      <label className="block"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />위 대상의 진단용 읽기에 동의합니다.</label>
      <button type="button" className={button} disabled={!checked} onClick={() => void request('confirm')}>진단용 읽기 실행</button>
    </div>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {result && <div><p>진단 기록 응답을 받았습니다. 최종 가져오기 승인이 아닙니다.</p><pre aria-label="진단 결과" className="whitespace-pre-wrap break-all">{result}</pre></div>}
    {reference && <div className="space-y-2 rounded border p-3">
      <p>원래 진단의 보관 조회 참조입니다. 이 화면 메모리에만 남으며 새로고침하면 참조를 잃을 수 있습니다. 같은 로그인 세션에서만 조회할 수 있고 조회로 실행 권한이 복원되지 않습니다.</p>
      <pre aria-label="진단 보관 참조" className="whitespace-pre-wrap break-all">{JSON.stringify({ jobId, challengeId: reference.challengeId, intentDigest: reference.intentDigest }, null, 2)}</pre>
      {phase === 'terminal' && <button type="button" className={button} disabled={reading} onClick={() => void request('status')}>진단 보관 상태 조회</button>}
      {archiveResult && <pre aria-label="진단 보관 결과" className="whitespace-pre-wrap break-all">{archiveResult}</pre>}
    </div>}
  </section>;
}
