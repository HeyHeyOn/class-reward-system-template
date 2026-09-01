import 'server-only';

export type PadletClientErrorCode =
  | 'CONFIGURATION'
  | 'TIMEOUT'
  | 'UPSTREAM'
  | 'INVALID_RESPONSE';

export class PadletClientError extends Error {
  constructor(readonly code: PadletClientErrorCode) {
    super('Padlet evidence verification is unavailable.');
    this.name = 'PadletClientError';
  }
}

export type PadletPost = Readonly<{
  id: string;
  createdAt: string;
  authorFullName: string;
}>;

export type FetchPadletBoardPostsInput = Readonly<{
  boardId: string;
  apiKey?: string;
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}>;

export function isCanonicalPadletPostId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 3 && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

export async function fetchPadletBoardPosts(
  input: FetchPadletBoardPostsInput,
): Promise<PadletPost[]> {
  const apiKey = input.apiKey ?? input.env?.PADLET_API_KEY ?? process.env.PADLET_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new PadletClientError('CONFIGURATION');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 8_000);
  try {
    const response = await (input.fetchImpl ?? fetch)(
      `https://api.padlet.dev/v1/boards/${encodeURIComponent(input.boardId)}?include=posts`,
      {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'X-API-KEY': apiKey },
        signal: controller.signal,
      },
    );
    if (!response.ok || response.redirected) {
      throw new PadletClientError('UPSTREAM');
    }
    if (response.headers.get('content-type') !== 'application/vnd.api+json') {
      throw new PadletClientError('INVALID_RESPONSE');
    }
    const rawBody = await readBoundedBody(response);
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      throw new PadletClientError('INVALID_RESPONSE');
    }
    return parseIncludedPosts(payload, input.boardId);
  } catch (error) {
    if (error instanceof PadletClientError) throw error;
    throw new PadletClientError(controller.signal.aborted ? 'TIMEOUT' : 'UPSTREAM');
  } finally {
    clearTimeout(timeout);
  }
}

const MAX_RESPONSE_BYTES = 1_000_000;

function parseIncludedPosts(payload: unknown, boardId: string): PadletPost[] {
  if (!isRecord(payload) || !isRecord(payload.data)
    || payload.data.type !== 'board' || payload.data.id !== boardId
    || !isRecord(payload.data.relationships) || !isRecord(payload.data.relationships.posts)
    || !Array.isArray(payload.data.relationships.posts.data)
    || !Array.isArray(payload.included)) {
    throw new PadletClientError('INVALID_RESPONSE');
  }
  if (Object.hasOwn(payload, 'links')) {
    if (!isRecord(payload.links)
      || (Object.hasOwn(payload.links, 'next') && payload.links.next !== null)) {
      throw new PadletClientError('INVALID_RESPONSE');
    }
  }
  const postsRelationship = payload.data.relationships.posts;
  const relationshipData = payload.data.relationships.posts.data;
  if (Object.hasOwn(postsRelationship, 'links')) {
    if (!isRecord(postsRelationship.links)
      || (Object.hasOwn(postsRelationship.links, 'next') && postsRelationship.links.next !== null)) {
      throw new PadletClientError('INVALID_RESPONSE');
    }
  }
  const relationshipIds = relationshipData.map((entry) => {
    if (!isRecord(entry) || entry.type !== 'post' || !isCanonicalPadletPostId(entry.id)) {
      throw new PadletClientError('INVALID_RESPONSE');
    }
    return entry.id;
  });
  if (relationshipIds.length > 200 || new Set(relationshipIds).size !== relationshipIds.length) {
    throw new PadletClientError('INVALID_RESPONSE');
  }
  const relationshipSet = new Set(relationshipIds);
  const includedIds = new Set<string>();
  const posts: PadletPost[] = [];
  for (const entry of payload.included) {
    if (!isRecord(entry)
      || entry.type !== 'post'
      || !isCanonicalPadletPostId(entry.id) || !relationshipSet.has(entry.id) || includedIds.has(entry.id)
      || !isRecord(entry.attributes)
      || (entry.attributes.status !== null
        && (typeof entry.attributes.status !== 'string'
          || !['approved', 'pending_moderation', 'scheduled'].includes(entry.attributes.status)))
      || typeof entry.attributes.createdAt !== 'string'
      || !isRecord(entry.attributes.author)
      || typeof entry.attributes.author.fullName !== 'string'
      || !entry.attributes.author.fullName.trim()) {
      throw new PadletClientError('INVALID_RESPONSE');
    }
    includedIds.add(entry.id);
    const createdAt = canonicalRfc3339(entry.attributes.createdAt);
    if (entry.attributes.status === 'approved') {
      posts.push({
        id: entry.id,
        createdAt,
        authorFullName: entry.attributes.author.fullName,
      });
    }
  }
  if (includedIds.size !== relationshipSet.size
    || relationshipIds.some((id) => !includedIds.has(id))) {
    throw new PadletClientError('INVALID_RESPONSE');
  }
  return posts;
}

function canonicalRfc3339(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new PadletClientError('INVALID_RESPONSE');
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [y, mo, d, h, mi, s] = parts;
  const local = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (local.getUTCFullYear() !== y || local.getUTCMonth() !== mo - 1 || local.getUTCDate() !== d
    || local.getUTCHours() !== h || local.getUTCMinutes() !== mi || local.getUTCSeconds() !== s) {
    throw new PadletClientError('INVALID_RESPONSE');
  }
  const milliseconds = Number((fraction + '000').slice(0, 3));
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const sign = zone[0] === '+' ? 1 : -1;
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutePart = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutePart > 59) throw new PadletClientError('INVALID_RESPONSE');
    offsetMinutes = sign * (offsetHours * 60 + offsetMinutePart);
  }
  const timestamp = Date.UTC(y, mo - 1, d, h, mi, s, milliseconds) - offsetMinutes * 60_000;
  const canonical = new Date(timestamp);
  if (!Number.isFinite(canonical.getTime())) throw new PadletClientError('INVALID_RESPONSE');
  return canonical.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new PadletClientError('INVALID_RESPONSE');
  }
  if (!response.body) {
    const value = await response.text();
    if (new TextEncoder().encode(value).byteLength > MAX_RESPONSE_BYTES) {
      throw new PadletClientError('INVALID_RESPONSE');
    }
    return value;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new PadletClientError('INVALID_RESPONSE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
