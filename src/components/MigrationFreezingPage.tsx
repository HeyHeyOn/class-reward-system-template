'use client';

import { useEffect, useRef, useState } from 'react';
import type { StartFreezingDisplay } from '@/server/migration/startFreezingCeremony';

export type MigrationFreezingProps = { slug: string; tenantId: string; sessionKey: string };
type Challenge = { challengeId: string; csrfToken: string; startIntentDigest: string; startDisplay: StartFreezingDisplay; expiresAt: number };
type Archive = { jobId: string; attemptId: string; intentDigest: string };
const hash = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const common = ['tenantId', 'migrationJobId', 'sourceId', 'spreadsheetId', 'expectedStateVersion', 'jobSemanticFingerprint', 'sourceAcquisitionDigest', 'preflightSnapshotId', 'preflightDigest', 'expiresAt'];
const displayKeys = [...common, 'action', 'automaticEnable', 'ceremonyId', 'consentChallengeId', 'deploymentId', 'registrationVersion', 'registrationDigest'];
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[]) {
  const r = record(value);
  if (Object.keys(r).sort().join(',') !== [...keys].sort().join(',')) throw Error();
  return r;
}
function parseChallenge(value: unknown, tenantId: string, jobId: string): Challenge {
  const r = exact(value, [...common, 'challengeId', 'csrfToken', 'startIntentDigest', 'startDisplay']);
  const d = exact(r.startDisplay, displayKeys);
  for (const k of common) if (d[k] !== r[k]) throw Error();
  for (const k of displayKeys.filter(k => !['automaticEnable', 'expiresAt'].includes(k))) {
    if (typeof d[k] !== 'string' || !d[k] || (d[k] as string).length > 1024) throw Error();
  }
  if (d.tenantId !== tenantId || d.migrationJobId !== jobId || d.action !== 'DISABLE_LOCAL_WRITER_AND_START_FREEZING'
    || d.automaticEnable !== false || !uuid.test(String(r.challengeId)) || d.ceremonyId !== r.challengeId || d.consentChallengeId !== r.challengeId
    || !hash.test(String(r.csrfToken)) || !hash.test(String(r.startIntentDigest))
    || !Number.isSafeInteger(r.expiresAt) || Number(r.expiresAt) <= Date.now()) throw Error();
  for (const k of ['jobSemanticFingerprint', 'sourceAcquisitionDigest', 'preflightDigest', 'registrationDigest']) if (!hash.test(String(d[k]))) throw Error();
  return r as unknown as Challenge;
}
function authorization(value: unknown, challengeId: string): string {
  const r = exact(value, ['authorizationUrl']);
  if (typeof r.authorizationUrl !== 'string') throw Error();
  const u = new URL(r.authorizationUrl);
  if (u.origin !== 'https://accounts.google.com' || u.pathname !== '/o/oauth2/v2/auth' || u.username || u.password || u.hash
    || u.searchParams.getAll('redirect_uri').length !== 1
    || u.searchParams.get('redirect_uri') !== `${window.location.origin}/api/migrations/google-sheets/callback`
    || u.searchParams.getAll('state').length !== 1 || !u.searchParams.get('state')?.startsWith(`${challengeId}.`)) throw Error();
  return r.authorizationUrl;
}
const button = 'rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40';

/** Keyed identity boundary: transient synchronizers never survive a tenant/session
 * render, pagehide, hidden tab, expiry or failed attempt. Server rebinds the actual
 * HttpOnly login on every request; the client cannot inspect that cookie. */
export function MigrationFreezingPage(props: MigrationFreezingProps) {
  return <FreezingForm key={`${props.slug}:${props.tenantId}:${props.sessionKey}`} {...props} />;
}
function FreezingForm({ slug, tenantId }: MigrationFreezingProps) {
  const [jobId, setJobId] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState('');
  const [expiresAt, setExpiresAt] = useState(0);
  const [archive, setArchive] = useState<Archive | null>(null);
  const [status, setStatus] = useState('');
  const generation = useRef(0);
  const pending = useRef(false);
  const launch = useRef<{ url: string; expiresAt: number } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const validJob = jobId.length > 0 && jobId.length <= 1024 && jobId.trim() === jobId && jobId !== '.' && jobId !== '..';
  const base = (id: string) => `/api/c/${slug}/migrations/${encodeURIComponent(id)}/freezing/start`;
  function clearTransient() {
    generation.current++; controller.current?.abort(); pending.current = false;
    setBusy(false); setChallenge(null); setConfirmed(false); launch.current = null; setLink('');
  }
  useEffect(() => {
    const clear = () => {
      generation.current++; controller.current?.abort(); pending.current = false;
      setBusy(false); setChallenge(null); setConfirmed(false); launch.current = null; setLink('');
    };
    const hidden = () => { if (document.visibilityState === 'hidden') clear(); };
    window.addEventListener('pagehide', clear); document.addEventListener('visibilitychange', hidden);
    return () => { clear(); window.removeEventListener('pagehide', clear); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setTimeout(() => { setChallenge(null); setConfirmed(false); launch.current = null; setLink(''); }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  async function request(kind: 'challenge' | 'start' | 'status') {
    if (pending.current || !validJob || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return;
    if (kind === 'start' && (!challenge || !confirmed || challenge.expiresAt <= Date.now())) { clearTransient(); return; }
    if (kind === 'status' && !archive) return;
    pending.current = true; setBusy(true); setError(''); setStatus('');
    const version = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    const saved = challenge;
    const reference = archive;
    if (kind === 'start') { setChallenge(null); setConfirmed(false); }
    if (kind === 'challenge') { setChallenge(null); setConfirmed(false); launch.current = null; setLink(''); setArchive(null); }
    const timer = window.setTimeout(() => abort.abort(), 30_000);
    try {
      const init: RequestInit = { method: kind === 'start' ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal };
      let url = base(jobId);
      if (kind === 'challenge') url += '/challenge';
      if (kind === 'start' && saved) {
        init.headers = { 'content-type': 'application/json', 'x-csrf-token': saved.csrfToken };
        init.body = JSON.stringify({ challengeId: saved.challengeId, display: saved.startDisplay });
        setArchive({ jobId, attemptId: saved.challengeId, intentDigest: saved.startIntentDigest });
      }
      if (kind === 'status' && reference) {
        url = `${base(reference.jobId)}/${reference.attemptId}`;
        init.headers = { 'x-start-intent-digest': reference.intentDigest };
      }
      const response = await fetch(url, init);
      if (!response.ok || response.redirected) throw Error();
      const data: unknown = await response.json();
      if (version !== generation.current) return;
      if (kind === 'challenge') {
        const issued = parseChallenge(data, tenantId, jobId);
        setExpiresAt(issued.expiresAt); setChallenge(issued);
      }
      if (kind === 'start' && saved) {
        if (saved.expiresAt <= Date.now()) throw Error();
        const url = authorization(data, saved.challengeId);
        launch.current = { url, expiresAt: saved.expiresAt };
        setLink(url);
      }
      if (kind === 'status' && reference) {
        const r = record(data);
        if (r.scope !== 'ARCHIVAL_ONLY') throw Error();
        if (r.status === 'ABSENT') {
          exact(r, ['scope', 'status']);
          setStatus('ARCHIVAL_ONLY · ABSENT · UNKNOWN — 시작 기록 없음. 외부 writer 상태나 미실행을 증명하지 않습니다.');
        } else {
          exact(r, ['scope', 'status', 'jobStatus', 'ceremonyId', 'migrationJobId', 'executionDigest', 'exclusion']);
          if (r.status !== 'STARTED' || r.ceremonyId !== reference.attemptId || r.migrationJobId !== reference.jobId || r.exclusion !== 'NOT_PROVEN' || !hash.test(String(r.executionDigest)) || typeof r.jobStatus !== 'string') throw Error();
          setStatus(JSON.stringify(r, null, 2));
        }
      }
    } catch {
      if (version === generation.current) {
        setChallenge(null); setConfirmed(false); launch.current = null; setLink('');
        setError(kind === 'challenge' ? '확인 정보 발급 거부/실패. 세션과 작업을 확인하세요. 자동 재발급하지 않습니다.' : 'UNKNOWN — 세션 만료·거부·통신 실패일 수 있습니다. writer가 비활성 상태로 남을 수 있습니다. 자동 재시도/활성화하지 않습니다.');
      }
    } finally {
      window.clearTimeout(timer);
      if (version === generation.current) { pending.current = false; setBusy(false); }
    }
  }
  return <main className="mx-auto max-w-3xl space-y-4 p-5 text-sm text-slate-800">
    <a className="underline" href={`/c/${slug}/admin`}>관리자로 돌아가기</a>
    <h1 className="text-xl font-bold">마이그레이션 FREEZING</h1>
    <p className="rounded-lg border border-amber-300 bg-amber-50 p-3">DISABLE_LOCAL_WRITER_AND_START_FREEZING: 등록된 배포의 로컬 writer를 비활성화합니다. 실패해도 writer가 비활성 상태로 남을 수 있습니다. 자동 재시도·자동 활성화 없음. NOT_PROVEN은 전체 쓰기 동결·최종 import·ACTIVATE 완료가 아닙니다.</p>
    <p>현재 대상 tenant: <code>{tenantId}</code> / <code>{slug}</code>. 정확한 jobId를 입력하세요. 확인 정보 발급도 서버에 기록을 생성합니다.</p>
    <label className="block">jobId<input className="ml-2 rounded border p-2" value={jobId} onChange={e => { clearTransient(); setArchive(null); setStatus(''); setError(''); setJobId(e.target.value); }} /></label>
    <button className={button} disabled={busy || !validJob || !!archive} onClick={() => void request('challenge')}>확인 정보 발급</button>
    {busy && <p role="status">처리 중… 자동 재시도하지 않습니다.</p>}
    {challenge && <section className="space-y-3">
      <h2 className="font-semibold">서버 원본 확인 — raw Sheet ID / tenant / job·version·source / semantic·acquisition / PREFLIGHT / deployment·registration</h2>
      <pre aria-label="서버 확인 정보" className="overflow-auto whitespace-pre-wrap break-all rounded border bg-slate-50 p-3">{JSON.stringify(challenge.startDisplay, null, 2)}</pre>
      <label className="block"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> 위 원본 대상과 로컬 writer 비활성화 위험을 확인하고 이 작업에 동의합니다.</label>
      <button className={button} disabled={!confirmed || busy} onClick={() => void request('start')}>확인한 작업 시작</button>
    </section>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {link && <button type="button" onClick={() => {
      const target = launch.current;
      // Consume synchronously before dispatch: React state removal alone cannot
      // stop batched or reentrant clicks. No href exposes an auxiliary path.
      launch.current = null; setLink('');
      if (!target || target.expiresAt <= Date.now()) return;
      window.open(target.url, '_blank', 'noopener,noreferrer');
    }} className={button}>Google 동의 열기 (새 탭)</button>}
    {archive && <section className="space-y-3 rounded-lg border p-3">
      <h2 className="font-semibold">보관 조회 참조 (실행 권한 아님)</h2>
      <pre className="whitespace-pre-wrap break-all">{JSON.stringify(archive, null, 2)}</pre>
      <p>팝업이 열리지 않아도 자동 재시도·재발급하지 않습니다. 열린 탭 여부를 확인하고 아래 보관 상태를 수동 조회하세요. Google 동의 후 새 탭은 JSON STARTED/UNKNOWN을 표시합니다. 이 탭으로 돌아와 원래 로그인 세션으로 수동 조회하세요. 조회는 시작·재발급·재시도·writer 활성화를 하지 않습니다. 참조는 이 화면 메모리에만 남습니다. 페이지를 닫거나 새로고침하지 마세요.</p>
      <button className={button} disabled={busy} onClick={() => void request('status')}>보관 상태 조회</button>
      {status && <pre aria-label="보관 상태" className="whitespace-pre-wrap break-all">{status}</pre>}
    </section>}
  </main>;
}
