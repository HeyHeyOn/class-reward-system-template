import { describe, expect, it, vi } from 'vitest';
import {
  PadletClientError,
  fetchPadletBoardPosts,
  parsePadletBoardId,
} from './padletClient';

const BOARD_ID = 'AbCdEfGhIjKlMnOp';

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function boardPayload(overrides: Record<string, unknown> = {}) {
  return {
    data: { type: 'board', id: BOARD_ID },
    included: [
      {
        type: 'post',
        id: 'post-1',
        attributes: {
          status: 'approved',
          createdAt: '2026-08-01T01:02:03.000Z',
          author: { fullName: '김학생' },
          ...overrides,
        },
      },
      {
        type: 'post',
        id: 'post-2',
        attributes: {
          status: 'pending_moderation',
          createdAt: '2026-08-01T02:02:03.000Z',
          author: null,
        },
      },
      { type: 'user', id: 'user-1', attributes: { full_name: 'ignored' } },
    ],
  };
}

describe('parsePadletBoardId', () => {
  it.each([
    [`https://padlet.com/teacher/class-board-${BOARD_ID}`, BOARD_ID],
    [`https://www.padlet.com/teacher/${BOARD_ID}/`, BOARD_ID],
  ])('extracts a terminal canonical board id from %s', (url, expected) => {
    expect(parsePadletBoardId(url)).toBe(expected);
  });

  it.each([
    `http://padlet.com/teacher/${BOARD_ID}`,
    `https://evil.example/teacher/${BOARD_ID}`,
    `https://padlet.com.evil.example/teacher/${BOARD_ID}`,
    `https://user:password@padlet.com/teacher/${BOARD_ID}`,
    `https://padlet.com/teacher/${BOARD_ID}?next=https://padlet.com/x/${BOARD_ID}`,
    `https://padlet.com/teacher/${BOARD_ID}#${BOARD_ID}`,
    `https://padlet.com/teacher/${BOARD_ID}/extra`,
    'not a url',
  ])('rejects non-canonical or deceptive URL %s', (url) => {
    expect(parsePadletBoardId(url)).toBeNull();
  });
});

describe('fetchPadletBoardPosts', () => {
  it('uses the official endpoint and API key and maps validated included posts', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(boardPayload()));

    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: 'top-secret', fetchImpl }))
      .resolves.toEqual([
        {
          id: 'post-1',
          approved: true,
          createdAt: '2026-08-01T01:02:03.000Z',
          author: { fullName: '김학생' },
        },
        {
          id: 'post-2',
          approved: false,
          createdAt: '2026-08-01T02:02:03.000Z',
          author: null,
        },
      ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.padlet.dev/v1/boards/${BOARD_ID}?include=posts`,
      expect.objectContaining({ headers: { 'X-API-KEY': 'top-secret' } }),
    );
  });

  it.each([
    [401, 'AUTHENTICATION'],
    [403, 'AUTHENTICATION'],
    [429, 'RATE_LIMITED'],
    [500, 'UPSTREAM'],
  ] as const)('maps HTTP %i to safe error code %s without response or API-key leakage', async (status, code) => {
    const fetchImpl = vi.fn(async () => new Response('top-secret upstream body', { status }));
    const error = await fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: 'top-secret', fetchImpl })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(PadletClientError);
    expect(error).toMatchObject({ code, status });
    expect(String(error)).not.toContain('top-secret');
  });

  it('rejects malformed included post objects instead of accepting partial data', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(boardPayload({ createdAt: 'yesterday' })));

    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: 'key', fetchImpl }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects unknown statuses but treats the official nullable status as not approved', async () => {
    const unknownFetch = vi.fn(async () => jsonResponse(boardPayload({ status: 'mystery' })));
    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: 'key', fetchImpl: unknownFetch }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    const nullFetch = vi.fn(async () => jsonResponse(boardPayload({ status: null })));
    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: 'key', fetchImpl: nullFetch }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'post-1', approved: false })]));
  });

  it.each([
    'yesterday',
    '2026-02-31T00:00:00Z',
    '2026-08-01T01:02:03',
    '2026-08-01T10:02:03.000+09:00',
    '2026-08-01T01:02:03Z',
    '2026-08-01T01:02:03.000000Z',
  ]) (
    'rejects malformed or timezone-less createdAt %s', async (createdAt) => {
      const fetchImpl = vi.fn(async () => jsonResponse(boardPayload({ createdAt })));
      await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: 'key', fetchImpl }))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    },
  );

  it('does not retain secret-bearing network causes', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('api-key-secret network detail'); });
    const error = await fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: 'api-key-secret', fetchImpl })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(PadletClientError);
    expect(error).toMatchObject({ code: 'UPSTREAM' });
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('api-key-secret');
  });

  it('fails safely when PADLET_API_KEY is missing', async () => {
    const fetchImpl = vi.fn();

    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, env: {}, fetchImpl }))
      .rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the five-second timeout active while reading the response body', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null = null;
    let completeBody = () => {};
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? null;
      return Promise.resolve({
        ok: true,
        json: () => new Promise((resolve, reject) => {
          completeBody = () => resolve(boardPayload());
          requestSignal?.addEventListener('abort', () => reject(new DOMException('api-key-secret', 'AbortError')));
        }),
      } as Response);
    });
    try {
      const pending = fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: 'test-api-key', fetchImpl })
        .catch((caught) => caught);
      await vi.advanceTimersByTimeAsync(5_000);
      const observedSignal = requestSignal as AbortSignal | null;
      const wasAborted = observedSignal?.aborted === true;
      if (!wasAborted) completeBody();
      const result = await pending;

      expect(wasAborted).toBe(true);
      expect(result).toMatchObject({ code: 'TIMEOUT' });
      expect(result.cause).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an upstream request after the five-second timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));

    const pending = expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: 'key', fetchImpl }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    vi.useRealTimers();
  });
});
