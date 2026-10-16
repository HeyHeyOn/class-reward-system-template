import 'server-only';

import { redirect } from 'next/navigation';
import { hubLoginEnabled, safeNextPath } from './hub';

// Account protocol 8: the hub's sign-in page is the only one, and a teacher screen follows the hub's sign-in
// state. In production the hub leaves a hint cookie on .ddanssaem.com (dd_hub, the hub session id); the app
// names it in DDANSSAEM_HINT_COOKIE. Previews (vercel.app) cannot read it and only send signed-out teachers to
// the hub. Student screens (QR store, bank) never come here.

type Env = Readonly<Record<string, string | undefined>>;

export const HUB_START_PATH = '/api/auth/ddanssaem/start';
/** Set for a minute by a sign-in without a prompt, so a teacher screen does not send the browser round again. */
export const HUB_TRIED_COOKIE = 'class_store_dd_tried';
export const HUB_TRIED_MAX_AGE_SECONDS = 60;

export function hubHintCookieName(env: Env = process.env): string | null {
  const name = env.DDANSSAEM_HINT_COOKIE?.trim();
  return name && /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : null;
}

/** Sign in through the hub and come back to `next`; `silent` asks the hub not to show anything (prompt=none). */
export function hubStartPath(next: string, options: Readonly<{ silent?: boolean }> = {}): string {
  return `${HUB_START_PATH}?${options.silent ? 'prompt=none&' : ''}next=${encodeURIComponent(safeNextPath(next))}`;
}

export function readCookie(cookieHeader: string | null | undefined, name: string): string | undefined {
  for (const part of (cookieHeader ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) {
      try {
        return decodeURIComponent(part.slice(at + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export type HubSignInState = 'SAME' | 'SIGNED_OUT' | 'OTHER' | 'UNKNOWN';

/** How this browser's class session stands against the hub's hint: the same hub session, none, another one. */
export function hubSignInState(session: Readonly<{ hubSid?: string }>, cookieHeader: string | null | undefined, env: Env = process.env): HubSignInState {
  const name = hubHintCookieName(env);
  if (!name) return 'UNKNOWN';
  const hint = readCookie(cookieHeader, name);
  if (!hint) return 'SIGNED_OUT';
  return hint === session.hubSid ? 'SAME' : 'OTHER';
}

/**
 * 8-3: where a teacher screen sends the browser, or null to show it. `session` is the class session that passed
 * the usual checks (or null). Off unless the hub signs teachers in (DDANSSAEM_LOGIN=1).
 */
export function teacherScreenRedirect(input: Readonly<{ path: string; session: Readonly<{ hubSid?: string }> | null; cookieHeader: string | null | undefined }>,
  env: Env = process.env): string | null {
  if (!hubLoginEnabled(env)) return null;
  const tried = readCookie(input.cookieHeader, HUB_TRIED_COOKIE) !== undefined;
  const name = hubHintCookieName(env);
  const hint = name ? readCookie(input.cookieHeader, name) : undefined;
  if (input.session) {
    const state = hubSignInState(input.session, input.cookieHeader, env);
    if (state === 'SIGNED_OUT') return hubStartPath(input.path);
    // Another hub session (another account, or a new sign-in): start ends this one and asks quietly.
    if (state === 'OTHER' && !tried) return hubStartPath(input.path, { silent: true });
    return null;
  }
  return hint && !tried ? hubStartPath(input.path, { silent: true }) : hubStartPath(input.path);
}

/** For a server page: follow 8-3 now (redirect throws), or return so the page renders. */
export function followHubSignIn(path: string, session: Readonly<{ hubSid?: string }> | null, cookieHeader: string | null | undefined): void {
  const target = teacherScreenRedirect({ path, session, cookieHeader });
  if (target) redirect(target);
}
