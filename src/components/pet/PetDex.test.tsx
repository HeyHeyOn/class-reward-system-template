import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_PET_DECOR } from '@/domain/pet';
import type { PetDexEntryDto, PetStudentViewDto } from '@/lib/petApi';
import { PetDex } from './PetDex';
import { fetchPetDex } from './petBankClient';

vi.mock('./petBankClient', () => ({ fetchPetDex: vi.fn() }));
vi.mock('./PetPicture', () => ({ PetPicture: ({ label }: { label?: string }) => <span aria-label={label} /> }));
const view: PetStudentViewDto = { enabled: true, goal: 40, stageStarts: { hatch: 4, young: 18, adult: 40 }, careGrowth: 1, taskGrowth: 1,
  feedPrice: 10, feedDailyLimit: 2, hoursEnabled: false, hours: [], awake: true, nextOpen: null,
  pet: { petId: 'current', species: 'dog', color: null, name: '현재', stage: 0, growth: 0, adoptedAt: '2026-10-11T00:00:00Z', accessory: null },
  companions: [{ petId: 'older-companion', species: 'cat', color: 'black', name: '옛 친구', stage: 3, growth: 40, adoptedAt: '2026-01-01T00:00:00Z', accessory: null }],
  warmedToday: false, feedsToday: 0, lastFedAt: null, rewardAmount: 100, rewardItem: '', room: DEFAULT_PET_DECOR,
  owned: [], shopEnabled: true, shop: [], dex: [] };
const entry = (id: string, name: string): PetDexEntryDto => ({ petId: id, species: 'dog', color: 'brown', name,
  graduatedAt: '2026-10-10T00:00:00Z', accessory: null });
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it('loads pages on demand, keeps the complete collection and lets an older companion leave', async () => {
  const one = entry('one', '첫 페이지'), two = entry('two', '다음 페이지');
  vi.mocked(fetchPetDex).mockResolvedValueOnce({ ok: true, data: { entries: [one], collection: [two], nextCursor: 'cursor-1' } });
  const onCompany = vi.fn();
  render(<PetDex view={view} busy={false} onCompany={onCompany} onSessionExpired={vi.fn()} />);
  await screen.findByText('첫 페이지');
  expect(fetchPetDex).toHaveBeenCalledExactlyOnceWith(null);
  expect(screen.getByLabelText('다음 페이지, 갈색 강아지')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: '돌려보내기' }));
  expect(onCompany).toHaveBeenCalledWith([]);
  vi.mocked(fetchPetDex).mockResolvedValueOnce({ ok: false, status: 503, error: '잠시 실패' });
  fireEvent.click(screen.getByRole('button', { name: '졸업한 펫 더 보기' }));
  await screen.findByText('잠시 실패');
  expect(screen.getByText('첫 페이지')).toBeDefined();
  vi.mocked(fetchPetDex).mockResolvedValueOnce({ ok: true, data: { entries: [two], collection: [two], nextCursor: null } });
  fireEvent.click(screen.getByRole('button', { name: '다시 불러오기' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '졸업한 펫 더 보기' })).toBeNull());
  expect(fetchPetDex).toHaveBeenNthCalledWith(2, 'cursor-1');
  expect(fetchPetDex).toHaveBeenNthCalledWith(3, 'cursor-1');
  expect(screen.getByText('첫 페이지')).toBeDefined();
});

it('ignores a response after the dex closes', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof fetchPetDex>>) => void;
  vi.mocked(fetchPetDex).mockReturnValue(new Promise((done) => { resolve = done; }));
  const expire = vi.fn();
  const mounted = render(<PetDex view={view} busy={false} onCompany={vi.fn()} onSessionExpired={expire} />);
  await waitFor(() => expect(fetchPetDex).toHaveBeenCalledOnce());
  mounted.unmount();
  await act(async () => resolve({ ok: false, status: 401, code: 'BANK_SESSION_REQUIRED', error: 'expired' }));
  expect(expire).not.toHaveBeenCalled();
});
