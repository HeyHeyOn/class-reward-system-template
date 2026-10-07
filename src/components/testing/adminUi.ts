import { fireEvent, screen, waitFor, within } from '@testing-library/react';

/*
 * Interaction helpers for the redesigned admin page (sidebar menu + editor panels).
 * Tests describe *what* the administrator does; these helpers know *where* it happens.
 */

export type AdminMenu = '홈' | '학생' | '매점' | '과제' | '지급·회수' | '거래 내역' | '설정';

export async function openAdminMenu(name: AdminMenu) {
  fireEvent.click(await screen.findByRole('tab', { name }));
}

/** Waits until a task row with this title is listed. */
export function findTaskRow(title: string) {
  return screen.findByRole('button', { name: `${title} 과제 편집` });
}

/** Opens the task editor panel for a listed task and returns the panel. */
export async function openTaskEditor(title: string, tab: '기본 정보' | '반복' | '학생 현황' = '기본 정보') {
  fireEvent.click(await findTaskRow(title));
  const panel = await screen.findByRole('dialog', { name: `${title} 과제 편집` });
  if (tab !== '기본 정보') fireEvent.click(within(panel).getByRole('tab', { name: new RegExp(`^${tab}`) }));
  return panel;
}

export function taskEditorPanel(title: string) {
  return screen.getByRole('dialog', { name: `${title} 과제 편집` });
}

/** Opens the editor for a brand-new task. */
export async function openNewTaskEditor() {
  fireEvent.click(await screen.findByRole('button', { name: '새 과제' }));
  return screen.findByRole('dialog', { name: '새 과제' });
}

export async function openStudentEditor(studentId: string, name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `${studentId} ${name} 편집` }));
  return screen.findByRole('dialog', { name: `${studentId} 학생 편집` });
}

export async function openNewStudentEditor() {
  fireEvent.click(await screen.findByRole('button', { name: '학생 추가' }));
  return screen.findByRole('dialog', { name: '학생 추가' });
}

export async function openProductEditor(productId: string, name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `${productId} ${name} 편집` }));
  return screen.findByRole('dialog', { name: `${productId} 상품 편집` });
}

export async function openNewProductEditor() {
  fireEvent.click(await screen.findByRole('button', { name: '상품 추가' }));
  return screen.findByRole('dialog', { name: '상품 추가' });
}

/** The floating bar that appears while list rows are selected. */
export function selectionBar() {
  return screen.getByRole('toolbar', { name: '선택 항목 작업' });
}

/** Confirms the generic confirmation dialog (bulk deletes, discard changes). */
export async function confirmDialog(label: string | RegExp) {
  const button = await screen.findByRole('button', { name: label });
  fireEvent.click(button);
}

/** Latest in-app notice (toast). Replaces the former window.alert notices. */
export async function findNotice(text: string | RegExp) {
  return waitFor(() => {
    const notices = [...screen.queryAllByRole('status'), ...screen.queryAllByRole('alert')];
    const match = notices.find((notice) => typeof text === 'string' ? notice.textContent?.includes(text) : text.test(notice.textContent ?? ''));
    if (!match) throw new Error(`Notice not found: ${String(text)}`);
    return match;
  });
}
