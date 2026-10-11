// @vitest-environment node
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fetchPadletBoard, PadletApiError, parseBoard } from './padletApi';
import { normalizePadletApiKey, openPadletApiKey, padletKeyHint, sealPadletApiKey } from './padletKey';

vi.mock('server-only', () => ({}));

const ENV = { AUTH_SECRET: 'x'.repeat(40) };
const TENANT = '10000000-0000-4000-8000-000000000001';

/** The shape of a real reply (Padlet's public demo board, trimmed) with an anonymous and a pending post added. */
const BOARD = {
  data: { id: 'qk3sab0nz9rcp0wv', type: 'board', attributes: { title: 'Flags of 20 most populous Africa countries',
    webUrl: { live: 'https://padlet.com/linhpublicapidemo/flags-of-20-most-populous-africa-countries-qk3sab0nz9rcp0wv' } },
  relationships: { posts: { data: [{ id: 'post_E851Q0xd176lQVAb', type: 'post' }] } } },
  included: [
    { id: 'post_E851Q0xd176lQVAb', type: 'post', attributes: {
      author: { username: 'linh', shortName: 'Linh', fullName: 'Linh Nguyen', avatarUrl: 'https://padlet.net/monsters/104779.png' },
      sortIndex: 920224534528, content: { subject: '', bodyHtml: '<div>Burkina Faso<br><br></div>', updatedAt: '2023-07-28T03:04:10Z' },
      color: null, status: 'approved', webUrl: { live: 'https://padlet.com/linhpublicapidemo/flags-qk3sab0nz9rcp0wv/wish/2652429311' },
      createdAt: '2023-07-28T03:03:57Z', updatedAt: '2023-07-28T03:04:10Z', customFields: [] },
    relationships: { board: { data: { id: 'qk3sab0nz9rcp0wv', type: 'board' } }, section: { data: { id: 'sec_jzJX4EONWba6qbnO', type: 'section' } } } },
    { id: 'post_anon0001', type: 'post', attributes: { author: null, content: { subject: '  3번 김민준  ' }, status: 'approved', createdAt: '2026-10-11T01:02:03Z' },
      relationships: { section: { data: null } } },
    { id: 'post_pending01', type: 'post', attributes: { author: { fullName: '', shortName: '이서연' }, content: { subject: '' },
      status: 'pending_moderation', createdAt: '2026-10-11T02:00:00+09:00' } },
    { id: 'post_bad', type: 'post', attributes: { createdAt: 'not a date' } },
    { id: 'sec_b', type: 'section', attributes: { sortIndex: 2, title: '2번 김범준' } },
    { id: 'sec_jzJX4EONWba6qbnO', type: 'section', attributes: { sortIndex: 1, title: '우리 반' } },
  ],
};

describe('padlet board reply', () => {
  it('reads the title, sections in board order, and every post it can (author, title, section, time)', () => {
    const board = parseBoard(BOARD, 'qk3sab0nz9rcp0wv');
    expect(board).toMatchObject({ id: 'qk3sab0nz9rcp0wv', title: 'Flags of 20 most populous Africa countries',
      url: 'https://padlet.com/linhpublicapidemo/flags-of-20-most-populous-africa-countries-qk3sab0nz9rcp0wv',
      sections: [{ id: 'sec_jzJX4EONWba6qbnO', title: '우리 반' }, { id: 'sec_b', title: '2번 김범준' }] });
    expect(board.posts).toEqual([
      { id: 'post_E851Q0xd176lQVAb', createdAt: '2023-07-28T03:03:57.000Z', status: 'approved', authorName: 'Linh Nguyen', subject: '',
        sectionId: 'sec_jzJX4EONWba6qbnO', url: 'https://padlet.com/linhpublicapidemo/flags-qk3sab0nz9rcp0wv/wish/2652429311' },
      { id: 'post_anon0001', createdAt: '2026-10-11T01:02:03.000Z', status: 'approved', authorName: '', subject: '3번 김민준', sectionId: null, url: null },
      { id: 'post_pending01', createdAt: '2026-10-10T17:00:00.000Z', status: 'pending_moderation', authorName: '이서연', subject: '', sectionId: null, url: null },
    ]);
  });

  it('parses the saved real reply of the public demo board when present', () => {
    const path = process.env.PADLET_DEMO_REPLY;
    if (!path || !existsSync(path)) return;
    const board = parseBoard(JSON.parse(readFileSync(path, 'utf8')), 'qk3sab0nz9rcp0wv');
    expect(board.posts.length).toBeGreaterThan(5);
    expect(board.posts.every((post) => post.authorName && post.sectionId)).toBe(true);
  });

  it('turns Padlet refusals into reasons a teacher can act on', async () => {
    const reply = (status: number, code: string) => vi.fn(async () => new Response(JSON.stringify({ errors: [{ status: String(status), code }] }),
      { status, headers: { 'content-type': 'application/vnd.api+json' } }));
    for (const [status, code, expected] of [[401, 'INVALID_API_KEY', 'INVALID_KEY'], [403, 'NOT_PAYING_USER', 'NOT_PAYING'],
      [401, 'NOT_ADMIN', 'NOT_ADMIN'], [404, 'NOT_FOUND', 'NOT_FOUND'], [429, 'RATE_LIMIT_EXCEEDED', 'RATE_LIMITED'], [500, 'X', 'UNAVAILABLE']] as const) {
      await expect(fetchPadletBoard({ boardId: 'qk3sab0nz9rcp0wv', apiKey: 'key-123456', fetchImpl: reply(status, code) as never }))
        .rejects.toMatchObject({ code: expected });
    }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(BOARD), { status: 200, headers: { 'content-type': 'application/vnd.api+json' } }));
    const board = await fetchPadletBoard({ boardId: 'qk3sab0nz9rcp0wv', apiKey: ' key-123456 ', fetchImpl: fetchImpl as never });
    expect(board.posts).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.padlet.dev/v1/boards/qk3sab0nz9rcp0wv?include=posts,sections',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Api-Key': 'key-123456' }) }));
    await expect(fetchPadletBoard({ boardId: 'no', apiKey: 'key-123456', fetchImpl: fetchImpl as never })).rejects.toBeInstanceOf(PadletApiError);
  });
});

describe('padlet api key', () => {
  it('seals a key for one class and opens it only there', () => {
    const sealed = sealPadletApiKey('pdltp_secret_key_1234', TENANT, ENV);
    expect(sealed).toMatch(/^pk1\./);
    expect(sealed).not.toContain('secret');
    expect(openPadletApiKey(sealed, TENANT, ENV)).toBe('pdltp_secret_key_1234');
    expect(openPadletApiKey(sealed, '10000000-0000-4000-8000-000000000002', ENV)).toBeNull();
    expect(openPadletApiKey(sealed, TENANT, { AUTH_SECRET: 'y'.repeat(40) })).toBeNull();
    expect(padletKeyHint('pdltp_secret_key_1234')).toBe('1234');
    expect(normalizePadletApiKey('  pdltp_abc12345 ')).toBe('pdltp_abc12345');
    expect(normalizePadletApiKey('has space inside')).toBeNull();
    expect(normalizePadletApiKey('short')).toBeNull();
  });
});
