import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminManagePage } from './AdminManagePage';
import { findTaskRow, openAdminMenu, selectionBar } from './testing/adminUi';
let bodies: string[];
const rows = [
  { taskId: 'T1', taskInstanceId: 'instance:T1', taskVersion: 3, title: 'Delete Task One', description: '', reward: 10, isActive: true, sortOrder: 1, allowedStudentIds: [], createdAt: '2026-09-30T00:00:00.000Z' },
  { taskId: 'T2', taskInstanceId: 'instance:T2', taskVersion: 8, title: 'Delete Task Two', description: '', reward: 20, isActive: false, sortOrder: 2, allowedStudentIds: [], createdAt: '2026-09-30T00:00:00.000Z' },
];
beforeEach(() => {
  window.history.replaceState(null, '', '/admin');
  bodies = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/products')) return Response.json({ products: [], mutationPreconditions: [] });
    // The reply carries no task IDs, so the page falls back to the selected ones.
    if (url.endsWith('/tasks/batch') && init?.method === 'DELETE') { bodies.push(String(init.body)); return Response.json({}); }
    if (url.endsWith('/tasks?includeInactive=1')) return Response.json(rows);
    return Response.json(url.includes('/settings') ? {} : []);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });
/* Rows are read-only now; the list stays mounted (aria-hidden while a modal is open), so rows are read by test id. */
const hasRow = (title: string) => screen.queryAllByTestId('task-row').some((row) => row.textContent?.includes(title));
// PostgreSQL (tenant) classes use the stage ledger instead (see AdminManagePage.taskLedger.test.tsx).
describe('Sheets task selection delete', () => {
  it('preserves the unscoped legacy request and ID fallback', async () => {
    render(<AdminManagePage />); await openAdminMenu('과제');
    await findTaskRow('Delete Task One'); fireEvent.click(screen.getByRole('checkbox', { name: '전체 과제 선택' }));
    fireEvent.click(within(selectionBar()).getByRole('button', { name: '삭제' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: /삭제할까요/ })).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(bodies).toHaveLength(1)); expect(JSON.parse(bodies[0])).toEqual({ taskIds: ['T1', 'T2'] });
    await waitFor(() => expect(hasRow('Delete Task One')).toBe(false));
  });
});
