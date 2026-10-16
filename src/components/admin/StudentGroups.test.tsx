import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentGroupAssignDialog, StudentGroupManagerDialog, useStudentGroups, type StudentGroupView } from './StudentGroups';

const ONE = { id: '11111111-1111-4111-8111-111111111111', name: '1모둠', students: ['S1', 'S2'] };
const TWO = { id: '22222222-2222-4222-8222-222222222222', name: '2모둠', students: [] };
let groups: StudentGroupView[];
const posts: Record<string, unknown>[] = [];

beforeEach(() => {
  groups = [ONE, TWO];
  posts.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json({ groups });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    posts.push(body);
    if (body.action === 'create' && body.name === '1모둠') return Response.json({ error: '같은 이름의 모둠이 있어요.', code: 'NAME_TAKEN' }, { status: 409 });
    return Response.json({ groups });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('모둠', () => {
  it('reads the class\'s groups and knows each student\'s group', async () => {
    const { result } = renderHook(() => useStudentGroups(true, 'S1,S2,S3'));
    await waitFor(() => expect(result.current.groups).toHaveLength(2));
    expect(result.current.groupOf.get('S1')?.name).toBe('1모둠');
    expect(result.current.groupOf.has('S3')).toBe(false);
    const { result: off } = renderHook(() => useStudentGroups(false, 'S1'));
    expect(off.current.groups).toEqual([]);
  });

  it('creates a group, and renames or deletes one from its ⋯ menu', async () => {
    const { result } = renderHook(() => useStudentGroups(true, ''));
    await waitFor(() => expect(result.current.groups).toHaveLength(2));
    render(<StudentGroupManagerDialog groups={result.current.groups} change={result.current.change} onClose={vi.fn()} opener={null} />);
    const dialog = screen.getByRole('dialog', { name: '모둠' });
    fireEvent.change(within(dialog).getByLabelText('새 모둠 이름'), { target: { value: '1모둠' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '만들기' }));
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', '같은 이름의 모둠이 있어요.');
    fireEvent.change(within(dialog).getByLabelText('새 모둠 이름'), { target: { value: '3모둠' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ action: 'create', name: '3모둠' }));

    fireEvent.click(within(dialog).getByRole('button', { name: '1모둠 메뉴' }));
    fireEvent.click(within(dialog).getByRole('menuitem', { name: '이름 바꾸기' }));
    fireEvent.change(within(dialog).getByLabelText('1모둠 새 이름'), { target: { value: '별빛' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ action: 'rename', groupId: ONE.id, name: '별빛' }));

    fireEvent.click(within(dialog).getByRole('button', { name: '2모둠 메뉴' }));
    fireEvent.click(within(dialog).getByRole('menuitem', { name: '지우기' }));
    expect(within(dialog).getByText('2모둠 모둠을 지울까요? 학생은 그대로예요.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ action: 'delete', groupId: TWO.id }));
  });

  it('puts the selected students in a group or in none', async () => {
    const { result } = renderHook(() => useStudentGroups(true, ''));
    await waitFor(() => expect(result.current.groups).toHaveLength(2));
    const onDone = vi.fn();
    render(<StudentGroupAssignDialog groups={result.current.groups} studentIds={['S3', 'S4']} change={result.current.change}
      onClose={vi.fn()} onDone={onDone} onManage={vi.fn()} opener={null} />);
    const dialog = screen.getByRole('dialog', { name: '모둠 지정' });
    fireEvent.click(within(dialog).getByRole('radio', { name: /2모둠/ }));
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '지정' })); });
    expect(posts.at(-1)).toEqual({ action: 'assign', groupId: TWO.id, studentIds: ['S3', 'S4'] });
    expect(onDone).toHaveBeenCalledWith('학생 2명을 2모둠에 넣었어요.');
    fireEvent.click(within(dialog).getByRole('radio', { name: /모둠 없음/ }));
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '지정' })); });
    expect(posts.at(-1)).toEqual({ action: 'assign', groupId: null, studentIds: ['S3', 'S4'] });
    expect(onDone).toHaveBeenLastCalledWith('학생 2명을 모둠에서 뺐어요.');
  });
});
