import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { BankTasks } from './BankTasks';

afterEach(cleanup);

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
});
