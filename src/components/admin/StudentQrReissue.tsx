'use client';

import { useState } from 'react';
import { tenantFetch } from '@/lib/tenantApiPath';
import { Button, Callout } from '../ui';

export type QrReissueState = Readonly<{ confirming: boolean; pending: boolean; error: string; done: boolean }>;

const IDLE: QrReissueState = { confirming: false, pending: false, error: '', done: false };

/** The teacher's 'issue new QR codes' for some students: ask first, then retire their cards. */
export function useStudentQrReissue(onIssued: () => void) {
  const [state, setState] = useState<QrReissueState>(IDLE);
  return {
    state,
    ask: () => setState({ ...IDLE, confirming: true }),
    cancel: () => setState(IDLE),
    reset: () => setState(IDLE),
    async confirm(studentIds: readonly string[]) {
      setState({ confirming: true, pending: true, error: '', done: false });
      try {
        const response = await tenantFetch('/api/students/qr-reissue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ studentIds }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const error = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
            ? payload.error : 'QR을 새로 발급하지 못했어요. 다시 시도해 주세요.';
          setState({ confirming: true, pending: false, error, done: false });
          return;
        }
        setState({ ...IDLE, done: true });
        onIssued();
      } catch {
        setState({ confirming: true, pending: false, error: '연결이 끊겨 발급 결과를 확인하지 못했어요. 새로고침한 뒤 카드를 확인해 주세요.', done: false });
      }
    },
  };
}

/** Asks before issuing new codes, or says the new codes are ready to print. */
export function StudentQrReissueNotice({ state, count, onCancel, onConfirm }: Readonly<{
  state: QrReissueState;
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  if (state.done) {
    return (
      <Callout tone="success" title="새 QR을 발급했어요" className="mb-4 print:hidden">
        새 카드를 인쇄해 나눠 주세요. 전에 나눠 준 카드는 이제 쓸 수 없어요.
      </Callout>
    );
  }
  if (!state.confirming) return null;
  return (
    <Callout tone="warning" title={`학생 ${count}명의 QR을 새로 발급할까요?`} className="mb-4 print:hidden">
      <p>지금 쓰는 카드는 더 이상 쓸 수 없어요. 새 카드를 인쇄해 나눠 주세요.</p>
      {state.error ? <p role="alert" className="mt-1 font-semibold">{state.error}</p> : null}
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" disabled={state.pending} onClick={onCancel}>취소</Button>
        <Button size="sm" variant="danger" icon="refresh" loading={state.pending} disabled={state.pending} onClick={onConfirm}
          data-tour="student-qr-reissue-confirm">새로 발급</Button>
      </div>
    </Callout>
  );
}
