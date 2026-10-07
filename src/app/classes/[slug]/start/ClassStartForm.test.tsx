import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { ClassStartForm } from './ClassStartForm';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const props = { slug: 'class-example', operationId: '50000000-0000-4000-8000-000000000001' };
it('keeps the native form inert before hydration', () => {
  const document = new DOMParser().parseFromString(renderToString(<ClassStartForm {...props} />), 'text/html');
  expect(document.querySelector('button')!.disabled).toBe(true);
  expect(document.querySelector('form')!.method).toBe('post');
});
it('reuses the exact operation after response loss and offers management after success', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('network'))
    .mockResolvedValueOnce(Response.json({ slug: props.slug, lifecycle: 'ACTIVE', replayed: true }));
  vi.stubGlobal('fetch', fetcher);
  render(<ClassStartForm {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '학급 사용 시작' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '같은 요청으로 다시 확인' })).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: '같은 요청으로 다시 확인' }));
  await waitFor(() => expect(screen.getByRole('link', { name: '학급 관리 열기' }).getAttribute('href')).toBe('/c/class-example/admin'));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ operationId: props.operationId });
});
it('does not resubmit a definite refusal', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ error: '이전할 자료가 있습니다.' }, { status: 409 }));
  vi.stubGlobal('fetch', fetcher); render(<ClassStartForm {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '학급 사용 시작' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('이전할 자료'));
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button'));
  expect(fetcher).toHaveBeenCalledOnce();
});
