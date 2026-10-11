import 'server-only';

import { NextResponse } from 'next/server';
import { readBoundedRequestText, RequestBodyError } from '@/server/boundedRequestBody';
import { hasSameOrigin } from '@/server/classMutationRequest';
import { getGoogleSessionFromRequest, getPendingAgreementFromRequest, type GoogleSession, type PendingAgreement } from '@/server/googleOAuth';
import { teacherAccountsEnabled } from '@/server/teacherAccounts';
import { getProductionTeacherSessionStore, hasTeacherSessionBinding, type TeacherSessionBinding } from '@/server/teacherSession';

const MAX_BYTES = 1024;

export function accountReply(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export type AccountIdentity =
  | Readonly<{ kind: 'pending'; pending: PendingAgreement & TeacherSessionBinding }>
  | Readonly<{ kind: 'session'; session: GoogleSession & TeacherSessionBinding }>;

/** Do not choose silently between two browser identities. Check persisted lifetime before account actions. */
export async function readAccountIdentity(request: Request): Promise<AccountIdentity | null> {
  const pending = getPendingAgreementFromRequest(request);
  const session = getGoogleSessionFromRequest(request);
  if (pending && session && (pending.subject !== session.subject || pending.sessionId !== session.sessionId
    || pending.accountGeneration !== session.accountGeneration)) return null;
  const store = getProductionTeacherSessionStore();
  if (session && hasTeacherSessionBinding(session) && await store.valid(session, false, null)) return { kind: 'session', session };
  if (pending && hasTeacherSessionBinding(pending) && await store.valid(pending, true, null)) return { kind: 'pending', pending };
  return null;
}

/**
 * Same-origin JSON requests only (the account pages), small bodies, and only where teacher accounts
 * exist. Returns the parsed object body, or the response to send.
 */
export async function readAccountRequest(request: Request, options: Readonly<{ body: boolean }> = { body: true }): Promise<Record<string, unknown> | NextResponse> {
  if (!teacherAccountsEnabled()) return accountReply(404, { error: '이 서비스에서는 사용할 수 없는 기능이에요.' });
  const url = new URL(request.url);
  if (url.search || !hasSameOrigin(request, url) || request.headers.get('sec-fetch-site') !== 'same-origin'
    || (options.body && request.headers.get('content-type') !== 'application/json') || request.headers.has('content-encoding')) {
    return accountReply(403, { error: '이 화면에서 다시 시도해 주세요.' });
  }
  if (!options.body) return {};
  try {
    const text = await readBoundedRequestText(request, MAX_BYTES);
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return accountReply(400, { error: '입력을 확인해 주세요.' });
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413) return accountReply(413, { error: '입력이 너무 커요.' });
    return accountReply(400, { error: '입력을 확인해 주세요.' });
  }
}

export const SIGN_IN_AGAIN = '로그인이 필요하거나 만료되었어요. 다시 로그인해 주세요.';
export const TRY_AGAIN_LATER = '잠시 뒤 다시 시도해 주세요.';
