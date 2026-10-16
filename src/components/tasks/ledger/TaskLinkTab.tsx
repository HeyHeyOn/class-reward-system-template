'use client';

import { useState } from 'react';
import type { AdminTaskDto } from '@/lib/taskLedgerApi';
import { Callout } from '../../ui';
import { BoardTaskTab, LinkProviderChoice, useBoardLinkStatus, type LinkProvider } from './BoardLinking';
import type { LedgerStudent } from './LedgerParts';
import { PadletTaskTab } from './PadletLinking';
import type { TaskLedger } from './useTaskLedger';

/** A task's 연결 tab: [딴쌤 보드] or [패들렛], when the class can link boards. */
export function TaskLinkTab({ ledger, task, students, notify, busy, onBusy }: Readonly<{
  ledger: TaskLedger; task: AdminTaskDto; students: readonly LedgerStudent[]; notify: (message: string) => void;
  busy: boolean; onBusy: (busy: boolean) => void;
}>) {
  const status = useBoardLinkStatus();
  const [chosen, setChosen] = useState<LinkProvider | null>(null);
  const enabled = status.status?.enabled === true;
  const provider: LinkProvider = !enabled ? 'padlet' : chosen ?? (task.padlet && !task.board ? 'padlet' : 'board');
  return (
    <div className="space-y-5">
      {enabled ? <LinkProviderChoice value={provider} onChange={setChosen} disabled={busy} /> : null}
      {provider === 'board'
        ? <BoardTaskTab ledger={ledger} task={task} notify={notify} busy={busy} onBusy={onBusy} status={status} />
        : <>
          {task.board ? <Callout tone="info" title="딴쌤 보드 연결이 바뀌어요">패들렛에 연결하면 지금 연결된 딴쌤 보드 ‘{task.board.boardTitle || '보드'}’ 연결은 끊겨요.</Callout> : null}
          <PadletTaskTab ledger={ledger} task={task} students={students} notify={notify} busy={busy} onBusy={onBusy} />
        </>}
    </div>
  );
}
