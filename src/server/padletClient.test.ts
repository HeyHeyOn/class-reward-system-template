import { describe, expect, it, vi } from 'vitest';
import { fetchPadletBoardPosts, PadletClientError } from './padletClient';

vi.mock('server-only', () => ({}));

const BOARD_ID = 'AbCdEfGhIjKlMnOp';
const API_KEY = 'test-api-key';

function post(id: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'post',
    id,
    attributes: {
      status: 'approved',
      createdAt: '2026-08-28T01:02:03Z',
      author: { fullName: '김학생' },
      ...overrides,
    },
  };
}

function boardPayload(posts = [post('post-1')], boardId = BOARD_ID) {
  return {
    data: {
      type: 'board',
      id: boardId,
      relationships: {
        posts: { data: posts.map(({ id }) => ({ type: 'post', id })) },
      },
    },
    included: posts,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/vnd.api+json' },
    ...init,
  });
}

describe('fetchPadletBoardPosts', () => {
  it('fetches the complete board and returns only approved posts', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(boardPayload([
      post('post-approved'),
      post('post-pending', { status: 'pending_moderation' }),
      post('post-unmoderated', { status: null }),
    ])));

    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl }))
      .resolves.toEqual([{
        id: 'post-approved',
        createdAt: '2026-08-28T01:02:03.000Z',
        authorFullName: '김학생',
      }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.padlet.dev/v1/boards/${BOARD_ID}?include=posts`,
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'X-API-KEY': API_KEY },
      }),
    );
  });

  it('rejects pagination indicators and noncanonical post IDs', async () => {
    const paginated = vi.fn(async () => jsonResponse({
      ...boardPayload(),
      links: { next: 'https://api.padlet.dev/v1/boards/next' },
    }));
    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl: paginated }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    for (const id of ['x', 'bad/id', 'x'.repeat(129)]) {
      const fetchImpl = vi.fn(async () => jsonResponse(boardPayload([post(id)])));
      await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl }))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });

  it.each([
    ['non-null next link', { next: 'https://api.padlet.dev/v1/boards/next' }],
    ['malformed links value', 'https://api.padlet.dev/v1/boards/next'],
  ])('rejects posts relationship pagination metadata: %s', async (_label, links) => {
    const payload = boardPayload();
    payload.data.relationships.posts = {
      ...payload.data.relationships.posts,
      links,
    } as typeof payload.data.relationships.posts;
    const fetchImpl = vi.fn(async () => jsonResponse(payload));

    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    ['absent next link', {}],
    ['null next link', { next: null }],
  ])('accepts complete posts relationship pagination metadata: %s', async (_label, links) => {
    const payload = boardPayload();
    payload.data.relationships.posts = {
      ...payload.data.relationships.posts,
      links,
    } as typeof payload.data.relationships.posts;
    const fetchImpl = vi.fn(async () => jsonResponse(payload));

    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl }))
      .resolves.toHaveLength(1);
  });

  it('fails closed before network access when the API key is missing', async () => {
    const fetchImpl = vi.fn();

    const error = await fetchPadletBoardPosts({ boardId: BOARD_ID, env: {}, fetchImpl })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PadletClientError);
    expect(error).toMatchObject({ code: 'CONFIGURATION' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts the request and response-body read after eight seconds', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        status: 200,
        redirected: false,
        headers: new Headers({ 'content-type': 'application/vnd.api+json' }),
        body: null,
        text: () => new Promise<string>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('secret detail', 'AbortError')));
        }),
      } as Response);
    });
    try {
      const pending = fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl })
        .catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(7_999);
      expect(observedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toMatchObject({ code: 'TIMEOUT' });
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a non-success status without reading or retrying', async () => {
    const text = vi.fn(async () => 'secret provider body');
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 429,
      redirected: false,
      headers: new Headers(),
      text,
    } as unknown as Response));

    const error = await fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'UPSTREAM' });
    expect(String(error)).not.toContain('429');
    expect(String(error)).not.toContain('secret');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
  });

  it('rejects a redirected response even if a fetch double marks it successful', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      redirected: true,
      headers: new Headers(),
      text: vi.fn(async () => JSON.stringify(boardPayload())),
    } as unknown as Response));

    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl }))
      .rejects.toMatchObject({ code: 'UPSTREAM' });
  });

  it('rejects a response body larger than the byte limit', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(1_000_001), {
      status: 200,
      headers: { 'content-type': 'application/vnd.api+json' },
    }));

    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects a malformed included post instead of skipping it', async () => {
    for (const attributes of [
      { status: 'approved', createdAt: '2026-08-28T01:02:03Z' },
      { status: { toString: () => 'approved' }, createdAt: '2026-08-28T01:02:03Z', author: { fullName: '김학생' } },
    ]) {
      const malformed = post('post-1') as Record<string, unknown>;
      malformed.attributes = attributes;
      const fetchImpl = vi.fn(async () => jsonResponse(boardPayload([malformed as ReturnType<typeof post>])));

      await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl }))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });

  it.each([
    ['wrong board identity', boardPayload([post('post-1')], 'DifferentBoardId1')],
    ['missing relationship post', {
      ...boardPayload([post('post-1')]),
      data: {
        ...boardPayload().data,
        relationships: { posts: { data: [] } },
      },
    }],
    ['missing included post', {
      ...boardPayload([post('post-1')]),
      included: [],
    }],
  ])('rejects an incomplete JSON:API board collection: %s', async (_label, payload) => {
    const fetchImpl = vi.fn(async () => jsonResponse(payload));
    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('normalizes offset timestamps and rejects non-RFC3339 or impossible timestamps', async () => {
    const validFetch = vi.fn(async () => jsonResponse(boardPayload([
      post('post-1', { createdAt: '2026-08-28T10:02:03+09:00' }),
    ])));
    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl: validFetch }))
      .resolves.toEqual([expect.objectContaining({ createdAt: '2026-08-28T01:02:03.000Z' })]);

    for (const createdAt of ['2026-08-28T01:02:03', '2026-02-30T01:02:03Z']) {
      const fetchImpl = vi.fn(async () => jsonResponse(boardPayload([post('post-1', { createdAt })])));
      await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl }))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });

  it('rejects non-JSON:API media and collections over 200 posts', async () => {
    const wrongMedia = vi.fn(async () => jsonResponse(boardPayload(), {
      headers: { 'content-type': 'application/json' },
    }));
    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl: wrongMedia }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    const parameterizedMedia = vi.fn(async () => jsonResponse(boardPayload(), {
      headers: { 'content-type': 'application/vnd.api+json; charset=utf-8' },
    }));
    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl: parameterizedMedia }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    const posts = Array.from({ length: 201 }, (_, index) => post(`post-${index}`));
    const oversizedCollection = vi.fn(async () => jsonResponse(boardPayload(posts)));
    await expect(fetchPadletBoardPosts({ boardId: BOARD_ID, apiKey: API_KEY, fetchImpl: oversizedCollection }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
