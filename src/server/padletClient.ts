export type PadletPost = {
  id: string;
  approved: boolean;
  createdAt: string;
  author: { fullName: string | null } | null;
};

export type PadletClientErrorCode =
  | 'CONFIGURATION'
  | 'INVALID_BOARD_ID'
  | 'AUTHENTICATION'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UPSTREAM'
  | 'INVALID_RESPONSE';

export class PadletClientError extends Error {
  readonly code: PadletClientErrorCode;
  readonly status?: number;
  readonly retryAfter?: string;

  constructor(
    code: PadletClientErrorCode,
    message: string,
    options: { status?: number; retryAfter?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'PadletClientError';
    this.code = code;
    this.status = options.status;
    this.retryAfter = options.retryAfter;
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type PadletEnvironment = {
  [key: string]: string | undefined;
  PADLET_API_KEY?: string;
};

export function parsePadletBoardId(value: string): string | null {
  try {
    const url = new URL(value);
    const canonicalHost = url.hostname === 'padlet.com' || url.hostname === 'www.padlet.com';
    if (
      url.protocol !== 'https:'
      || !canonicalHost
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return null;
    }

    const segments = url.pathname.split('/').filter(Boolean);
    const terminalSegment = segments.at(-1);
    if (!terminalSegment) return null;

    const match = terminalSegment.match(/(?:^|-)([A-Za-z0-9]{16,22})$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Canonical external IDs accepted by the Sheets completion-evidence codec. */
export function isCanonicalPadletPostId(value: string): boolean {
  return value.length >= 3 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

export async function fetchPadletBoardPosts({
  boardId,
  apiKey,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 5_000,
}: {
  boardId: string;
  apiKey?: string;
  env?: PadletEnvironment;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<PadletPost[]> {
  if (!/^[A-Za-z0-9]{16,22}$/.test(boardId)) {
    throw new PadletClientError('INVALID_BOARD_ID', 'The Padlet board ID is invalid.');
  }

  const resolvedApiKey = apiKey ?? env.PADLET_API_KEY;
  if (!resolvedApiKey?.trim()) {
    throw new PadletClientError('CONFIGURATION', 'Padlet API access is not configured.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `https://api.padlet.dev/v1/boards/${boardId}?include=posts`,
      {
        method: 'GET',
        headers: { 'X-API-KEY': resolvedApiKey },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new PadletClientError('AUTHENTICATION', 'Padlet API authentication failed.', {
          status: response.status,
        });
      }
      if (response.status === 429) {
        throw new PadletClientError('RATE_LIMITED', 'Padlet API rate limit was reached.', {
          status: response.status,
          retryAfter: response.headers.get('retry-after') ?? undefined,
        });
      }
      throw new PadletClientError('UPSTREAM', 'Padlet API returned an error.', {
        status: response.status,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      if (controller.signal.aborted || isAbortError(cause)) {
        throw new PadletClientError('TIMEOUT', 'The Padlet API request timed out.');
      }
      throw new PadletClientError('INVALID_RESPONSE', 'The Padlet API response was invalid.');
    }

    return parseIncludedPosts(payload);
  } catch (cause) {
    if (cause instanceof PadletClientError) throw cause;
    if (controller.signal.aborted || isAbortError(cause)) {
      throw new PadletClientError('TIMEOUT', 'The Padlet API request timed out.');
    }
    throw new PadletClientError('UPSTREAM', 'The Padlet API request failed.');
  } finally {
    clearTimeout(timeout);
  }
}

function parseIncludedPosts(payload: unknown): PadletPost[] {
  if (!isRecord(payload) || !Array.isArray(payload.included)) {
    throw new PadletClientError('INVALID_RESPONSE', 'The Padlet API response was invalid.');
  }

  return payload.included
    .filter((resource): resource is Record<string, unknown> => isRecord(resource) && resource.type === 'post')
    .map(parsePostResource);
}

function parsePostResource(resource: Record<string, unknown>): PadletPost {
  if (typeof resource.id !== 'string' || !isCanonicalPadletPostId(resource.id) || !isRecord(resource.attributes)) {
    throw new PadletClientError('INVALID_RESPONSE', 'A Padlet post was invalid.');
  }

  const { status, createdAt, author } = resource.attributes;
  const officialStatuses = new Set(['approved', 'pending_moderation', 'scheduled']);
  if (
    (status !== null && (typeof status !== 'string' || !officialStatuses.has(status)))
    || typeof createdAt !== 'string'
    || !isStrictIsoTimestamp(createdAt)
  ) {
    throw new PadletClientError('INVALID_RESPONSE', 'A Padlet post was invalid.');
  }

  let mappedAuthor: PadletPost['author'];
  if (author === null) {
    mappedAuthor = null;
  } else if (isRecord(author)) {
    const fullName = author.fullName;
    if (fullName !== null && typeof fullName !== 'string') {
      throw new PadletClientError('INVALID_RESPONSE', 'A Padlet post author was invalid.');
    }
    mappedAuthor = { fullName: fullName ?? null };
  } else {
    throw new PadletClientError('INVALID_RESPONSE', 'A Padlet post author was invalid.');
  }

  return {
    id: resource.id,
    approved: status === 'approved',
    createdAt,
    author: mappedAuthor,
  };
}

export function isStrictIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
