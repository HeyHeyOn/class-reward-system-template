'use client';

import { Button, Modal } from '../ui';

export type Notice = Readonly<{ title: string; message: string; tone?: 'info' | 'danger' }>;

/** A short notice in its own window: why a button cannot be used now, or what went wrong. */
export function NoticeDialog({ notice, onClose }: Readonly<{ notice: Notice; onClose: () => void }>) {
  return (
    <Modal size="sm" tone={notice.tone ?? 'info'} title={notice.title} onClose={onClose}
      footer={<Button variant="primary" size="lg" block data-autofocus onClick={onClose}>확인</Button>}>
      <p className="text-[15px] font-semibold leading-relaxed">{notice.message}</p>
    </Modal>
  );
}
