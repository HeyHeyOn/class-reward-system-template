'use client';

import { useRef, useState } from 'react';
import { Button, Callout, Modal } from '../ui';
import { giveBagItemsToStudents } from './bagClient';
import { GiveProductFields, giveOptionItemName, type GiveOption } from './GiveProductFields';

/** Puts one store product into the 보관함 of every selected student (a physical product as its 교환권). */
export function BulkGiveDialog({ studentIds, options, opener, onClose, notify }: Readonly<{
  studentIds: readonly string[]; options: readonly GiveOption[]; opener?: HTMLElement | null;
  onClose: () => void; notify: (message: string) => void;
}>) {
  const [productId, setProductId] = useState('');
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The same request retried after a network failure reuses its operation ID, so nothing is given twice.
  const attempt = useRef<{ key: string; operationId: string } | null>(null);
  const option = options.find((entry) => entry.productId === productId);

  async function give() {
    if (!option) { setError('넣을 상품을 골라 주세요.'); return; }
    const key = JSON.stringify([productId, count, [...studentIds].sort()]);
    if (attempt.current?.key !== key) attempt.current = { key, operationId: crypto.randomUUID() };
    setBusy(true);
    setError('');
    const result = await giveBagItemsToStudents({ studentIds, productId, count, operationId: attempt.current.operationId });
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    notify(`학생 ${studentIds.length}명의 보관함에 '${giveOptionItemName(option)}' ${count}개씩 넣었어요.`);
    onClose();
  }

  return (
    <Modal title="보관함에 한꺼번에 넣기" description={`선택한 학생 ${studentIds.length}명에게 같은 아이템을 넣어요. 실물 상품은 교환권으로 들어가요.`}
      onClose={onClose} busy={busy} opener={opener ?? undefined}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>취소</Button>
          <Button variant="primary" icon="package" loading={busy} disabled={busy || !option} onClick={() => void give()}>
            {studentIds.length}명에게 {count}개씩 넣기
          </Button>
        </>
      )}>
      <div className="space-y-3">
        {options.length === 0 ? <Callout tone="info">매점에 상품을 먼저 등록해 주세요.</Callout> : (
          <GiveProductFields idPrefix="bulk-give" options={options} productId={productId} count={count}
            onProductChange={setProductId} onCountChange={setCount} disabled={busy} />
        )}
        {option ? (
          <p className="text-sm text-[var(--theme-muted-text)]">
            학생마다 &apos;{giveOptionItemName(option)}&apos; {count}개, 모두 {studentIds.length * count}개가 들어가요.
          </p>
        ) : null}
        {error ? <div role="alert"><Callout tone="danger">{error}</Callout></div> : null}
      </div>
    </Modal>
  );
}
