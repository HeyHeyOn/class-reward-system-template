'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PET_COLORS, PET_MAX_COMPANIONS, PET_SPECIES, PET_SPECIES_NAMES, petColorName } from '@/domain/pet';
import type { PetDexEntryDto, PetStudentViewDto } from '@/lib/petApi';
import { isSessionRequired } from '../bank/bankClient';
import { Button, Callout, Spinner } from '../ui';
import { fetchPetDex } from './petBankClient';
import { PetPicture } from './PetPicture';

/** Loaded only while the dex dialog is open; current-room refreshes never download its history. */
export function PetDex({ view, busy, onCompany, onSessionExpired }: Readonly<{
  view: PetStudentViewDto; busy: boolean; onCompany: (petIds: string[]) => void; onSessionExpired: () => void;
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
  const got = new Map(collection.map((entry) => [`${entry.species}:${entry.color}`, entry]));
  const total = Object.values(PET_COLORS).reduce((sum, colors) => sum + colors.length, 0);
  const company = view.companions.map((entry) => entry.petId);
  const full = company.length >= PET_MAX_COMPANIONS;
  // An older companion might not be on the loaded page: keep its remove button reachable.
  const shown = [...new Map([...view.companions.map((pet) => ({ petId: pet.petId, name: pet.name,
    species: pet.species, color: pet.color ?? '', accessory: pet.accessory })), ...entries].map((entry) => [entry.petId, entry])).values()];
  return (
    <div className="space-y-5">
      {error ? <Callout tone="danger"><p>{error}</p><Button size="sm" variant="secondary" onClick={() => void load(nextCursor)}>다시 불러오기</Button></Callout> : null}
      {loading ? <p role="status" className="flex items-center gap-2"><Spinner size={16} />도감을 불러오는 중이에요.</p> : null}
      {shown.length > 0 ? (
        <section aria-labelledby="pet-dex-company" className="space-y-2">
          <h3 id="pet-dex-company" className="text-[15px] font-black">졸업한 펫 <span className="text-[13px] font-bold text-[var(--theme-muted-text)]">· 방에 {company.length}/{PET_MAX_COMPANIONS}마리</span></h3>
          {!view.pet ? <p className="text-[12.5px] font-semibold text-[var(--theme-muted-text)]">새 알을 고르면 졸업한 펫을 방으로 부를 수 있어요.</p> : null}
          <ul className="grid gap-2 sm:grid-cols-2">
            {shown.map((entry) => {
              const here = company.includes(entry.petId);
              return <li key={entry.petId} className="flex items-center gap-3 rounded-[14px] border border-[var(--crs-line)] p-2">
                <span className="shrink-0 rounded-[10px] bg-[var(--theme-accent-soft)]"><PetPicture species={entry.species} stage={3} color={entry.color} accessory={entry.accessory} size={48} crop={[2, 4, 20, 20]} /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-bold">{entry.name}</span>
                  <span className="block truncate text-[12px] font-semibold text-[var(--theme-muted-text)]">{petColorName(entry.species, entry.color)} {PET_SPECIES_NAMES[entry.species]}</span></span>
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
        <p className="mt-0.5 text-[12.5px] font-semibold text-[var(--theme-muted-text)]">아직 키우지 못한 종·색은 그림자로 보여요.</p>
        <ul className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-7">
          {PET_SPECIES.flatMap((species) => PET_COLORS[species].map((color) => {
            const entry = got.get(`${species}:${color.id}`);
            return <li key={`${species}:${color.id}`} className="flex flex-col items-center gap-0.5 rounded-[12px] bg-[var(--theme-accent-soft)] p-1.5 text-center">
              <PetPicture species={species} stage={3} color={color.id} accessory={entry?.accessory ?? null} size={64} silhouette={!entry}
                label={entry ? `${entry.name}, ${color.name} ${PET_SPECIES_NAMES[species]}` : '아직 키우지 않은 펫'} />
              <span className="w-full truncate text-[11.5px] font-bold">{entry ? entry.name : '???'}</span>
              {entry ? <span className="w-full truncate text-[10.5px] font-semibold text-[var(--theme-muted-text)]">{color.name} {PET_SPECIES_NAMES[species]}</span> : null}
            </li>;
          }))}
        </ul>
      </section> : null}
    </div>
  );
}
