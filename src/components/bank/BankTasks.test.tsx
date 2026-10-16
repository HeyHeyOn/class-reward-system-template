import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BankTasks } from './BankTasks';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('BankTasks', () => {
  it('tells the student where to post when a waiting task is linked to a Padlet board', () => {
    render(<BankTasks currencyUnit="원" loading={false} error="" pending={null} busy={false} onComplete={vi.fn()} onRecheck={vi.fn()} onRetry={vi.fn()}
      tasks={[
        { taskId: 'T1', title: '칭찬 글쓰기', description: '', reward: 10, stage: 'PENDING', completable: false,
          padlet: { title: '5-6 칭찬 게시판', url: 'https://padlet.com/t/5-6-mvbij1byfal6f0ik', sectionTitle: '우리 반' } },
        { taskId: 'T2', title: '책 읽기', description: '', reward: 10, stage: 'PENDING', completable: false },
      ]} />);
    const [linked, plain] = screen.getAllByTestId('bank-task-card');
    expect(linked.textContent).toContain('패들렛 5-6 칭찬 게시판 ‘우리 반’ 칸에 내 이름으로 글을 올리면 완료할 수 있어요.');
    const open = within(linked).getByRole('link', { name: '칭찬 글쓰기 패들렛 열기' });
    expect(open.getAttribute('href')).toBe('https://padlet.com/t/5-6-mvbij1byfal6f0ik');
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toContain('noopener');
    expect(plain.textContent).toContain('선생님이 확인하면 완료할 수 있어요.');
    expect(within(plain).queryByRole('link')).toBeNull();
  });

  it('opens the linked 딴쌤 board with a ticket asked for on the click, in a tab opened at once', async () => {
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const fetchMock = vi.fn(async () => Response.json({ url: 'https://board.example/f48ggq/enter?ticket=t.s' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<BankTasks currencyUnit="원" loading={false} error="" pending={null} busy={false} onComplete={vi.fn()} onRecheck={vi.fn()} onRetry={vi.fn()}
      tasks={[{ taskId: 'T1', title: '모둠 의견 쓰기', description: '', reward: 10, stage: 'PENDING', completable: false,
        board: { title: '점검 그룹', format: 'group', groupName: '1모둠' } }]} />);
    const card = screen.getByTestId('bank-task-card');
    expect(card.textContent).toContain('딴쌤 보드 점검 그룹의 ‘1모둠’ 그룹에 글을 올리면 완료할 수 있어요.');
    fireEvent.click(within(card).getByRole('button', { name: '모둠 의견 쓰기 보드 열기' }));
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).toBe('https://board.example/f48ggq/enter?ticket=t.s'));
    expect(tab.opener).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/bank/me/board-ticket');
    expect(JSON.parse(String(init.body))).toEqual({ taskId: 'T1' });
  });

  it('closes the waiting tab and says why when the ticket is refused', async () => {
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: '연결된 보드를 찾지 못했어요.', code: 'BOARD_NOT_FOUND' }, { status: 404 })));
    render(<BankTasks currencyUnit="원" loading={false} error="" pending={null} busy={false} onComplete={vi.fn()} onRecheck={vi.fn()} onRetry={vi.fn()}
      tasks={[{ taskId: 'T1', title: '설문', description: '', reward: 10, stage: 'PENDING', completable: false,
        board: { title: '아침 설문', format: 'survey', groupName: null } }]} />);
    expect(screen.getByTestId('bank-task-card').textContent).toContain('딴쌤 보드 아침 설문에 제출하면 완료할 수 있어요.');
    fireEvent.click(screen.getByRole('button', { name: '설문 보드 열기' }));
    expect((await screen.findByRole('alert')).textContent).toBe('연결된 보드를 찾지 못했어요.');
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('');
  });
});
