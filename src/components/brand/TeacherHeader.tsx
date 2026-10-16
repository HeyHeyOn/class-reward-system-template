import 'server-only';

import { headers } from 'next/headers';
import { getTeacherGoogleSessionFromRequest } from '@/server/teacherSession';
import { loadTeacherAccountView, teacherAccountsEnabled } from '@/server/teacherAccounts';
import { hubLoginEnabled } from '@/server/ddanssaem/hub';
import { hubStartPath } from '@/server/ddanssaem/teacherGate';
import { GlobalHeader, type HeaderAccount } from './GlobalHeader';

/** The teacher's header for a server page: reads who is signed in unless the page already knows it.
 *  `returnTo` is where sign-in comes back to from the 로그인 button (the 딴쌤 hub's sign-in page in hub mode). */
export async function TeacherHeader({ account, returnTo = '/classes', showLogin = true }: Readonly<{
  account?: HeaderAccount | null;
  returnTo?: string;
  showLogin?: boolean;
}>) {
  const signedIn = account !== undefined ? account : await currentTeacher();
  return (
    <GlobalHeader audience="teacher" account={signedIn}
      loginHref={!showLogin ? undefined
        : hubLoginEnabled() ? hubStartPath(returnTo) : `/api/google/login?returnTo=${encodeURIComponent(returnTo)}`} />
  );
}

async function currentTeacher(): Promise<HeaderAccount | null> {
  try {
    const session = await getTeacherGoogleSessionFromRequest(new Request('http://classes.internal/', { headers: await headers() }));
    if (!session) return null;
    if (!teacherAccountsEnabled()) return { nickname: session.name || session.email };
    const { profile } = await loadTeacherAccountView(session);
    return { nickname: profile.nickname, avatar: profile.avatar };
  } catch (error) {
    // The header never breaks the page under it; it shows the signed-out state instead.
    console.error('[header] teacher could not be read', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}
