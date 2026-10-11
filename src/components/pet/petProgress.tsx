import { PET_SPECIES_NAMES, petStageProgress, petStageSpan, type PetStage } from '@/domain/pet';
import type { PetDto } from '@/lib/petApi';
import { cx } from '../ui';

const STAGE_WORDS = ['', '아기', '어린', '다 자란'] as const;

export function petTitle(pet: Pick<PetDto, 'species' | 'stage'>): string {
  return pet.stage === 0 ? `${PET_SPECIES_NAMES[pet.species]} 알` : `${STAGE_WORDS[pet.stage]} ${PET_SPECIES_NAMES[pet.species]}`;
}

/** The next stage as students read it ('어린 토끼', null once grown up), how far toward it, and the stage's points ('3/40'). */
export function nextStageTitle(pet: Pick<PetDto, 'species' | 'stage' | 'growth'>, goal: number): { title: string | null; fraction: number; points: string } {
  const progress = petStageProgress(pet.growth, goal, pet.stage);
  const span = petStageSpan(pet.growth, goal, pet.stage);
  return {
    title: progress.next === null ? null : petTitle({ species: pet.species, stage: progress.next as PetStage }),
    fraction: progress.fraction, points: span ? `${span.done}/${span.need}` : '',
  };
}

/** The way to the next stage only — students never see how far the whole goal is. */
export function StageBar({ fraction, label, track = 'bg-[var(--theme-accent-soft)]' }: Readonly<{ fraction: number; label: string; track?: string }>) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
      className={cx('block h-2.5 overflow-hidden rounded-full', track)}>
      <span className="block h-full rounded-full bg-[var(--theme-accent-solid)] transition-[width] duration-300" style={{ width: `${percent}%` }} />
    </span>
  );
}

