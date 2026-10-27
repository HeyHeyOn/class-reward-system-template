'use client';

import { useSyncExternalStore } from 'react';
import { reminderDays, type TeacherVerification } from '@/lib/teacherVerification';
import { Button, Modal, buttonClass } from '../ui';
import { themeStyles } from '../uiTheme';

// The header sits outside the pages' themed area, so the window brings its own colors.
const theme = themeStyles('white');

// 교사 인증 다시 하기 (ddanssaem-hub/docs/account-protocol.md 10-4): on teacher screens, when the verification ends
// within 30 days or has ended, a small window once a day. [나중에] hides it on this device until tomorrow (Korea
// time), kept in browser storage under the hub's own key name. Student screens have no account, so never show it.

const HIDDEN_KEY = 'dd_verify_reminder';

function today(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function hiddenToday(): boolean {
  try { return window.localStorage.getItem(HIDDEN_KEY) === today(); } catch { return false; }
}

function hideToday() {
  try { window.localStorage.setItem(HIDDEN_KEY, today()); } catch { /* storage blocked: it shows again next time */ }
}

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function VerificationReminder({ verification, verifyUrl }: Readonly<{ verification: TeacherVerification; verifyUrl: string }>) {
  // Read in the browser only: the server cannot know what this device hid today, so it draws nothing.
  const days = useSyncExternalStore(subscribe, () => (hiddenToday() ? null : reminderDays(verification)), () => null);
  if (days === null) return null;
  const later = () => { hideToday(); listeners.forEach((listener) => listener()); };
  return (
    <div style={theme.variables}>
    <Modal title="교사 인증" size="sm" onClose={later}
      footer={<>
        <Button variant="ghost" onClick={later}>나중에</Button>
        <a href={verifyUrl} className={buttonClass({ variant: 'primary' })}>다시 인증</a>
      </>}>
      <p className="text-[15px] font-semibold leading-relaxed">{days === 0 ? '교사 인증이 끝났어요.' : `교사 인증이 ${days}일 뒤에 끝나요.`}</p>
    </Modal>
    </div>
  );
}
