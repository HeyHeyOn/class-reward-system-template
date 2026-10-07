'use client';

import { Button, Callout, Modal } from '../ui';
import { taskTargetSummary, type TaskDialogTarget } from '../tasks/taskTargetSummary';
import type { TaskDeleteConfirmation, ProductDeleteConfirmation } from './adminTypes';

export function TaskResetConfirmDialog({ confirmation, onCancel, onConfirm }: {
  confirmation: { target: TaskDialogTarget; opener: HTMLElement | null; resetting: boolean; error: string };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal size="sm" tone="warning" title="완료 기록을 초기화할까요?" ariaLabel="완료 기록 초기화 확인" description={`대상: ${taskTargetSummary(confirmation.target).short}`}
      opener={confirmation.opener} busy={confirmation.resetting} onClose={onCancel} hideWhileBusy
      footer={<>
        <Button variant="ghost" disabled={confirmation.resetting} onClick={onCancel}>취소</Button>
        <Button variant="primary" aria-label="완료 기록 초기화 확인" data-autofocus disabled={confirmation.resetting} loading={confirmation.resetting} onClick={onConfirm}>{confirmation.resetting ? '초기화 중...' : '초기화'}</Button>
      </>}>
      <p className="text-[13px] leading-relaxed text-[var(--theme-muted-text)]">이미 지급한 보상은 회수되지 않습니다. 같은 회차에서 학생이 은행에서 다시 완료하면 보상을 또 받을 수 있습니다.</p>
      {confirmation.error ? <Callout tone="danger" className="mt-3">{confirmation.error}</Callout> : null}
    </Modal>
  );
}

export function TaskDeleteConfirmDialog({ confirmation, onCancel, onConfirm }: {
  confirmation: TaskDeleteConfirmation;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal size="sm" tone="danger" title="과제를 삭제할까요?" ariaLabel={`${confirmation.title} 과제 삭제 확인`} opener={confirmation.opener} busy={confirmation.deleting} onClose={onCancel}
      footer={<>
        <Button variant="ghost" aria-label="과제 삭제 취소" disabled={confirmation.deleting} onClick={onCancel}>취소</Button>
        <Button variant="danger" aria-label="과제 삭제 확인" data-autofocus disabled={confirmation.deleting} loading={confirmation.deleting} onClick={onConfirm}>{confirmation.deleting ? '삭제 중...' : '삭제'}</Button>
      </>}>
      <p className="text-sm"><strong>{confirmation.title}</strong> <span className="text-[var(--theme-muted-text)]">({confirmation.taskId})</span> 과제를 삭제합니다. 이미 지급한 보상은 그대로 남습니다.</p>
      {confirmation.error ? <Callout tone="danger" className="mt-3">{confirmation.error}</Callout> : null}
    </Modal>
  );
}

export function ProductDeleteConfirmDialog({ confirmation, onCancel, onConfirm }: {
  confirmation: ProductDeleteConfirmation;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal size="sm" tone="danger" title="상품을 삭제할까요?" ariaLabel={`${confirmation.name} 상품 삭제 확인`} opener={confirmation.opener} busy={confirmation.deleting} onClose={onCancel}
      footer={<>
        <Button variant="ghost" aria-label="상품 삭제 취소" disabled={confirmation.deleting} onClick={onCancel}>취소</Button>
        <Button variant="danger" aria-label="상품 삭제 확인" data-autofocus disabled={confirmation.deleting} loading={confirmation.deleting} onClick={onConfirm}>{confirmation.deleting ? '삭제 중...' : '삭제'}</Button>
      </>}>
      <p className="text-sm"><strong>{confirmation.name}</strong> <span className="text-[var(--theme-muted-text)]">({confirmation.productId})</span> 상품을 삭제합니다. 지난 거래 기록은 그대로 남습니다.</p>
      {confirmation.error ? <Callout tone="danger" className="mt-3">{confirmation.error}</Callout> : null}
    </Modal>
  );
}
