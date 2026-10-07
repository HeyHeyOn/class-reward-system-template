import 'server-only';

import {
  BULK_IMPORT_MAX_COMMIT_BYTES,
  BULK_IMPORT_MAX_FILE_BYTES,
  XLSX_CONTENT_TYPE,
  type BulkImportErrorCode,
  type BulkImportFailure,
  type BulkImportIssue,
} from '@/lib/bulkImport';
import { BulkImportCommitError, BulkImportFileError, BulkImportUnsupportedError, sqlStateOf } from './errors';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function bulkImportJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function bulkImportFailure(
  status: number,
  code: BulkImportErrorCode,
  error: string,
  errors?: ReadonlyArray<BulkImportIssue>,
): Response {
  const body: BulkImportFailure = { ok: false, code, error, ...(errors ? { errors } : {}) };
  return bulkImportJson(body, status);
}

export function adminRequiredResponse(): Response {
  return bulkImportFailure(401, 'ADMIN_REQUIRED', '관리자 로그인이 필요해요. 다시 로그인해 주세요.');
}

function mediaType(request: Request): string {
  return request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
}

/** Reads at most `maxBytes` of the body; never trusts Content-Length to grow the budget. */
async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array | 'too-large'> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return 'too-large';
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return 'too-large';
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The raw .xlsx upload of a preview request, or the refusal to send back. */
export async function readXlsxUpload(request: Request): Promise<Uint8Array | Response> {
  if (new URL(request.url).search) {
    return bulkImportFailure(400, 'INVALID_REQUEST', '파일을 다시 올려 주세요.');
  }
  if (mediaType(request) !== XLSX_CONTENT_TYPE) {
    return bulkImportFailure(415, 'INVALID_FILE', '엑셀(.xlsx) 파일만 올릴 수 있어요.');
  }
  let bytes: Uint8Array | 'too-large';
  try {
    bytes = await readBoundedBody(request, BULK_IMPORT_MAX_FILE_BYTES);
  } catch {
    return bulkImportFailure(400, 'INVALID_REQUEST', '파일을 받지 못했어요. 다시 올려 주세요.');
  }
  if (bytes === 'too-large') {
    return bulkImportFailure(413, 'FILE_TOO_LARGE', '파일이 너무 커요. 2MB 이하의 엑셀 파일을 올려 주세요.');
  }
  if (bytes.byteLength === 0) {
    return bulkImportFailure(400, 'INVALID_FILE', '빈 파일이에요. 내용을 적은 엑셀 파일을 올려 주세요.');
  }
  return bytes;
}

/** The JSON body of a commit request, or the refusal to send back. */
export async function readCommitJson(request: Request): Promise<{ value: unknown } | Response> {
  const invalid = () => bulkImportFailure(400, 'INVALID_REQUEST', '추가 요청을 확인하지 못했어요. 파일을 다시 올려 주세요.');
  if (new URL(request.url).search || mediaType(request) !== 'application/json') return invalid();
  try {
    const bytes = await readBoundedBody(request, BULK_IMPORT_MAX_COMMIT_BYTES);
    if (bytes === 'too-large') return invalid();
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return invalid();
  }
}

export function previewErrorResponse(error: unknown, logLabel: string): Response {
  if (error instanceof BulkImportFileError) {
    return bulkImportFailure(error.code === 'FILE_TOO_LARGE' ? 413 : 422, error.code, error.message);
  }
  if (error instanceof BulkImportUnsupportedError) return bulkImportFailure(501, 'UNSUPPORTED', error.message);
  logUnexpected(logLabel, error);
  return bulkImportFailure(500, 'INTERNAL', '파일을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.');
}

export function commitErrorResponse(error: unknown, logLabel: string): Response {
  if (error instanceof BulkImportCommitError) {
    return bulkImportFailure(409, error.code, error.message, error.code === 'VALIDATION_FAILED' ? error.issues : undefined);
  }
  if (error instanceof BulkImportUnsupportedError) return bulkImportFailure(501, 'UNSUPPORTED', error.message);
  if (sqlStateOf(error) === '23505') {
    // A concurrent addition took a number this import wanted. The transaction rolled back.
    return bulkImportFailure(409, 'VALIDATION_FAILED',
      '그사이 다른 곳에서 같은 번호가 추가됐어요. 아무것도 추가하지 않았어요. 파일을 다시 올려 확인해 주세요.', []);
  }
  logUnexpected(logLabel, error);
  return bulkImportFailure(500, 'OUTCOME_UNCERTAIN',
    "추가 결과를 확인하지 못했어요. '다시 시도'를 누르면 같은 요청으로 다시 확인해요. 두 번 추가되지는 않아요.");
}

/** Attachment response with an RFC 5987 UTF-8 filename and an ASCII fallback. */
export function xlsxDownloadResponse(bytes: Uint8Array, fileName: string, asciiFileName: string): Response {
  const encoded = encodeURIComponent(fileName)
    .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encoded}`,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function logUnexpected(label: string, error: unknown): void {
  // Internal guard messages carry no student data. Database driver errors echo query
  // parameters (names, IDs), so only their SQLSTATE is logged; never log request bodies.
  const detail = !(error instanceof Error) ? 'non-error throw'
    : /^Failed query/i.test(error.message) ? `database error ${sqlStateOf(error) ?? 'unknown'}`
      : `${error.name}: ${error.message.slice(0, 200)}`;
  console.error(`[${label}] unexpected failure`, detail);
}
