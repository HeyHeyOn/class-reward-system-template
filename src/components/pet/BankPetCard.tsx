'use client';

import dynamic from 'next/dynamic';
import type { PetStudentViewDto } from '@/lib/petApi';
import { Icon } from '../ui';
import { nextStageTitle, petTitle, StageBar } from './petProgress';

const PetPicture = dynamic(() => import('./PetPicture').then((module) => module.PetPicture), {
  loading: () => <span className="block h-20 w-20" aria-hidden="true" />,
});
const EGG_CROP = [6, 11, 12, 12] as const;

/** The pet on the bank home: a small picture, its stage with the stage's points, and the way to the next stage. Opens the pet screen. */
export function BankPetCard({ view, onOpen }: Readonly<{ view: PetStudentViewDto; onOpen: () => void }>) {
  if (!view.enabled) return null;
  const pet = view.pet;
  const next = pet ? nextStageTitle(pet, view.goal) : null;
  return (
    <button type="button" onClick={onOpen}
      aria-label={pet ? `${pet.name}, ${petTitle(pet)}${next?.points ? ` ${next.points}` : ''}${next?.title ? `, 다음 단계 ${next.title}` : ', 다 자랐어요'}` : '펫 키우기, 알을 골라 시작해요'}
      className="mt-4 flex w-full items-center gap-4 rounded-[22px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-4 text-left shadow-[var(--crs-shadow-sm)] transition-[transform,background-color] duration-150 hover:bg-[var(--crs-subtle-hover)] active:scale-[0.99]">
      <span aria-hidden="true" className="shrink-0 rounded-2xl bg-[var(--theme-accent-soft)] p-1">
        {pet ? <PetPicture species={pet.species} stage={pet.stage} color={pet.color} accessory={pet.accessory} size={80} animate={view.awake} />
          : <PetPicture species="dog" stage={0} color={null} size={80} crop={EGG_CROP} silhouette />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[18px] font-black tracking-[-0.02em]">{pet ? pet.name : '펫 키우기'}</span>
        {pet && next ? (
          <>
            <span className="mt-0.5 flex items-baseline justify-between gap-2 text-[13px] font-semibold text-[var(--theme-muted-text)]">
              <span className="min-w-0 truncate">{petTitle(pet)}</span>
              {next.points ? <span className="shrink-0 font-bold tabular-nums text-[var(--theme-text)]">{next.points}</span> : null}
            </span>
            <span className="mt-1.5 block">
              <StageBar fraction={next.fraction} label={next.title ? `${next.title}까지` : '다 자람'} />
              <span className="mt-1 block text-[12px] font-bold text-[var(--theme-accent-text)]">{next.title ? `다음 단계: ${next.title}` : '다 자랐어요! 졸업할 수 있어요'}</span>
            </span>
          </>
        ) : <span className="mt-0.5 block text-[13px] font-semibold text-[var(--theme-muted-text)]">알을 골라 나만의 펫을 키워 보세요</span>}
      </span>
      <Icon name="chevronRight" size={20} className="shrink-0 text-[var(--theme-muted-text)]" />
    </button>
  );
}

