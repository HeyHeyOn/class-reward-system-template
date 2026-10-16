// @vitest-environment node
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { boardEnterUrl, boardLinksEnabled, boardTicket, createBoardClient } from './boardClient';

const SECRET = 'l'.repeat(40);
const ENV = {
  DDANSSAEM_BOARD_URL: 'https://board.example/', DDANSSAEM_LINK_SECRET: SECRET, DDANSSAEM_BOARD_BYPASS: 'bypass-value',
  DDANSSAEM_LOGIN: '1', DDANSSAEM_HUB_URL: 'https://hub.example', DDANSSAEM_CLIENT_SECRET: 's'.repeat(40),
};
const CLASS = '40000000-0000-4000-8000-000000000001';

describe('calling the 딴쌤 board server', () => {
  it('is on only with the board address, the link secret and 딴쌤 sign-in', () => {
    expect(boardLinksEnabled(ENV)).toBe(true);
    expect(boardLinksEnabled({ ...ENV, DDANSSAEM_BOARD_URL: '' })).toBe(false);
    expect(boardLinksEnabled({ ...ENV, DDANSSAEM_BOARD_URL: 'http://board.example' })).toBe(false);
    expect(boardLinksEnabled({ ...ENV, DDANSSAEM_LINK_SECRET: 'short' })).toBe(false);
    expect(boardLinksEnabled({ ...ENV, DDANSSAEM_LOGIN: '' })).toBe(false);
  });

  it('signs the exact body, sends the preview bypass, and reads the boards', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ boards: [
      { id: 'b1', code: 'f48ggq', title: '점검 그룹', format: 'group', groups: [{ id: 'g1', name: '그룹 1' }], linkedClassId: CLASS.toUpperCase() },
      { id: 'b2', code: 'x9', title: '퀴즈', format: 'quiz', groups: [{ id: 'g1', name: '무시' }], linkedClassId: null },
      { id: 'bad id', code: 'x', title: 't', format: 'mini' },
    ] }));
    const boards = await createBoardClient(ENV, fetchImpl as never).listBoards('teacher-sub', CLASS);
    expect(boards).toEqual([
      { id: 'b1', code: 'f48ggq', title: '점검 그룹', format: 'group', groups: [{ id: 'g1', name: '그룹 1' }], linkedClassId: CLASS },
      { id: 'b2', code: 'x9', title: '퀴즈', format: 'quiz', groups: [], linkedClassId: null },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://board.example/api/ddanssaem/link/boards');
    const body = String(init.body);
    expect(JSON.parse(body)).toMatchObject({ sub: 'teacher-sub', classId: CLASS, iat: expect.any(Number) });
    expect(init.headers['x-ddanssaem-signature']).toBe(createHmac('sha256', SECRET).update(body).digest('hex'));
    expect(init.headers['x-vercel-protection-bypass']).toBe('bypass-value');
  });

  it('turns the board server\'s answers into reasons', async () => {
    const answer = (status: number) => createBoardClient(ENV, (async () => Response.json({}, { status })) as never);
    await expect(answer(403).attach('s', 'b1', CLASS)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(answer(404).attach('s', 'b1', CLASS)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(answer(409).attach('s', 'b1', CLASS)).rejects.toMatchObject({ code: 'LINKED_ELSEWHERE', status: 409 });
    await expect(answer(500).listBoards('s', CLASS)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const timeout = Object.assign(new Error('late'), { name: 'TimeoutError' });
    await expect(createBoardClient(ENV, (async () => { throw timeout; }) as never).listBoards('s', CLASS)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(createBoardClient({ ...ENV, DDANSSAEM_LINK_SECRET: '' }, vi.fn() as never).listBoards('s', CLASS)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('reads the posts and submissions that count, dropping malformed ones', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ items: [
      { id: 'post-1', createdAt: '2026-10-16T03:00:00.000Z' }, { id: 'answered-b1-s1', createdAt: '2026-10-16T04:00:00Z' },
      { id: 'bad id!', createdAt: '2026-10-16T03:00:00Z' }, { id: 'post-2', createdAt: 'yesterday' },
    ] }));
    const items = await createBoardClient(ENV, fetchImpl as never).evidence({ sub: 's', boardId: 'b1', groupId: null, classId: CLASS, studentId: '01', from: '2026-10-16T00:00:00.000Z', to: null });
    expect(items).toEqual([{ id: 'post-1', createdAt: '2026-10-16T03:00:00.000Z' }, { id: 'answered-b1-s1', createdAt: '2026-10-16T04:00:00.000Z' }]);
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ groupId: null, studentId: '01', to: null });
  });
});

describe('the student\'s ticket into the board (8-3)', () => {
  it('signs a 60-second ticket for one student and board, new each time', () => {
    const now = Date.parse('2026-10-16T09:00:00Z');
    const ticket = boardTicket({ classId: CLASS, studentId: '01', boardId: 'b1' }, ENV, now);
    const [payload, signature] = ticket.split('.');
    expect(signature).toBe(createHmac('sha256', SECRET).update(payload).digest('hex'));
    const content = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    expect(content).toMatchObject({ v: 1, classId: CLASS, studentId: '01', boardId: 'b1', exp: now / 1000 + 60 });
    expect(Buffer.from(content.nonce, 'base64url')).toHaveLength(16);
    expect(boardTicket({ classId: CLASS, studentId: '01', boardId: 'b1' }, ENV, now)).not.toBe(ticket);
    expect(boardEnterUrl('f48ggq', ticket, ENV)).toBe(`https://board.example/f48ggq/enter?ticket=${encodeURIComponent(ticket)}`);
    expect(() => boardEnterUrl('../x', ticket, ENV)).toThrow();
  });
});
