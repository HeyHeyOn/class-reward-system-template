import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { ClassCreationForm } from './ClassCreationForm';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('keeps server-rendered controls disabled until the submit handler is hydrated', () => {
  const document = new DOMParser().parseFromString(renderToString(
    <ClassCreationForm operationId="50000000-0000-4000-8000-000000000001" />,
  ), 'text/html');
  expect(document.querySelector('input')!.disabled).toBe(true);
  expect(document.querySelector('button')!.disabled).toBe(true);
  expect(document.querySelector('form')!.method).toBe('post');
  render(<ClassCreationForm operationId="50000000-0000-4000-8000-000000000001" />);
  expect((screen.getByLabelText('학급 이름') as HTMLInputElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: '준비 중 학급 만들기' }) as HTMLButtonElement).disabled).toBe(false);
});
it('submits once; uncertain network outcome disables further creation and offers the list', async () => {
  const fetcher = vi.fn().mockRejectedValue(new TypeError('network'));
  vi.stubGlobal('fetch', fetcher);
  render(<ClassCreationForm operationId="50000000-0000-4000-8000-000000000001" />);
  fireEvent.change(screen.getByLabelText('학급 이름'), { target: { value: '새 학급' } });
  const button = screen.getByRole('button', { name: '준비 중 학급 만들기' });
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('목록'));
  fireEvent.click(button);
  expect(fetcher).toHaveBeenCalledOnce();
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('link', { name: '내 학급 확인' }).getAttribute('href')).toBe('/classes');
});
