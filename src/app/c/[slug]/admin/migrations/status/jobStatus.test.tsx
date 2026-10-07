import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ reader: vi.fn(), headers: vi.fn() }));
vi.mock('@/app/api/migrations/status/readStatus', () => ({ readMigrationStatus: mocks.reader }));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
import Page, { metadata } from './page';
const page = (query: Record<string, string | string[] | undefined> = { jobId: 'job-explicit-1' }) => Page({
  params: Promise.resolve({ slug: 'alpha' }), searchParams: Promise.resolve(query),
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.headers.mockResolvedValue(new Headers({ cookie: 'private-cookie' }));
  mocks.reader.mockResolvedValue({ kind: 'JOB_AVAILABLE', status: {
    availability: 'AVAILABLE', migrationStatus: 'ACTIVE', authority: 'UNKNOWN', readOnly: true,
    reasonCode: 'OPERATIONAL_AUTHORITY_UNVERIFIED',
    reason: '저장된 작업 상태만 표시합니다. 실제 운영 권한은 확인되지 않았습니다.',
  } });
});
afterEach(cleanup);

describe('explicit job status page', () => {
  it('does not forward the explicit job selector in browser referrers', () => {
    expect(metadata).toHaveProperty('referrer', 'no-referrer');
  });

  it('passes only the explicit selector and shows stored ACTIVE separately from UNKNOWN authority', async () => {
    const { container } = render(await page());
    expect(mocks.reader).toHaveBeenCalledWith('alpha', expect.any(Request), 'job-explicit-1');
    expect(screen.getByRole('status').textContent).toContain('저장된 작업 상태');
    expect(container.textContent).toContain('ACTIVE');
    expect(container.textContent).toContain('현재 운영 권한');
    expect(container.textContent).toContain('확인 불가 (UNKNOWN)');
    expect(container.textContent).toContain('실제 운영 권한은 확인되지 않았습니다.');
    expect(container.querySelectorAll('form, button, input, select, textarea, script')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('job-explicit-1');
    expect(container.innerHTML).not.toContain('private');
  });

  it.each([
    ['JOB_NOT_FOUND', '작업을 찾을 수 없음'],
    ['JOB_UNAVAILABLE', '작업 상태 확인 불가'],
    ['INVALID_REQUEST', '잘못된 작업 선택'],
  ])('renders the redacted %s result without guessed state', async (kind, title) => {
    mocks.reader.mockResolvedValue({ kind });
    const { container } = render(await page());
    expect(screen.getByRole('status').textContent).toContain(title);
    expect(container.textContent).not.toContain('ACTIVE');
    expect(container.querySelectorAll('form, button, input, script')).toHaveLength(0);
  });

  it('passes a duplicate selector unchanged to the validating reader rather than selecting one', async () => {
    mocks.reader.mockResolvedValue({ kind: 'INVALID_REQUEST' });
    render(await page({ jobId: ['first-job', 'second-job'] }));
    expect(mocks.reader).toHaveBeenCalledWith('alpha', expect.any(Request), ['first-job', 'second-job']);
    expect(screen.getByRole('status').textContent).toContain('잘못된 작업 선택');
  });
});
