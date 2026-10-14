'use client';

import { useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { buttonClass } from '@/components/ui';
const subscribe = () => () => {};

export function ClassStartForm({ slug, operationId }: Readonly<{ slug: string; operationId: string }>) {
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  const inFlight = useRef(false);
  const [state, setState] = useState<'ready' | 'pending' | 'uncertain' | 'refused' | 'complete'>('ready');
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || inFlight.current || !['ready', 'uncertain'].includes(state)) return;
    inFlight.current = true;
    setState('pending');
    try {
      const response = await fetch(`/api/classes/${slug}/start`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId }),
      });
      const data: unknown = await response.json();
      if (response.ok && data && typeof data === 'object' && 'slug' in data && data.slug === slug
        && 'lifecycle' in data && data.lifecycle === 'ACTIVE') {
        setState('complete');
        setMessage('학급을 사용할 준비가 끝났어요. 학생과 상품을 등록해 보세요.');
      } else {
        setState(response.status >= 400 && response.status < 500 ? 'refused' : 'uncertain');
        setMessage(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
          ? data.error : '결과를 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요.');
      }
    } catch {
      setState('uncertain');
      setMessage('연결이 끊겼어요. 같은 요청으로 다시 확인하거나 내 학급 목록을 열어 주세요.');
    } finally { inFlight.current = false; }
  }
  return (
    <form method="post" onSubmit={submit} className="space-y-5">
      <p className="text-sm leading-relaxed text-[var(--theme-muted-text)]">학생과 거래 기록이 없는 새 학급을 시작해요.</p>
      {state === 'complete' ? (
        <a href={`/c/${slug}/admin`} className={buttonClass({ variant: 'primary', size: 'lg', block: true })}>학급 관리 열기</a>
      ) : (
        <button disabled={!ready || state === 'pending' || state === 'refused'} type="submit"
          className={buttonClass({ variant: 'primary', size: 'lg', block: true })}>
          {state === 'uncertain' ? '같은 요청으로 다시 확인' : state === 'pending' ? '학급 준비 중…' : '학급 사용 시작'}
        </button>
      )}
      {message && <p role="status" className="rounded-[12px] bg-[var(--crs-subtle)] px-4 py-3 text-[13px] font-semibold">{message}</p>}
      <a href="/classes" className="block text-center text-[13px] font-semibold text-[var(--theme-muted-text)] underline-offset-4 hover:underline">내 학급 확인</a>
    </form>
  );
}
