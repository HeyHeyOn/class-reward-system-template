'use client';

import { useEffect, useRef } from 'react';
import { PET_SPECIES_NAMES, petColorName, petStageSpan, type PetSpecies, type PetStage } from '@/domain/pet';
import { withParticle } from '@/lib/koreanParticle';
import type { PetDto } from '@/lib/petApi';
import PETS, { type PetGrid } from '@/lib/pet/petSprites';
import { Button, Modal } from '../ui';

const STAGE_WORDS = ['', '아기', '어린', '다 자란'] as const;

export function petStageTitle(species: PetSpecies, stage: PetStage): string {
  return stage === 0 ? `${PET_SPECIES_NAMES[species]} 알` : `${STAGE_WORDS[stage]} ${PET_SPECIES_NAMES[species]}`;
}

function paint(canvas: HTMLCanvasElement, grid: PetGrid): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, PETS.W, PETS.H);
  for (let y = 0; y < PETS.H; y++) {
    for (let x = 0; x < PETS.W; x++) {
      const cell = grid[y][x];
      if (!cell) continue;
      context.fillStyle = cell;
      context.fillRect(x, y, 1, 1);
    }
  }
}

/**
 * A pet's big moment, played once: the egg cracking open ('hatch') or the flash of growing into the
 * next stage ('grow'), then the new look idling happily. Reduced motion shows the new look still.
 */
export function PetMomentPicture({ pet, from, kind, size = 176 }: Readonly<{
  pet: Pick<PetDto, 'species' | 'color' | 'stage' | 'accessory'>; from: PetStage; kind: 'hatch' | 'grow' | 'still'; size?: number;
}>) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { species, color, stage, accessory } = pet;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const acc = accessory ?? null;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const idle = (f: number) => PETS.scene(species, stage, color, 'idle', f, { acc });
    if (reduce) { paint(canvas, PETS.draw(species, stage, color, { acc, happy: stage > 0 })); return; }
    const length = kind === 'hatch' ? PETS.ACTIONS.hatch : kind === 'grow' ? PETS.ACTIONS.grow : 0;
    let frame = 0;
    const show = () => {
      const grid = frame < length
        ? (kind === 'hatch' ? PETS.scene(species, 0, color, 'hatch', frame, { acc }) : PETS.scene(species, from, color, 'grow', frame, { to: stage, acc }))
        : idle(frame);
      paint(canvas, grid);
      frame += 1;
    };
    show();
    const timer = window.setInterval(show, 1000 / 12);
    return () => window.clearInterval(timer);
  }, [accessory, color, from, kind, species, stage]);
  return (
    <canvas ref={ref} width={PETS.W} height={PETS.H} aria-hidden="true"
      style={{ width: size, maxWidth: '100%', height: 'auto', aspectRatio: '1 / 1', imageRendering: 'pixelated' }} />
  );
}

export type PetCelebrationMoment =
  | Readonly<{ kind: 'hatch' | 'grow'; pet: PetDto; from: PetStage }>
  | Readonly<{ kind: 'graduate'; pet: Pick<PetDto, 'species' | 'color' | 'stage' | 'accessory' | 'name'>; prize: ReadonlyArray<string> }>;

/** The popup for a hatch, a new stage or a graduation: the pet large, and what happened in a line or two. */
export function PetCelebration({ moment, goal, onClose }: Readonly<{ moment: PetCelebrationMoment; goal: number; onClose: () => void }>) {
  const pet = moment.pet;
  let title = '', next = '';
  const lines: string[] = [];
  if (moment.kind === 'graduate') {
    title = `${withParticle(pet.name, '이/가')} 졸업했어요!`;
    if (moment.prize.length) lines.push(`${withParticle(moment.prize.join(', '), '을/를')} 받았어요.`);
    lines.push('도감에서 언제든지 불러올 수 있어요.');
  } else {
    if (moment.kind === 'hatch') {
      title = '알이 부화했어요!';
      lines.push(`${petColorName(pet.species, pet.color)} ${withParticle(PET_SPECIES_NAMES[pet.species], '이/가')} 나왔어요.`);
    } else {
      title = `${withParticle(pet.name, '이/가')} 자랐어요!`;
      lines.push(`${petStageTitle(pet.species, moment.from)} → ${petStageTitle(pet.species, pet.stage)}`);
    }
    const span = petStageSpan(moment.pet.growth, goal, pet.stage);
    next = span ? `다음 단계: ${petStageTitle(pet.species, (pet.stage + 1) as PetStage)} (${span.done}/${span.need})` : '다 자랐어요! 원할 때 졸업시킬 수 있어요.';
  }
  return (
    <Modal size="sm" title={title} onClose={onClose}
      footer={<Button variant="primary" size="lg" block data-autofocus onClick={onClose}>확인</Button>}>
      <div className="flex flex-col items-center text-center">
        <div className="rounded-[28px] bg-[var(--theme-accent-soft)] p-3">
          <PetMomentPicture pet={pet} from={moment.kind === 'graduate' ? 3 : moment.from} kind={moment.kind === 'graduate' ? 'still' : moment.kind} />
        </div>
        {moment.kind === 'hatch' ? <p className="mt-3 text-[13px] font-bold text-[var(--theme-muted-text)]">이름: {pet.name}</p> : null}
        {lines.map((line) => <p key={line} className="mt-2 text-[17px] font-black tracking-[-0.02em]">{line}</p>)}
        {next ? <p className="mt-2 text-[14px] font-bold text-[var(--theme-accent-text)]">{next}</p> : null}
      </div>
    </Modal>
  );
}

/** "정말 졸업시키겠어요?" — what graduating means, one short point at a time. */
export function GraduateConfirm({ pet, prize, busy, onConfirm, onClose }: Readonly<{
  pet: PetDto; prize: ReadonlyArray<string>; busy: boolean; onConfirm: () => void; onClose: () => void;
}>) {
  return (
    <Modal size="sm" title="정말 졸업시키겠어요?" onClose={onClose} busy={busy}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>아직 더 키울래요</Button>
        <Button variant="primary" icon="gift" onClick={onConfirm} loading={busy} disabled={busy} data-autofocus>졸업시키기</Button>
      </>}>
      <div className="flex items-center gap-3">
        <span className="shrink-0 rounded-[16px] bg-[var(--theme-accent-soft)] p-1">
          <PetMomentPicture pet={pet} from={3} kind="still" size={64} />
        </span>
        <p className="min-w-0 text-[15px] font-black">{pet.name} ({petStageTitle(pet.species, pet.stage)})</p>
      </div>
      <ul className="mt-3 space-y-2 text-[14.5px] font-semibold leading-relaxed">
        {prize.length ? <li className="flex gap-2"><span aria-hidden="true">•</span><span>졸업시키면 {withParticle(prize.join(', '), '을/를')} 보상으로 받아요.</span></li> : null}
        <li className="flex gap-2"><span aria-hidden="true">•</span><span>졸업한 펫은 사라지지 않고 도감에서 언제든지 불러오거나 돌려보낼 수 있어요.</span></li>
        <li className="flex gap-2"><span aria-hidden="true">•</span><span>졸업하면 새 알을 골라 다시 키울 수 있어요.</span></li>
      </ul>
    </Modal>
  );
}
