import 'server-only';

import { isPadletBoardId, type PadletPost, type PadletPostStatus, type PadletSection } from '@/domain/padlet';

/**
 * Reads one board from the Padlet public API (https://docs.padlet.dev, JSON:API, `X-Api-Key`).
 * Only paid (Gold/Platinum) accounts get keys, and the key's owner must be an admin of the board.
 */

export type PadletApiErrorCode =
  | 'NO_KEY'          // no key was given
  | 'INVALID_KEY'     // Padlet refused the key
  | 'NOT_PAYING'      // the key's account has no paid plan
  | 'NOT_ADMIN'       // the key's account is not an admin of the board
  | 'NOT_FOUND'       // no such board (or archived)
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UNAVAILABLE';    // anything else: network, Padlet error, unexpected reply

export class PadletApiError extends Error {
  constructor(readonly code: PadletApiErrorCode) {
    super(`Padlet board could not be read (${code}).`);
    this.name = 'PadletApiError';
  }
}

export type PadletBoard = Readonly<{
  id: string;
  title: string;
  url: string;
  sections: readonly PadletSection[];
  posts: readonly PadletPost[];
}>;

const API = 'https://api.padlet.dev/v1';
const MAX_BYTES = 8_000_000;
const STATUSES: readonly PadletPostStatus[] = ['approved', 'pending_moderation', 'scheduled'];

export async function fetchPadletBoard(input: Readonly<{
  boardId: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}>): Promise<PadletBoard> {
  if (!isPadletBoardId(input.boardId)) throw new PadletApiError('NOT_FOUND');
  if (!input.apiKey.trim()) throw new PadletApiError('NO_KEY');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 8_000);
  try {
    const response = await (input.fetchImpl ?? fetch)(`${API}/boards/${input.boardId}?include=posts,sections`, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: { accept: 'application/vnd.api+json', 'X-Api-Key': input.apiKey.trim() },
      signal: controller.signal,
    });
    const text = await readBounded(response);
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new PadletApiError(response.ok ? 'UNAVAILABLE' : errorFromStatus(response.status, null));
    }
    if (!response.ok) throw new PadletApiError(errorFromStatus(response.status, firstErrorCode(payload)));
    return parseBoard(payload, input.boardId);
  } catch (error) {
    if (error instanceof PadletApiError) throw error;
    throw new PadletApiError(controller.signal.aborted ? 'TIMEOUT' : 'UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

function firstErrorCode(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.errors)) return null;
  const first = payload.errors[0];
  return isRecord(first) && typeof first.code === 'string' ? first.code : null;
}

function errorFromStatus(status: number, code: string | null): PadletApiErrorCode {
  switch (code) {
    case 'NO_API_KEY': return 'NO_KEY';
    case 'INVALID_API_KEY': return 'INVALID_KEY';
    case 'NOT_PAYING_USER': return 'NOT_PAYING';
    case 'NOT_ADMIN': return 'NOT_ADMIN';
    case 'NOT_FOUND': case 'PADLET_ARCHIVED': return 'NOT_FOUND';
    case 'RATE_LIMIT_EXCEEDED': return 'RATE_LIMITED';
    default: break;
  }
  if (status === 401) return 'INVALID_KEY';
  if (status === 403) return 'NOT_PAYING';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  return 'UNAVAILABLE';
}

/** Parses the board; a malformed post is skipped rather than failing the whole board. */
export function parseBoard(payload: unknown, boardId: string): PadletBoard {
  if (!isRecord(payload) || !isRecord(payload.data) || payload.data.type !== 'board' || payload.data.id !== boardId
    || !isRecord(payload.data.attributes)) throw new PadletApiError('UNAVAILABLE');
  const attributes = payload.data.attributes;
  const included = Array.isArray(payload.included) ? payload.included : [];
  const webUrl = isRecord(attributes.webUrl) && typeof attributes.webUrl.live === 'string' ? attributes.webUrl.live : '';
  const sections: Array<PadletSection & { order: number }> = [];
  const posts: PadletPost[] = [];
  for (const entry of included) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !isRecord(entry.attributes)) continue;
    if (entry.type === 'section' && /^[A-Za-z0-9_-]{1,64}$/.test(entry.id)) {
      const order = typeof entry.attributes.sortIndex === 'number' ? entry.attributes.sortIndex : Number.MAX_SAFE_INTEGER;
      sections.push({ id: entry.id, title: text(entry.attributes.title, 300), order });
      continue;
    }
    if (entry.type !== 'post' || !/^[A-Za-z0-9_-]{3,128}$/.test(entry.id)) continue;
    const post = entry.attributes;
    const createdAt = typeof post.createdAt === 'string' ? Date.parse(post.createdAt) : NaN;
    if (!Number.isFinite(createdAt)) continue;
    const author = isRecord(post.author) ? post.author : {};
    const content = isRecord(post.content) ? post.content : {};
    const section = isRecord(entry.relationships) && isRecord(entry.relationships.section) && isRecord(entry.relationships.section.data)
      && typeof entry.relationships.section.data.id === 'string' ? entry.relationships.section.data.id : null;
    const status = typeof post.status === 'string' && (STATUSES as readonly string[]).includes(post.status) ? post.status as PadletPostStatus
      : post.status === null || post.status === undefined ? 'approved' : null;
    posts.push({
      id: entry.id,
      createdAt: new Date(createdAt).toISOString(),
      status,
      authorName: text(author.fullName, 100) || text(author.shortName, 100),
      subject: text(content.subject, 300),
      sectionId: section,
      url: isRecord(post.webUrl) && typeof post.webUrl.live === 'string' && /^https:\/\//.test(post.webUrl.live) ? post.webUrl.live.slice(0, 500) : null,
    });
  }
  return {
    id: boardId,
    title: text(attributes.title, 300),
    url: /^https:\/\//.test(webUrl) ? webUrl.slice(0, 500) : `https://padlet.com/padlets/${boardId}`,
    // Padlet's own order (sortIndex), as the board shows them.
    sections: sections.sort((a, b) => a.order - b.order).map(({ id, title }) => ({ id, title })),
    posts,
  };
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBounded(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_BYTES) throw new PadletApiError('UNAVAILABLE');
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new PadletApiError('UNAVAILABLE');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}
