import type { PetSettings } from '@/domain/pet';
import type { PetAdminBoardDto } from '@/lib/petApi';
import { tenantFetch } from '@/lib/tenantApiPath';

/* Calls for the teacher's 펫 키우기 screen. */

export type PetAdminResult<T> = { ok: true; data: T } | { ok: false; error: string; code: string | null; status: number };

const NETWORK = '연결이 잠시 불안정해요. 인터넷 연결을 확인하고 다시 눌러 주세요.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isBoard(value: unknown): value is PetAdminBoardDto {
  return isRecord(value) && isRecord(value.settings) && typeof value.goal === 'number'
    && isRecord(value.stageStarts) && Array.isArray(value.rewardProducts) && Array.isArray(value.students);
}

async function request(path: string, init: RequestInit): Promise<PetAdminResult<PetAdminBoardDto>> {
  let response: Response;
  try {
    response = await tenantFetch(path, { cache: 'no-store', credentials: 'same-origin', ...init });
  } catch {
    return { ok: false, error: NETWORK, code: null, status: 0 };
  }
  let payload: unknown = null;
  try { payload = JSON.parse(await response.text()); } catch { payload = null; }
  if (response.ok) return isBoard(payload) ? { ok: true, data: payload } : { ok: false, error: NETWORK, code: null, status: 0 };
  const record = isRecord(payload) ? payload : {};
  return {
    ok: false, status: response.status,
    error: typeof record.error === 'string' ? record.error : '처리하지 못했어요. 잠시 후 다시 눌러 주세요.',
    code: typeof record.code === 'string' ? record.code : null,
  };
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function fetchPetBoard(): Promise<PetAdminResult<PetAdminBoardDto>> {
  return request('/api/pets', { method: 'GET' });
}

export function savePetSettings(settings: PetSettings): Promise<PetAdminResult<PetAdminBoardDto>> {
  return request('/api/pets/settings', post({ settings }));
}

export function renamePet(petId: string, name: string): Promise<PetAdminResult<PetAdminBoardDto>> {
  return request('/api/pets/rename', post({ petId, name }));
}

/** Adds growth to a student's pet, or takes some away (`amount` below 0). */
export function adjustPetGrowth(input: { operationId: string; petId: string; amount: number }): Promise<PetAdminResult<PetAdminBoardDto>> {
  return request('/api/pets/growth', post(input));
}
