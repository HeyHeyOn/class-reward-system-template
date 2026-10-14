'use client';

import { useId, useState } from 'react';
import { Button } from '../ui';
import { accountRequest, safeRedirect } from './accountApi';

/**
 * Explains what withdrawal does and performs it after the teacher ticks the confirmation.
 * `classNames` lists the classes this account owns, when known.
 */
export function WithdrawalConfirm({ classNames, expectedSessionId, onCancel, cancelLabel = '취소' }: Readonly<{
  classNames?: readonly string[];
  expectedSessionId?: string;
  onCancel?: () => void;
  cancelLabel?: string;
}>) {
  const id = useId();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function withdraw() {
    setBusy(true);
    setError('');
    const reply = await accountRequest('/api/account/withdraw', 'POST', { confirm: true, expectedSessionId });
    if (!reply.ok) {
      setBusy(false);
      setError(reply.error ?? '탈퇴를 마치지 못했어요. 잠시 뒤 다시 시도해 주세요.');
      return;
    }
    window.location.assign(safeRedirect(reply.data.redirectTo, '/classes?withdrawn=1'));
  }

  const classes = classNames?.length
    ? <>내가 만든 학급 {classNames.length}개(<strong className="font-bold">{classNames.join(', ')}</strong>)가 바로 닫혀요.</>
    : '내가 만든 학급이 모두 바로 닫혀요.';
  return (
    <div className="space-y-3.5">
      <ul className="list-disc space-y-1.5 rounded-[14px] bg-[var(--crs-danger-bg)] py-3 pl-8 pr-4 text-[13px] leading-relaxed text-[var(--crs-danger-text)]">
        <li>계정 정보, 닉네임과 프로필 아이콘, 약관 동의 기록이 바로 삭제돼요.</li>
        <li>{classes} 학생들도 더 이상 들어올 수 없고, 학생 정보, 거래, 과제, 성장, 보관함 기록과 이전 원본 자료가 함께 삭제돼요.</li>
        <li>탈퇴한 뒤에는 학급과 기록을 되살릴 수 없어요.</li>
        <li>같은 Google 계정으로 다시 가입할 수 있지만, 처음부터 새로 시작해요.</li>
      </ul>
      <div className="flex items-start gap-2.5">
        <input id={id} type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-[3px] h-[18px] w-[18px] shrink-0 accent-[var(--crs-danger-solid)]" />
        <label htmlFor={id} className="text-[14px] font-semibold leading-relaxed">위 내용을 확인했고, 탈퇴에 동의해요.</label>
      </div>
      {error ? <p role="alert" className="text-[13px] font-semibold text-[var(--crs-danger-text)]">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel ? <Button variant="ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</Button> : null}
        <Button variant="danger" onClick={() => void withdraw()} disabled={!confirmed || busy} loading={busy}>탈퇴하기</Button>
      </div>
    </div>
  );
}
