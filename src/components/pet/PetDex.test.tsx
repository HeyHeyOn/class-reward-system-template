import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_PET_DECOR } from '@/domain/pet';
import type { PetDexEntryDto, PetStudentViewDto } from '@/lib/petApi';
import { PetDex } from './PetDex';
import { PetGrowth } from './PetGrowth';
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
  render(<PetDex view={view} busy={false} onCompany={onCompany} onSessionExpired={vi.fn()} onOpenPet={vi.fn()} />);
  await screen.findByText('첫 페이지');
  expect(fetchPetDex).toHaveBeenCalledExactlyOnceWith(null);
  // The collection is a true 도감: the kind and color, never the name the student gave.
  expect(screen.getByLabelText('갈색 강아지')).toBeDefined();
  expect(screen.queryByText('다음 페이지')).toBeNull();
  // An egg is not in the 도감 yet: its color is picked when it hatches.
  expect(screen.queryByText('키우는 펫')).toBeNull();
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
  const mounted = render(<PetDex view={view} busy={false} onCompany={vi.fn()} onSessionExpired={expire} onOpenPet={vi.fn()} />);
  await waitFor(() => expect(fetchPetDex).toHaveBeenCalledOnce());
  mounted.unmount();
  await act(async () => resolve({ ok: false, status: 401, code: 'BANK_SESSION_REQUIRED', error: 'expired' }));
  expect(expire).not.toHaveBeenCalled();
});

it('records the pet being raised as it looks now, and opens how a pet or a kind grew', async () => {
  vi.mocked(fetchPetDex).mockResolvedValueOnce({ ok: true, data: { entries: [entry('one', '보리')], collection: [entry('one', '보리')], nextCursor: null } });
  const raised: PetStudentViewDto = { ...view, companions: [],
    pet: { ...view.pet!, species: 'rabbit', color: 'white', name: '콩떡', stage: 1, growth: 5, accessory: 'ribbon' } };
  const onOpenPet = vi.fn();
  render(<PetDex view={raised} busy={false} onCompany={vi.fn()} onSessionExpired={vi.fn()} onOpenPet={onOpenPet} />);
  await screen.findByText('보리');
  expect(screen.getByText('키우는 펫')).toBeDefined();
  expect(screen.getByText('모은 펫').parentElement?.textContent).toContain('2/');
  fireEvent.click(screen.getByRole('button', { name: '콩떡, 흰색 아기 토끼, 키우는 중, 자라 온 모습 보기' }));
  expect(onOpenPet).toHaveBeenLastCalledWith(expect.objectContaining({ petId: 'current', stage: 1, raising: true }), expect.any(HTMLElement));
  fireEvent.click(screen.getByRole('button', { name: '흰색 토끼, 키우는 중, 자라 온 모습 보기' }));
  expect(onOpenPet).toHaveBeenLastCalledWith(expect.objectContaining({ petId: 'current' }), expect.any(HTMLElement), true);
  fireEvent.click(screen.getByRole('button', { name: '갈색 강아지, 자라 온 모습 보기' }));
  expect(onOpenPet).toHaveBeenLastCalledWith(expect.objectContaining({ petId: 'one', stage: 3, raising: false }), expect.any(HTMLElement), true);
});

it('shows every stage reached so far with arrows, and question marks for the ones ahead', () => {
  const pet = { petId: 'p', species: 'rabbit', color: 'white', name: '콩떡', accessory: 'ribbon', stage: 2, raising: true, graduatedAt: null } as const;
  const { unmount } = render(<PetGrowth pet={pet} opener={null} onClose={vi.fn()} />);
  expect(screen.getByRole('dialog', { name: '콩떡' })).toBeDefined();
  expect(screen.getByRole('list', { name: '자라 온 모습' }).querySelectorAll('li:not([aria-hidden])')).toHaveLength(4);
  expect(screen.getByLabelText('1단계 토끼 알')).toBeDefined();
  expect(screen.getByLabelText('3단계 어린 토끼, 지금 모습')).toBeDefined();
  expect(screen.getByLabelText('4단계 아직 몰라요')).toBeDefined();
  unmount();
  render(<PetGrowth pet={{ ...pet, stage: 3, raising: false }} kind opener={null} onClose={vi.fn()} />);
  expect(screen.getByRole('dialog', { name: '흰색 토끼' })).toBeDefined();
  expect(screen.getByLabelText('4단계 다 자란 토끼')).toBeDefined();
  expect(screen.queryByText('???')).toBeNull();
});
