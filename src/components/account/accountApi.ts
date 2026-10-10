// Client calls to the teacher account API (same-origin JSON).

export type AccountReply = Readonly<{ ok: boolean; status: number; data: Record<string, unknown>; error?: string }>;

export async function accountRequest(path: '/api/account/agreement' | '/api/account/withdraw' | '/api/account/profile', method: 'POST' | 'DELETE', body?: unknown): Promise<AccountReply> {
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const error = typeof data.error === 'string' ? data.error : response.ok ? undefined : '요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
    return { ok: response.ok, status: response.status, data, error };
  } catch {
    return { ok: false, status: 0, data: {}, error: '인터넷 연결을 확인한 뒤 다시 시도해 주세요.' };
  }
}

/** Only same-site paths are followed after an account step. */
export function safeRedirect(value: unknown, fallback = '/classes'): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : fallback;
}
