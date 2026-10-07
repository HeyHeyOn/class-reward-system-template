'use client';

import { useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Button, Field, Input, cx } from '@/components/ui';

const subscribeToReadiness = () => () => {};

type StartMode = 'now' | 'later';

export function ClassCreationForm({ operationId, startOperationId }: Readonly<{ operationId: string; startOperationId?: string }>) {
  // Server HTML is visible before React can intercept submission. Keep it
  // inert until hydration, otherwise the browser performs a native GET and
  // puts the class name in the URL instead of calling the creation API.
  const ready = useSyncExternalStore(subscribeToReadiness, () => true, () => false);
  const submitted = useRef(false);
  const [locked, setLocked] = useState(false);
  const [message, setMessage] = useState('');
  const [startMode, setStartMode] = useState<StartMode>('now');
  const startNow = startMode === 'now' && Boolean(startOperationId);

  async function startClass(slug: string) {
    // A fresh empty class is started in the same flow. Any failure leaves the
    // class in preparation, where the start page retries the same operation.
    try {
      const response = await fetch(`/api/classes/${encodeURIComponent(slug)}/start`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: startOperationId }),
      });
      const data: unknown = await response.json().catch(() => null);
      if (response.ok && data && typeof data === 'object' && 'lifecycle' in data && data.lifecycle === 'ACTIVE') {
        window.location.assign(`/c/${encodeURIComponent(slug)}/admin`);
        return;
      }
    } catch { /* Fall through to the start page. */ }
    window.location.assign(`/classes/${encodeURIComponent(slug)}/start`);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || submitted.current) return;
    const displayName = String(new FormData(event.currentTarget).get('displayName') ?? '');
    submitted.current = true;
    setLocked(true);
    try {
      const response = await fetch('/api/classes', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, displayName }),
      });
      if (response.status === 201 || response.status === 200) {
        const data: unknown = await response.json().catch(() => null);
        const slug = data && typeof data === 'object' && 'slug' in data && typeof data.slug === 'string' ? data.slug : null;
        const lifecycle = data && typeof data === 'object' && 'lifecycle' in data ? data.lifecycle : null;
        if (startNow && slug && lifecycle === 'DRAFT') {
          setMessage('학급을 만들었습니다. 사용을 시작하는 중입니다.');
          await startClass(slug);
          return;
        }
        window.location.assign('/classes');
        return;
      }
      const data: unknown = await response.json();
      setMessage(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error : '결과를 확인하지 못했습니다. 내 학급 목록을 확인해 주세요.');
      // Only definite pre-write input rejection is editable. Unknown commits,
      // auth failures and conflicts must never silently obtain a new operation.
      if (response.status === 400 || response.status === 413) {
        submitted.current = false;
        setLocked(false);
      }
    } catch {
      setMessage('연결이 끊겨 생성 결과를 확인하지 못했습니다. 다시 만들지 말고 내 학급 목록을 확인해 주세요.');
    }
  }

  const options: Array<{ value: StartMode; title: string; description: string }> = [
    { value: 'now', title: '바로 사용 시작', description: '빈 학급을 만들고 바로 관리자 화면으로 이동합니다.' },
    { value: 'later', title: '준비 중으로 두기', description: '기존 구글 시트 자료를 옮겨 올 학급이라면 선택하세요.' },
  ];

  return (
    <form method="post" onSubmit={submit} className="space-y-6">
      <Field label="학급 이름" htmlFor="displayName" hint="예: 6학년 3반, 2026 행복반">
        <Input id="displayName" name="displayName" required maxLength={80} disabled={!ready || locked} autoComplete="off" placeholder="6학년 3반" className="h-12 text-base" />
      </Field>
      {startOperationId ? (
        <fieldset disabled={!ready || locked}>
          <legend className="mb-2 text-[13px] font-bold">시작 방법</legend>
          <div className="grid gap-2">
            {options.map((option) => (
              <label key={option.value} className={cx('flex cursor-pointer items-start gap-3 rounded-[14px] border px-4 py-3 transition-colors',
                startMode === option.value ? 'border-[var(--theme-accent-text)] bg-[var(--crs-subtle)]' : 'border-[var(--crs-line)] hover:bg-[var(--crs-subtle)]')}>
                <input type="radio" name="startMode" value={option.value} checked={startMode === option.value} onChange={() => setStartMode(option.value)} className="mt-1 h-4 w-4 accent-[var(--theme-accent-text)]" />
                <span>
                  <span className="block text-sm font-bold">{option.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-[var(--theme-muted-text)]">{option.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <Button type="submit" variant="primary" size="lg" block disabled={!ready || locked} loading={locked && !message}>
        {startNow ? '학급 만들기' : '준비 중 학급 만들기'}
      </Button>
      {message && <p role="alert" className="rounded-[12px] bg-[var(--crs-subtle)] px-4 py-3 text-[13px] font-semibold">{message}</p>}
      <a className="block text-center text-[13px] font-semibold text-[var(--theme-muted-text)] underline-offset-4 hover:underline" href="/classes">내 학급 확인</a>
    </form>
  );
}
