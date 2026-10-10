import type { ClassTreeSettings } from '@/domain/classTree';
import type {
  ClassTreeAdminBoardDto,
  ClassTreeHarvestResultDto,
  ClassTreeClassFeedResultDto,
} from '@/lib/classTreeApi';
import { tenantFetch } from '@/lib/tenantApiPath';

/* Calls for the teacher's class tree screen. Commands carry an operation ID, so a resend after a lost answer is safe. */

export type TreeResult<T> = { ok: true; data: T } | { ok: false; error: string; code: string | null; status: number };

const NETWORK = '연결이 잠시 불안정해요. 인터넷 연결을 확인하고 다시 눌러 주세요.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isBoard(value: unknown): value is ClassTreeAdminBoardDto {
  return isRecord(value) && isRecord(value.settings) && typeof value.activeStudents === 'number'
    && (value.tree === null || isRecord(value.tree)) && Array.isArray(value.contributions) && Array.isArray(value.harvests);
}

async function request<T>(path: string, init: RequestInit, read: (value: unknown) => T | null): Promise<TreeResult<T>> {
  let response: Response;
  try {
    response = await tenantFetch(path, { cache: 'no-store', credentials: 'same-origin', ...init });
  } catch {
    return { ok: false, error: NETWORK, code: null, status: 0 };
  }
  let payload: unknown = null;
  try { payload = JSON.parse(await response.text()); } catch { payload = null; }
  if (response.ok) {
    const data = read(payload);
    return data === null ? { ok: false, error: NETWORK, code: null, status: 0 } : { ok: true, data };
  }
  const record = isRecord(payload) ? payload : {};
  return {
    ok: false, status: response.status,
    error: typeof record.error === 'string' ? record.error : '처리하지 못했어요. 잠시 후 다시 눌러 주세요.',
    code: typeof record.code === 'string' ? record.code : null,
  };
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function fetchClassTreeBoard(): Promise<TreeResult<ClassTreeAdminBoardDto>> {
  return request('/api/class-tree', { method: 'GET' }, (value) => (isBoard(value) ? value : null));
}

export function saveClassTreeSettings(settings: ClassTreeSettings): Promise<TreeResult<ClassTreeAdminBoardDto>> {
  return request('/api/class-tree/settings', post({ settings }), (value) => (isBoard(value) ? value : null));
}

export function giveClassFeed(input: { operationId: string; amount: number; note: string }): Promise<TreeResult<{ result: ClassTreeClassFeedResultDto; board: ClassTreeAdminBoardDto }>> {
  return request('/api/class-tree/feed', post(input), (value) => (isRecord(value) && isRecord(value.result) && isBoard(value.board)
    ? { result: value.result as ClassTreeClassFeedResultDto, board: value.board } : null));
}

export function harvestTree(input: { operationId: string; treeNo: number }): Promise<TreeResult<{ result: ClassTreeHarvestResultDto; board: ClassTreeAdminBoardDto }>> {
  return request('/api/class-tree/harvest', post(input), (value) => (isRecord(value) && isRecord(value.result) && isBoard(value.board)
    ? { result: value.result as ClassTreeHarvestResultDto, board: value.board } : null));
}
