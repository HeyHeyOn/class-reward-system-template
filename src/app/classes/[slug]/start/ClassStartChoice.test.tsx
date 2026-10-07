import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClassStartChoice } from './ClassStartChoice';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const props = { slug: 'class-example', operationId: '50000000-0000-4000-8000-000000000001' };

it('offers an empty start by default and the CRS workbook import as the second option', () => {
  render(<ClassStartChoice {...props} />);
  const options = screen.getAllByRole('radio');
  expect(options.map(option => [option.textContent, option.getAttribute('aria-checked')])).toEqual([
    ['새로 시작하기학생·상품·과제를 직접 등록해요.', 'true'],
    ['기존 CRS 시트 파일(.xlsx)로 시작하기예전 구글 시트를 .xlsx로 저장해 올리면 학생·잔액·상품·과제를 옮겨요.', 'false'],
  ]);
  expect(screen.getByRole('button', { name: '학급 사용 시작' })).toBeDefined();
  expect(screen.queryByLabelText('CRS 시트 파일(.xlsx) 선택')).toBeNull();
});

it('switches to the workbook upload without touching the empty start request', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<ClassStartChoice {...props} />);
  fireEvent.click(screen.getByRole('radio', { name: /기존 CRS 시트 파일/ }));
  expect(screen.getByRole('radio', { name: /기존 CRS 시트 파일/ }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByLabelText('CRS 시트 파일(.xlsx) 선택')).toBeDefined();
  expect(screen.queryByRole('button', { name: '학급 사용 시작' })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
