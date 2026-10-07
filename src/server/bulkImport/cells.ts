import 'server-only';

import type { RawCell } from './sheetReader';

export type Coerced<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; message: string }>;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const TRUE_WORDS = new Set(['예', '네', 'ㅇ', 'o', '○', '◯', 'y', 'yes', 'true', '참', '판매', '판매중', '사용', '1']);
const FALSE_WORDS = new Set(['아니오', '아니요', '아니', 'ㄴ', 'x', '×', '✕', 'n', 'no', 'false', '거짓', '숨김', '중지',
  '판매중지', '미판매', '안함', '사용안함', '0']);

function ok<T>(value: T): Coerced<T> {
  return { ok: true, value };
}

function fail<T>(message: string): Coerced<T> {
  return { ok: false, message };
}

function cellProblem<T>(cell: RawCell): Coerced<T> | null {
  if (cell.kind === 'date') {
    return fail("날짜로 바뀌어 있어요. 셀 서식을 '텍스트'로 바꾼 뒤 다시 적어 주세요.");
  }
  if (cell.kind === 'error') {
    return fail(cell.code === 'FORMULA'
      ? '수식 결과를 읽지 못했어요. 값만 붙여 넣어 주세요.'
      : `수식 오류(${cell.code})가 있어요. 값을 직접 적어 주세요.`);
  }
  return null;
}

/** Text cell: trims, folds runs of whitespace/new lines into one space. Empty → null. */
export function readText(cell: RawCell, maxLength: number): Coerced<string | null> {
  if (cell.kind === 'empty') return ok(null);
  const problem = cellProblem<string | null>(cell);
  if (problem) return problem;
  if (cell.kind === 'boolean') return fail('참/거짓(TRUE/FALSE) 대신 글자를 적어 주세요.');
  const raw = cell.kind === 'number' ? cell.display ?? String(cell.value) : cell.kind === 'text' ? cell.text : '';
  const text = raw.normalize('NFC').replace(/[\s 　]+/g, ' ').trim();
  if (!text) return ok(null);
  if (CONTROL_CHARACTERS.test(text)) return fail('보이지 않는 특수 문자가 들어 있어요. 글자를 다시 적어 주세요.');
  if (Array.from(text).length > maxLength) return fail(`${maxLength}자 이하로 적어 주세요.`);
  return ok(text);
}

/**
 * Whole number cell. Accepts numbers stored as text, thousands separators and a short unit
 * suffix ("1,000원", " 5 개"). Empty → null.
 */
export function readInteger(cell: RawCell, options: { min?: number } = {}): Coerced<number | null> {
  if (cell.kind === 'empty') return ok(null);
  const problem = cellProblem<number | null>(cell);
  if (problem) return problem;
  let value: number;
  if (cell.kind === 'number') {
    if (!Number.isInteger(cell.value)) return fail('소수점 없이 정수로 적어 주세요.');
    value = cell.value;
  } else if (cell.kind === 'text') {
    const compact = cell.text.normalize('NFKC').replace(/[\s,]/g, '').replace(/(\d)[가-힣a-zA-Z]{1,4}$/, '$1');
    if (!compact) return ok(null);
    if (/^[+-]?\d+\.\d*$/.test(compact) && !/^[+-]?\d+\.0*$/.test(compact)) {
      return fail('소수점 없이 정수로 적어 주세요.');
    }
    const digits = compact.replace(/\.0*$/, '');
    if (!/^[+-]?\d+$/.test(digits)) return fail('숫자로 적어 주세요.');
    value = Number(digits);
  } else {
    return fail('숫자로 적어 주세요.');
  }
  if (!Number.isSafeInteger(value)) return fail('숫자가 너무 커요.');
  if (Object.is(value, -0)) value = 0;
  if (options.min !== undefined && value < options.min) return fail(`${options.min} 이상의 숫자로 적어 주세요.`);
  return ok(value);
}

/** 예/아니오 cell (also O/X, TRUE/FALSE, 1/0 …). Empty → null. */
export function readYesNo(cell: RawCell): Coerced<boolean | null> {
  if (cell.kind === 'empty') return ok(null);
  const problem = cellProblem<boolean | null>(cell);
  if (problem) return problem;
  if (cell.kind === 'boolean') return ok(cell.value);
  if (cell.kind === 'number') {
    if (cell.value === 1) return ok(true);
    if (cell.value === 0) return ok(false);
    return fail("'예' 또는 '아니오'로 적어 주세요.");
  }
  if (cell.kind !== 'text') return fail("'예' 또는 '아니오'로 적어 주세요.");
  const word = cell.text.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  if (TRUE_WORDS.has(word)) return ok(true);
  if (FALSE_WORDS.has(word)) return ok(false);
  return fail("'예' 또는 '아니오'로 적어 주세요.");
}

/** Validates already-normalized text values (used again when a commit is re-validated). */
export function checkPlainText(value: string, maxLength: number): string | null {
  if (value !== value.trim() || !value) return '내용을 적어 주세요.';
  if (CONTROL_CHARACTERS.test(value)) return '보이지 않는 특수 문자가 들어 있어요. 글자를 다시 적어 주세요.';
  if (Array.from(value).length > maxLength) return `${maxLength}자 이하로 적어 주세요.`;
  return null;
}
