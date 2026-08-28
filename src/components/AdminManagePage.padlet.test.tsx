import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminManagePage } from './AdminManagePage';

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

const BOARD_ID = 'AbCdEfGhIjKlMnOp';

const tasks = [{
  taskId: 'T001', title: '책 읽기', description: '설명', reward: 5, isActive: true,
  sortOrder: 1, allowedStudentIds: [], padletBoardId: BOARD_ID,
}];

describe('AdminManagePage Padlet linkage', () => {
  beforeEach(() => {
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return json([]);
      if (url === '/api/products?includeInactive=1') return json([]);
      if (url === '/api/tasks?includeInactive=1') return json(tasks);
      if (url === '/api/settings') return json({ themeColor: 'blue' });
      if (url === '/api/tasks' && init?.method === 'POST') return json({ ...tasks[0], taskId: 'T002' });
      if (url === '/api/tasks/batch' && init?.method === 'PATCH') return json(tasks);
      return json({});
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('extracts terminal board IDs from create URLs and warns about exact authenticated attribution', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    expect(screen.getByText(/Padlet.*로그인.*정확한 이름/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('새 과제명'), { target: { value: 'Padlet 쓰기' } });
    fireEvent.change(screen.getByLabelText('새 과제 보상'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('새 과제 Padlet URL (선택)'), {
      target: { value: `https://padlet.com/teacher/my-board-${BOARD_ID}` },
    });
    fireEvent.click(screen.getByRole('button', { name: '새 과제 추가' }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/tasks' && init?.method === 'POST');
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ padletBoardId: BOARD_ID });
    });
  });

  it('edits linkage and includes it in batch saves so bulk edits do not erase it', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 상세 설정 편집' }));
    expect(screen.getByLabelText('Padlet URL (선택)')).toHaveProperty('value', BOARD_ID);
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    fireEvent.click(screen.getByLabelText('T001 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 저장' }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/tasks/batch' && init?.method === 'PATCH');
      expect(JSON.parse(String(call?.[1]?.body)).tasks[0]).toHaveProperty('padletBoardId', BOARD_ID);
    });
  });
});
