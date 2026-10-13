'use client';

import { Fragment } from 'react';
import { PET_SPECIES_NAMES, petColorName, type PetSpecies, type PetStage } from '@/domain/pet';
import { formatSeoulDay } from '../bank/format';
import { Button, Icon, Modal, cx } from '../ui';
import { PetPicture } from './PetPicture';
import { petTitle } from './petProgress';

/** A pet in the 도감: the one being raised (from the moment it hatched) or a graduated one. */
export type DexPet = Readonly<{
  petId: string;
  species: PetSpecies;
  color: string;
  name: string;
  accessory: string | null;
  stage: PetStage;
  raising: boolean;
  /** When it graduated, when known. */
  graduatedAt: string | null;
}>;

const STAGES: readonly PetStage[] = [0, 1, 2, 3];
/** One frame for every stage, so the pictures grow from the egg to the grown-up. */
const FRAME = [2, 4, 20, 20] as const;

/** What the 도감 says under a pet's name: its color and kind, and whether it is still growing. */
export function dexPetLine(pet: DexPet): string {
  const kind = `${petColorName(pet.species, pet.color)} ${pet.raising ? petTitle(pet) : PET_SPECIES_NAMES[pet.species]}`;
  if (pet.raising) return `${kind}, 키우는 중`;
  return pet.graduatedAt ? `${kind}, ${formatSeoulDay(pet.graduatedAt)} 졸업` : `${kind}, 졸업`;
}

/**
 * The popup from the 도감: every stage reached so far, in order with arrows; stages still ahead are question marks.
 * For one pet (from the lists, with its name and accessory) or for a kind and color (from the collection, without them).
 */
export function PetGrowth({ pet, kind = false, opener, onClose }: Readonly<{
  pet: DexPet; kind?: boolean; opener: HTMLElement | null; onClose: () => void;
}>) {
  const kindName = `${petColorName(pet.species, pet.color)} ${PET_SPECIES_NAMES[pet.species]}`;
  const accessory = kind ? null : pet.accessory;
  let description = dexPetLine(pet);
  if (kind) description = pet.raising ? '지금 키우고 있는 펫이에요.' : '다 키워서 모은 펫이에요.';
  return (
    <Modal title={kind ? kindName : pet.name} description={description} size="md" opener={opener} onClose={onClose}
      footer={<Button variant="ghost" onClick={onClose}>닫기</Button>}>
      <h3 className="text-[14px] font-black">자라 온 모습</h3>
      <ol aria-label="자라 온 모습" className="mt-2 grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-start gap-x-1">
        {STAGES.map((stage) => {
          const seen = stage <= pet.stage;
          const now = pet.raising && stage === pet.stage;
          const title = petTitle({ species: pet.species, stage });
          return (
            <Fragment key={stage}>
              {stage > 0 ? (
                <li aria-hidden="true" className="flex h-[min(18vw,76px)] items-center">
                  <Icon name="chevronRight" size={16} className={seen ? 'text-[var(--theme-accent-text)]' : 'text-[var(--theme-muted-text)] opacity-50'} />
                </li>
              ) : null}
              <li aria-label={seen ? `${stage + 1}단계 ${title}${now ? ', 지금 모습' : ''}` : `${stage + 1}단계 아직 몰라요`}
                className="flex min-w-0 flex-col items-center gap-1 text-center">
                {seen ? (
                  <span className={cx('flex aspect-square w-full max-w-[76px] items-center justify-center rounded-[14px] bg-[var(--theme-accent-soft)]',
                    now && 'ring-2 ring-[var(--theme-accent-solid)]')}>
                    <PetPicture species={pet.species} stage={stage} color={stage === 0 ? null : pet.color}
                      accessory={stage === pet.stage ? accessory : null} size={72} crop={FRAME} />
                  </span>
                ) : (
                  <span className="flex aspect-square w-full max-w-[76px] items-center justify-center rounded-[14px] border-2 border-dashed border-[var(--crs-line)] text-[22px] font-black text-[var(--theme-muted-text)]">?</span>
                )}
                <span className={cx('text-[12px] font-bold leading-tight [word-break:keep-all]', !seen && 'text-[var(--theme-muted-text)]')}>
                  {seen ? title : '???'}
                </span>
                {now ? <span className="rounded-full bg-[var(--theme-accent-solid)] px-1.5 text-[10.5px] font-black text-[var(--theme-accent-on-solid)]">지금</span> : null}
              </li>
            </Fragment>
          );
        })}
      </ol>
      <p className="mt-3 text-[12.5px] font-semibold text-[var(--theme-muted-text)]">
        {pet.raising ? '더 자라면 새 모습이 여기에 차례로 남아요.' : '알부터 다 자랄 때까지 모든 모습을 지켜봤어요.'}
      </p>
    </Modal>
  );
}
