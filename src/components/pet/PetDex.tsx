'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PET_COLORS, PET_MAX_COMPANIONS, PET_SPECIES, PET_SPECIES_NAMES, petColorName } from '@/domain/pet';
import type { PetDexEntryDto, PetStudentViewDto } from '@/lib/petApi';
import { isSessionRequired } from '../bank/bankClient';
import { Button, Callout, Icon, Spinner } from '../ui';
import { fetchPetDex } from './petBankClient';
import { dexPetLine, type DexPet } from './PetGrowth';
import { PetPicture } from './PetPicture';

const FRAME = [2, 4, 20, 20] as const;
const graduate = (entry: Pick<PetDexEntryDto, 'petId' | 'species' | 'color' | 'name' | 'accessory'> & { graduatedAt?: string }): DexPet => ({
  petId: entry.petId, species: entry.species, color: entry.color, name: entry.name, accessory: entry.accessory,
  stage: 3, raising: false, graduatedAt: entry.graduatedAt ?? null,
});

/**
 * Loaded only while the dex dialog is open; current-room refreshes never download its history.
 * The pet being raised is in it as it looks now, once it has hatched (an egg has no color yet).
 * Pressing a pet opens how it grew (`onOpenPet`). The collection below is a true 도감: kinds and colors only, no names.
 */
export function PetDex({ view, busy, onCompany, onSessionExpired, onOpenPet }: Readonly<{
  view: PetStudentViewDto; busy: boolean; onCompany: (petIds: string[]) => void; onSessionExpired: () => void;
  /** `kind`: opened from the collection, which shows kinds and colors, not the names the student gave. */
  onOpenPet: (pet: DexPet, opener: HTMLElement, kind?: boolean) => void;
}>) {
  const [entries, setEntries] = useState<PetDexEntryDto[]>([]);
  const [collection, setCollection] = useState<readonly PetDexEntryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const sessionExpired = useRef(onSessionExpired);
  useEffect(() => { sessionExpired.current = onSessionExpired; }, [onSessionExpired]);
  const load = useCallback(async (cursor: string | null) => {
    const request = ++epoch.current;
    setLoading(true); setError('');
    const result = await fetchPetDex(cursor);
    if (request !== epoch.current) return;
    setLoading(false);
    if (!result.ok) {
      if (isSessionRequired(result)) sessionExpired.current();
      else setError(result.error || '도감을 불러오지 못했어요. 다시 시도해 주세요.');
      return;
    }
    setEntries((old) => [...new Map([...(cursor ? old : []), ...result.data.entries].map((entry) => [entry.petId, entry])).values()]);
    setCollection(result.data.collection); setNextCursor(result.data.nextCursor); setLoaded(true);
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) void load(null); });
    return () => { active = false; epoch.current += 1; };
  }, [load]);
  const raising: DexPet | null = view.pet && view.pet.stage > 0 && view.pet.color
    ? { ...view.pet, color: view.pet.color, raising: true, graduatedAt: null } : null;
  const got = new Map<string, DexPet>(collection.map((entry) => [`${entry.species}:${entry.color}`, graduate(entry)]));
  // A kind and color no graduate has yet is filled by the pet being raised, as it looks now.
  if (raising && !got.has(`${raising.species}:${raising.color}`)) got.set(`${raising.species}:${raising.color}`, raising);
  const total = Object.values(PET_COLORS).reduce((sum, colors) => sum + colors.length, 0);
  const company = view.companions.map((entry) => entry.petId);
  const full = company.length >= PET_MAX_COMPANIONS;
  // An older companion might not be on the loaded page: keep its remove button reachable.
  const shown = [...new Map([...view.companions.map((pet) => graduate({ petId: pet.petId, name: pet.name,
    species: pet.species, color: pet.color ?? '', accessory: pet.accessory })), ...entries.map(graduate)].map((entry) => [entry.petId, entry])).values()];
  return (
    <div className="space-y-5">
      {error ? <Callout tone="danger"><p>{error}</p><Button size="sm" variant="secondary" onClick={() => void load(nextCursor)}>다시 불러오기</Button></Callout> : null}
      {loading ? <p role="status" className="flex items-center gap-2"><Spinner size={16} />도감을 불러오는 중이에요.</p> : null}
      {raising ? (
        <section aria-labelledby="pet-dex-raising" className="space-y-2">
          <h3 id="pet-dex-raising" className="text-[15px] font-black">키우는 펫</h3>
          <button type="button" aria-haspopup="dialog" aria-label={`${raising.name}, ${dexPetLine(raising)}, 자라 온 모습 보기`}
            onClick={(event) => onOpenPet(raising, event.currentTarget)}
            className="flex w-full items-center gap-3 rounded-[14px] border border-[var(--crs-line)] p-2 text-left transition-colors hover:bg-[var(--crs-subtle-hover)] sm:w-1/2">
            <span className="shrink-0 rounded-[10px] bg-[var(--theme-accent-soft)]"><PetPicture species={raising.species} stage={raising.stage} color={raising.color} accessory={raising.accessory} size={48} crop={FRAME} /></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-bold">{raising.name}</span>
              <span className="block truncate text-[12px] font-semibold text-[var(--theme-muted-text)]">{dexPetLine(raising)}</span></span>
            <Icon name="chevronRight" size={18} className="shrink-0 text-[var(--theme-muted-text)]" />
          </button>
        </section>
      ) : null}
      {shown.length > 0 ? (
        <section aria-labelledby="pet-dex-company" className="space-y-2">
          <h3 id="pet-dex-company" className="text-[15px] font-black">졸업한 펫 <span className="ml-1 text-[13px] font-bold text-[var(--theme-muted-text)]">방에 {company.length}/{PET_MAX_COMPANIONS}마리</span></h3>
          {!view.pet ? <p className="text-[12.5px] font-semibold text-[var(--theme-muted-text)]">새 알을 고르면 졸업한 펫을 방으로 부를 수 있어요.</p> : null}
          <ul className="grid gap-2 sm:grid-cols-2">
            {shown.map((entry) => {
              const here = company.includes(entry.petId);
              return <li key={entry.petId} className="flex items-center gap-2 rounded-[14px] border border-[var(--crs-line)] p-2">
                <button type="button" aria-haspopup="dialog" aria-label={`${entry.name}, ${dexPetLine(entry)}, 자라 온 모습 보기`}
                  onClick={(event) => onOpenPet(entry, event.currentTarget)}
                  className="-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-[11px] p-1 text-left transition-colors hover:bg-[var(--crs-subtle-hover)]">
                  <span className="shrink-0 rounded-[10px] bg-[var(--theme-accent-soft)]"><PetPicture species={entry.species} stage={3} color={entry.color} accessory={entry.accessory} size={48} crop={FRAME} /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-bold">{entry.name}</span>
                    <span className="block truncate text-[12px] font-semibold text-[var(--theme-muted-text)]">{petColorName(entry.species, entry.color)} {PET_SPECIES_NAMES[entry.species]}</span></span>
                </button>
                <Button size="sm" variant={here ? 'secondary' : 'primary'} disabled={busy || !view.awake || !view.pet || (!here && full)}
                  onClick={() => onCompany(here ? company.filter((id) => id !== entry.petId) : [...company, entry.petId])}>{here ? '돌려보내기' : '방에 부르기'}</Button>
              </li>;
            })}
          </ul>
          {full && view.pet ? <p className="text-[12.5px] font-semibold text-[var(--theme-muted-text)]">키우는 펫까지 세 마리가 함께 지내요. 다른 펫을 부르려면 먼저 한 마리를 돌려보내 주세요.</p> : null}
        </section>
      ) : loaded ? <p>아직 졸업한 펫이 없어요.</p> : null}
      {nextCursor ? <Button variant="secondary" disabled={loading} onClick={() => void load(nextCursor)}>졸업한 펫 더 보기</Button> : null}
      {loaded ? <section aria-labelledby="pet-dex-all">
        <h3 id="pet-dex-all" className="text-[15px] font-black">모은 펫 <span className="text-[13px] font-bold tabular-nums text-[var(--theme-muted-text)]">{got.size}/{total}</span></h3>
        <p className="mt-0.5 text-[12.5px] font-semibold text-[var(--theme-muted-text)]">아직 키우지 못한 종과 색은 그림자로 보여요. 펫을 누르면 자라 온 모습을 볼 수 있어요.</p>
        <ul className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-7">
          {PET_SPECIES.flatMap((species) => PET_COLORS[species].map((color) => {
            const entry = got.get(`${species}:${color.id}`);
            const key = `${species}:${color.id}`;
            if (!entry) {
              return <li key={key} className="flex flex-col items-center gap-0.5 rounded-[12px] bg-[var(--theme-accent-soft)] p-1.5 text-center">
                <PetPicture species={species} stage={3} color={color.id} size={64} silhouette label="아직 키우지 않은 펫" />
                <span className="w-full truncate text-[11.5px] font-bold">???</span>
              </li>;
            }
            const kind = `${color.name} ${PET_SPECIES_NAMES[species]}`;
            return <li key={key}>
              <button type="button" aria-haspopup="dialog" aria-label={`${kind}${entry.raising ? ', 키우는 중' : ''}, 자라 온 모습 보기`}
                onClick={(event) => onOpenPet(entry, event.currentTarget, true)}
                className="flex h-full w-full flex-col items-center gap-0.5 rounded-[12px] bg-[var(--theme-accent-soft)] p-1.5 text-center transition-[filter] hover:brightness-[0.96]">
                <PetPicture species={species} stage={entry.stage} color={color.id} size={64} label={kind} />
                <span className="w-full truncate text-[11.5px] font-bold">{kind}</span>
                {entry.raising ? <span className="w-full truncate text-[10.5px] font-bold text-[var(--theme-accent-text)]">키우는 중</span> : null}
              </button>
            </li>;
          }))}
        </ul>
      </section> : null}
    </div>
  );
}
