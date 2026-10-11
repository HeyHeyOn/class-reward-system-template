'use client';

import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PET_COLORS,
  PET_DECOR_SLOTS,
  PET_MAX_COMPANIONS,
  PET_NAME_LENGTH,
  PET_SHOP_ITEMS,
  PET_SHOP_SLOTS,
  PET_SHOP_SLOT_NAMES,
  PET_SPECIES,
  PET_SPECIES_NAMES,
  cleanPetName,
  petColorName,
  petDecorKey,
  petStageProgress,
  petStageSpan,
  type PetShopSlot,
  type PetSpecies,
  type PetStage,
} from '@/domain/pet';
import { withParticle } from '@/lib/koreanParticle';
import type { PetDto, PetStudentViewDto } from '@/lib/petApi';
import PETS from '@/lib/pet/petSprites';
import ROOM, { type PetRoom, type PetRoomPetInit } from '@/lib/pet/petRoom';
import { isSessionRequired, type BankFailure } from '../bank/bankClient';
import { formatMoney } from '../bank/format';
import { NoticeToast, type Notice } from '../bank/NoticeToast';
import { Button, Callout, Icon, IconButton, Input, Modal, SegmentedControl, Spinner, cx } from '../ui';
import { GraduateConfirm, PetCelebration, type PetCelebrationMoment } from './PetMoments';
import { PetPicture } from './PetPicture';
import { DecorPreview, PetRoomCanvas } from './PetRoomCanvas';
import { adoptPet, buyPetDecor, carePet, graduatePet, placePetDecor, setPetCompanions } from './petBankClient';

const STAGE_WORDS = ['', '아기', '어린', '다 자란'] as const;
const EGG_CROP = [6, 11, 12, 12] as const;
/** How fast the room's needs move in the app (the sample page runs at 1). */
const ROOM_RATE = 0.3;
/** Weekday hours from full to hungry. */
const HUNGRY_AFTER_HOURS = 36;

function petTitle(pet: Pick<PetDto, 'species' | 'stage'>): string {
  return pet.stage === 0 ? `${PET_SPECIES_NAMES[pet.species]} 알` : `${STAGE_WORDS[pet.stage]} ${PET_SPECIES_NAMES[pet.species]}`;
}

/** The next stage as students read it ('어린 토끼', null once grown up), how far toward it, and the stage's points ('3/40'). */
function nextStageTitle(pet: Pick<PetDto, 'species' | 'stage' | 'growth'>, goal: number): { title: string | null; fraction: number; points: string } {
  const progress = petStageProgress(pet.growth, goal, pet.stage);
  const span = petStageSpan(pet.growth, goal, pet.stage);
  return {
    title: progress.next === null ? null : petTitle({ species: pet.species, stage: progress.next as PetStage }),
    fraction: progress.fraction, points: span ? `${span.done}/${span.need}` : '',
  };
}

/** Hours since `iso` that fall on weekdays (Korea time): a pet does not get hungry over a weekend. */
function weekdayHoursSince(iso: string, now: number): number {
  const step = 3_600_000;
  let hours = 0;
  for (let t = new Date(iso).getTime(), i = 0; t < now && i < 24 * 21; t += step, i++) {
    const day = new Date(t + 9 * step).getUTCDay();
    if (day !== 0 && day !== 6) hours += Math.min(1, (now - t) / step);
  }
  return hours;
}

/** The way to the next stage only — students never see how far the whole goal is. */
function StageBar({ fraction, label, track = 'bg-[var(--theme-accent-soft)]' }: Readonly<{ fraction: number; label: string; track?: string }>) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
      className={cx('block h-2.5 overflow-hidden rounded-full', track)}>
      <span className="block h-full rounded-full bg-[var(--theme-accent-solid)] transition-[width] duration-300" style={{ width: `${percent}%` }} />
    </span>
  );
}

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

type BankPetViewProps = Readonly<{
  view: PetStudentViewDto | null;
  balance: number;
  currencyUnit: string;
  loading: boolean;
  error: string;
  onBack: () => void;
  onRefresh: () => void;
  /** A command changed the pet screen (and the balance). */
  onChanged: (view: PetStudentViewDto, balance: number) => void;
  onSessionExpired: () => void;
  /** Read out to screen readers. */
  onAnnounce: (message: string) => void;
}>;

type Status = Readonly<{ moods: ReadonlyArray<Readonly<{ id: string; mood: string }>>; food: number; awake: number; sleepText: string }>;
type Popup = Readonly<{ kind: 'shop' | 'dex'; opener: HTMLElement | null }> | null;
type Preview = Readonly<{ slot: PetShopSlot; id: string }> | null;
type Busy = 'warm' | 'feed' | 'adopt' | 'graduate' | 'decor' | 'company' | null;

const roomPet = (pet: PetDto): PetRoomPetInit => ({ id: pet.petId, species: pet.species, color: pet.color, stage: pet.stage, accessory: pet.accessory });
const needsKey = (petId: string) => `crs-pet-needs:${petId}`;
/** The stage the student last saw a pet at, to celebrate a hatch or a new stage once. */
const seenKey = (petId: string) => `crs-pet-seen:${petId}`;

/** The pet page: the room where the pet (and graduated friends) live, three care buttons, and the 꾸미기/상점 and 도감 popups — or the egg picker. */
export const BankPetView = forwardRef<HTMLHeadingElement, BankPetViewProps>(function BankPetView(
  { view, balance, currencyUnit, loading, error, onBack, onRefresh, onChanged, onSessionExpired, onAnnounce }, headingRef,
) {
  const pet = view?.enabled ? view.pet : null;
  const [engine, setEngine] = useState<PetRoom | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [popup, setPopup] = useState<Popup>(null);
  const [shopSlot, setShopSlot] = useState<PetShopSlot>('wall');
  const [preview, setPreview] = useState<Preview>(null);
  const [wearer, setWearer] = useState<string | null>(null);
  const [graduateOpen, setGraduateOpen] = useState<HTMLElement | null>(null);
  const [toast, setToast] = useState<Notice | null>(null);
  const [celebrate, setCelebrate] = useState<PetCelebrationMoment | null>(null);
  const [pickSpecies, setPickSpecies] = useState<PetSpecies | null>(null);
  const [pickName, setPickName] = useState('');
  const [motion, setMotion] = useState(true);
  const [redraw, setRedraw] = useState(0);
  const pending = useRef<Record<string, string | null>>({});
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; });

  // Reduced motion: the room starts still; the student can turn movement on.
  useEffect(() => {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      void Promise.resolve().then(() => setMotion(false));
    }
  }, []);

  /* One room for the student once they have a pet; the animals in it follow the view. */
  const hasPet = Boolean(pet);
  useEffect(() => {
    if (!hasPet) return;
    const created = ROOM.create(PETS, { pets: [], decor: viewRef.current?.room });
    created.state.rate = ROOM_RATE;
    void Promise.resolve().then(() => setEngine(created));
    return () => { void Promise.resolve().then(() => setEngine(null)); };
  }, [hasPet]);

  // The animals in the room: the pet being raised and the graduated ones keeping it company.
  const animals = useMemo(() => (pet && view ? [pet, ...view.companions] : []), [pet, view]);
  const animalsKey = animals.map((entry) => `${entry.petId}:${entry.species}:${entry.color}:${entry.stage}:${entry.accessory}`).join('|');
  const animalsRef = useRef(animals);
  useEffect(() => { animalsRef.current = animals; });
  useEffect(() => {
    if (!engine) return;
    const list = animalsRef.current;
    const known = new Set(engine.pets.map((entry) => entry.s.id));
    engine.actions.setPets(list.map(roomPet));
    // A newcomer remembers how rested and happy it was, and how hungry the room's last feeding left it.
    const now = Date.now();
    const fedAt = viewRef.current?.lastFedAt ?? list[0]?.adoptedAt ?? new Date(now).toISOString();
    const hunger = Math.min(100, (weekdayHoursSince(fedAt, now) * 100) / HUNGRY_AFTER_HOURS);
    for (const entry of list) {
      if (known.has(entry.petId)) continue;
      let saved: { energy?: number; fun?: number; asleep?: boolean; at?: number; plays?: number[]; boredUntil?: number } = {};
      try { saved = JSON.parse(window.localStorage.getItem(needsKey(entry.petId)) ?? '{}') as typeof saved; } catch { saved = {}; }
      const minutes = typeof saved.at === 'number' ? Math.max(0, (now - saved.at) / 60_000) : 0;
      let energy = typeof saved.energy === 'number' ? saved.energy : 75;
      const fun = typeof saved.fun === 'number' ? Math.max(0, saved.fun - minutes * 0.5) : 55;
      // Asleep: a full sleep takes about two minutes in the app; awake and away, it rests slowly.
      energy = Math.min(100, energy + minutes * (saved.asleep ? 45 : 2));
      engine.actions.restore(entry.petId, {
        hunger, energy, fun, asleep: saved.asleep === true && energy < 100,
        plays: Array.isArray(saved.plays) ? saved.plays : [], boredUntil: typeof saved.boredUntil === 'number' ? saved.boredUntil : 0,
      });
    }
    void Promise.resolve().then(() => setRedraw((n) => n + 1));
  }, [engine, animalsKey]);

  // Every few seconds (and when leaving) each animal's needs are kept in this browser.
  useEffect(() => {
    if (!engine) return;
    const save = () => {
      for (const entry of engine.pets) {
        const snapshot = engine.actions.snapshot(entry.s.id);
        if (!snapshot) continue;
        try { window.localStorage.setItem(needsKey(entry.s.id), JSON.stringify({ ...snapshot, at: Date.now() })); } catch { /* private window: it starts fresh next time */ }
      }
    };
    const timer = window.setInterval(save, 5000);
    return () => { window.clearInterval(timer); save(); };
  }, [engine]);

  // Keep the room's decor and the opening hours in step with the view.
  const roomKey = view ? PET_DECOR_SLOTS.map((slot) => view.room[slot]).join('|') : '';
  useEffect(() => { if (engine && viewRef.current) { engine.actions.setDecor(viewRef.current.room); void Promise.resolve().then(() => setRedraw((n) => n + 1)); } }, [engine, roomKey]);
  const awake = view?.awake ?? true;
  useEffect(() => { if (engine) { engine.actions.setOffHours(!awake); void Promise.resolve().then(() => setRedraw((n) => n + 1)); } }, [awake, engine]);

  // With opening hours set, check every minute whether the pets should wake up or fall asleep.
  const hoursEnabled = view?.hoursEnabled ?? false;
  const refreshRef = useRef(onRefresh);
  useEffect(() => { refreshRef.current = onRefresh; });
  useEffect(() => {
    if (!hoursEnabled) return;
    const timer = window.setInterval(() => refreshRef.current(), 60_000);
    return () => window.clearInterval(timer);
  }, [hoursEnabled]);

  // A hatch or a new stage is celebrated once, whatever brought it (feeding, a task, the teacher):
  // the stage the student last saw is kept per pet (in memory too, for a private window).
  const seenStages = useRef(new Map<string, number>());
  const watchedId = pet?.petId ?? null, watchedStage = pet?.stage ?? null;
  const petRef = useRef(pet);
  useEffect(() => { petRef.current = pet; });
  useEffect(() => {
    const current = petRef.current;
    if (!current || watchedId === null || watchedStage === null) return;
    let seen: number | undefined = seenStages.current.get(watchedId);
    try {
      const stored = window.localStorage.getItem(seenKey(watchedId));
      if (stored !== null && /^[0-3]$/u.test(stored)) seen = Number(stored);
    } catch { /* private window: the in-memory value is enough for this visit */ }
    seenStages.current.set(watchedId, watchedStage);
    try { window.localStorage.setItem(seenKey(watchedId), String(watchedStage)); } catch { /* see above */ }
    if (seen !== undefined && watchedStage > seen) {
      const from = seen as PetStage;
      void Promise.resolve().then(() => setCelebrate({ kind: from === 0 ? 'hatch' : 'grow', pet: current, from }));
    }
  }, [watchedId, watchedStage]);

  const readStatus = useCallback(() => {
    if (!engine) return;
    const info = engine.actions.sleepInfo();
    let sleepText = '';
    if (info?.reason === 'off') {
      const next = viewRef.current?.nextOpen;
      sleepText = `이용 시간이 아니라 자고 있어요${next ? ` · ${next}에 일어나요` : ''}. 그동안은 구경만 할 수 있어요.`;
    } else if (info) {
      const minutes = Math.max(1, Math.ceil((info.framesLeft ?? 0) / 12 / 60));
      sleepText = `쿨쿨 자고 있어요 · 약 ${minutes}분 뒤에 스스로 일어나요.`;
    }
    const next: Status = {
      moods: engine.actions.moods(), food: engine.state.food, awake: engine.actions.awakeCount(), sleepText,
    };
    setStatus((current) => (current && JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, [engine]);
  useEffect(() => { void Promise.resolve().then(readStatus); }, [readStatus, redraw]);

  /** What happened, for the popups that stay on the screen (꾸미기/상점, 도감) and for screen readers. */
  function say(message: string) {
    setNotice(message);
    onAnnounce(message);
  }

  /** A refusal: inside the open popup, or as a notice at the top of the pet screen. */
  function fail(result: BankFailure, key: string, fallback: string) {
    if (isSessionRequired(result)) { onSessionExpired(); return; }
    // No answer: keep the operation ID so pressing again cannot pay twice.
    if (result.status !== 0) pending.current[key] = null;
    const message = result.error ?? fallback;
    if (popup) setActionError(message);
    else setToast({ message, tone: 'danger' });
    if (result.status === 409) onRefresh();
  }

  /** A button that cannot be used now still answers when pressed: its reason in a notice at the top. */
  function blocked(message: string) {
    setToast({ message });
  }

  const operation = (key: string) => {
    const id = pending.current[key] ?? crypto.randomUUID();
    pending.current[key] = id;
    return id;
  };

  async function care(kind: 'WARM' | 'FEED') {
    if (!view || !pet || busy) return;
    const key = kind === 'WARM' ? 'warm' : 'feed';
    setBusy(key); setActionError(''); setNotice('');
    const result = await carePet(operation(key), kind);
    setBusy(null);
    if (!result.ok) { fail(result, key, kind === 'WARM' ? '알을 품어 주지 못했어요. 다시 눌러 주세요.' : '먹이를 주지 못했어요. 다시 눌러 주세요.'); return; }
    pending.current[key] = null;
    const outcome = result.data.result;
    onChanged(result.data.pet, result.data.balance);
    if (engine) {
      if (outcome.kind === 'FEED') engine.actions.feed(); else engine.actions.warm();
      setRedraw((n) => n + 1);
    }
    // The animals answer on screen; a hatch or a new stage gets its own popup.
    onAnnounce(outcome.kind === 'WARM' ? '알을 따뜻하게 품어 줬어요.' : '먹이를 줬어요.');
  }

  function pat() {
    if (!engine) return;
    engine.actions.pat();
    setRedraw((n) => n + 1);
    onAnnounce('쓰다듬어 줬어요.');
  }

  /**
   * 놀아 주기 is never blocked: the ball is thrown and the animals answer (playing, a shrug, a yawn).
   * When none of them plays, a notice at the top says why.
   */
  function play() {
    if (!engine || !view) return;
    const before = engine.actions.readiness();
    const out = engine.actions.play();
    setRedraw((n) => n + 1);
    if (out.played > 0) { onAnnounce('공을 던져 줬어요.'); return; }
    if (!view.awake) blocked(`이용 시간이 아니라 펫이 자고 있어요.${view.nextOpen ? ` ${view.nextOpen}에 일어나요.` : ''}`);
    else if (out.bored > 0 && out.tired === 0) blocked(`공놀이에 조금 질렸나 봐요. 약 ${Math.max(1, before.boredMinutes)}분 뒤에 다시 놀 수 있어요.`);
    else if (out.tired > 0) blocked('졸려서 놀 기운이 없대요. 조금 쉬게 해 주세요.');
    else blocked('모두 쿨쿨 자고 있어서 공을 쳐다보지 않아요. 다 쉬면 스스로 일어나요.');
  }

  async function adopt() {
    const name = cleanPetName(pickName);
    if (!pickSpecies || !name || busy) return;
    setBusy('adopt'); setActionError(''); setNotice('');
    const result = await adoptPet({ operationId: operation('adopt'), species: pickSpecies, name });
    setBusy(null);
    if (!result.ok) { fail(result, 'adopt', '알을 받지 못했어요. 다시 눌러 주세요.'); return; }
    pending.current.adopt = null;
    setPickSpecies(null); setPickName('');
    onChanged(result.data.pet, result.data.balance);
    onAnnounce(`${PET_SPECIES_NAMES[result.data.result.pet.species]} 알을 받았어요.`);
  }

  async function graduate() {
    if (busy || !pet) return;
    const graduating = pet;
    setBusy('graduate'); setActionError(''); setNotice('');
    const result = await graduatePet(operation('graduate'));
    setBusy(null);
    setGraduateOpen(null);
    if (!result.ok) { fail(result, 'graduate', '졸업시키지 못했어요. 다시 눌러 주세요.'); return; }
    pending.current.graduate = null;
    const done = result.data.result;
    onChanged(result.data.pet, result.data.balance);
    const prize = [done.rewardAmount > 0 ? formatMoney(done.rewardAmount, currencyUnit) : '', done.rewardItem].filter(Boolean);
    setCelebrate({ kind: 'graduate', pet: { ...graduating, name: done.name }, prize });
    onAnnounce(`${withParticle(done.name, '이/가')} 졸업했어요.`);
  }

  async function decor(slot: PetShopSlot, id: string, mode: 'buy' | 'place', target: string | null) {
    if (busy) return;
    const itemKey = petDecorKey(slot, id);
    const petId = slot === 'acc' && target ? target : undefined;
    setBusy('decor'); setActionError(''); setNotice('');
    const result = mode === 'buy'
      ? await buyPetDecor({ operationId: operation(`buy:${itemKey}`), itemKey, ...(petId ? { petId } : {}) })
      : await placePetDecor(itemKey, petId);
    setBusy(null);
    if (!result.ok) { fail(result, `buy:${itemKey}`, '꾸미지 못했어요. 다시 눌러 주세요.'); return; }
    pending.current[`buy:${itemKey}`] = null;
    setPreview(null);
    onChanged(result.data.pet, result.data.balance);
    const name = PET_SHOP_ITEMS[slot].find((item) => item.id === id)?.name ?? '물건';
    const who = animals.find((entry) => entry.petId === petId)?.name;
    if (slot === 'acc') {
      if (id === 'none') say(who ? `${who}의 장식을 뺐어요.` : '장식을 뺐어요.');
      else say(mode === 'buy' ? `${withParticle(name, '을/를')} 샀어요.${who ? ` ${who}에게 해 줬어요.` : ''}` : `${who ?? '펫'}에게 ${withParticle(name, '을/를')} 해 줬어요.`);
    } else {
      say(mode === 'buy' ? `${withParticle(name, '을/를')} 샀어요. 방에 놓았어요.` : `${withParticle(name, '을/를')} 방에 놓았어요.`);
    }
  }

  async function company(petIds: string[]) {
    if (busy) return;
    setBusy('company'); setActionError(''); setNotice('');
    const result = await setPetCompanions(petIds);
    setBusy(null);
    if (!result.ok) { fail(result, 'company', '펫을 부르지 못했어요. 다시 눌러 주세요.'); return; }
    onChanged(result.data.pet, result.data.balance);
  }

  /* ------------------------------------------------------------------ */

  const egg = pet?.stage === 0;
  const grownUps = animals.filter((entry) => entry.stage > 0);
  // Why each button cannot be used right now ('' when it can). The buttons stay pressable to say why.
  const offText = view ? `이용 시간이 아니라 펫이 자고 있어요.${view.nextOpen ? ` ${view.nextOpen}에 일어나요.` : ''}` : '';
  let warmBlock = '', feedBlock = '', patBlock = '';
  if (view && pet) {
    if (!view.awake) warmBlock = feedBlock = patBlock = offText;
    else {
      if (view.warmedToday) warmBlock = '오늘은 알을 품어 줬어요. 내일 또 품어 줄 수 있어요.';
      if (view.feedDailyLimit === 0) feedBlock = '지금은 먹이 주기를 쉬고 있어요.';
      else if (view.feedsToday >= view.feedDailyLimit) feedBlock = '오늘 먹이는 다 줬어요. 내일 또 줄 수 있어요.';
      else if (balance < view.feedPrice) feedBlock = `잔액이 부족해서 먹이를 줄 수 없어요. 먹이 주기는 ${formatMoney(view.feedPrice, currencyUnit)}이에요.`;
      else if ((status?.food ?? 0) > 0) feedBlock = '먹이통에 아직 먹이가 남아 있어요. 다 먹은 뒤에 다시 줄 수 있어요.';
      if (status && status.awake === 0) patBlock = '모두 쿨쿨 자고 있어요. 다 쉬면 스스로 일어나요.';
    }
  }
  const canFeed = grownUps.length > 0;
  const feedLabel = view && view.feedPrice > 0 ? `먹이 주기 · ${formatMoney(view.feedPrice, currencyUnit)}` : '먹이 주기';
  const canGraduate = Boolean(view && pet && pet.stage === 3 && pet.growth >= view.goal);
  const next = pet && view ? nextStageTitle(pet, view.goal) : null;
  const prize = view ? [view.rewardAmount > 0 ? formatMoney(view.rewardAmount, currencyUnit) : '', view.rewardItem].filter(Boolean) : [];
  const moodOf = new Map((status?.moods ?? []).map((entry) => [entry.id, entry.mood]));
  const soft = (block: string) => (block ? { 'aria-disabled': true as const, className: 'opacity-45' } : {});

  return (
    <div className="pb-[max(2rem,calc(env(safe-area-inset-bottom)+1.5rem))] pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-center gap-2">
        <IconButton icon="chevronLeft" label="홈으로 돌아가기" onClick={onBack} className="-ml-2" size="lg" />
        <h2 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 truncate text-[22px] font-black tracking-[-0.03em] outline-none">
          {pet ? pet.name : '펫 키우기'}
        </h2>
        <IconButton icon="refresh" label="펫 새로고침" onClick={onRefresh} disabled={loading} />
      </header>

      {error ? <div role="alert" className="mt-4"><Callout tone="danger">{error}</Callout></div> : null}
      {!view && loading ? (
        <div role="status" className="mt-10 flex flex-col items-center gap-3 text-[15px] font-bold text-[var(--theme-muted-text)]">
          <Spinner size={26} className="text-[var(--theme-accent-text)]" />펫을 불러오는 중이에요.
        </div>
      ) : null}
      {view && !view.enabled ? <div className="mt-5"><Callout tone="info">선생님이 아직 펫 키우기를 열지 않았어요.</Callout></div> : null}

      {view?.enabled && !pet ? (
        <section aria-labelledby="pet-pick-title" className="mt-4 rounded-[26px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-4 shadow-[var(--crs-shadow-sm)] sm:p-5">
          <h3 id="pet-pick-title" className="text-[18px] font-black tracking-[-0.02em]">새 알 고르기</h3>
          <p className="mt-1 text-[13px] font-semibold text-[var(--theme-muted-text)]">키우고 싶은 동물의 알을 골라요. 털 색은 알이 부화할 때 정해지는데, 아직 도감에 없는 색이 먼저 나와요.</p>
          {!view.awake ? <div className="mt-3"><Callout tone="info">이용 시간이 아니라 지금은 알을 고를 수 없어요.{view.nextOpen ? ` ${view.nextOpen}에 다시 와 주세요.` : ''}</Callout></div> : null}
          <div role="group" aria-label="알 종류" className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-7">
            {PET_SPECIES.map((value) => (
              <button key={value} type="button" aria-pressed={pickSpecies === value} onClick={() => setPickSpecies(value)}
                className={cx('flex flex-col items-center gap-1 rounded-[14px] border bg-[var(--theme-surface)] px-1 py-2 text-[13px] font-bold transition-colors',
                  pickSpecies === value ? 'border-[var(--theme-accent-solid)] ring-2 ring-[var(--theme-accent-solid)]' : 'border-[var(--crs-line)] hover:bg-[var(--crs-subtle-hover)]')}>
                <PetPicture species={value} stage={0} color={null} size={56} crop={EGG_CROP} />
                {PET_SPECIES_NAMES[value]}
              </button>
            ))}
          </div>
          <label htmlFor="pet-name" className="mt-4 block text-[14px] font-bold">이름</label>
          <Input id="pet-name" value={pickName} maxLength={PET_NAME_LENGTH} placeholder="예: 초코" autoComplete="off" className="mt-1 max-w-[16rem]"
            onChange={(event) => setPickName(event.target.value)} />
          <p className="mt-1 text-[12px] font-semibold text-[var(--theme-muted-text)]">1~{PET_NAME_LENGTH}자로 지어요. 나중에 선생님이 고쳐 줄 수 있어요.</p>
          <Button className="mt-4" variant="primary" size="lg" block icon="paw" onClick={() => void adopt()} loading={busy === 'adopt'}
            disabled={!pickSpecies || !cleanPetName(pickName) || !view.awake || Boolean(busy)}>이 알로 시작하기</Button>
          <Button className="mt-2" variant="ghost" block icon="package" onClick={(event) => { setNotice(''); setActionError(''); setPopup({ kind: 'dex', opener: event.currentTarget }); }}>
            도감 보기 · {view.dex.length}마리
          </Button>
        </section>
      ) : null}

      {view && pet && engine ? (
        <section className="mt-4 rounded-[26px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-3 shadow-[var(--crs-shadow-sm)] sm:p-4">
          <div className="relative">
            <PetRoomCanvas room={engine} running={motion && popup?.kind !== 'shop'} redrawKey={redraw} onFrame={readStatus}
              label={`${pet.name}의 방. ${animals.map((entry) => `${entry.name} ${moodOf.get(entry.petId) ?? ''}`).join(', ')}`} />
            {status?.sleepText ? (
              <p className="absolute left-1/2 top-2.5 w-max max-w-[calc(100%-1.25rem)] -translate-x-1/2 rounded-[10px] bg-[rgba(38,30,24,0.84)] px-3 py-1.5 text-center text-[12.5px] font-semibold leading-snug text-[#fff8ef]">
                {status.sleepText}
              </p>
            ) : null}
          </div>
          {!motion ? <Button className="mt-2" size="sm" variant="ghost" icon="sparkle" onClick={() => setMotion(true)}>움직임 켜기</Button> : null}

          <ul aria-label="펫 기분" className="mt-3 flex flex-wrap gap-2">
            {animals.map((entry) => (
              <li key={entry.petId} className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-[var(--theme-accent-soft)] py-1 pl-1 pr-3">
                <PetPicture species={entry.species} stage={entry.stage} color={entry.color} accessory={entry.accessory} size={28}
                  crop={entry.stage === 0 ? EGG_CROP : [2, 6, 18, 18]} />
                <span className="max-w-[8rem] truncate text-[13px] font-bold">{entry.name}</span>
                <span className="text-[13px] font-black text-[var(--theme-accent-text)]">{moodOf.get(entry.petId) ?? ''}</span>
              </li>
            ))}
          </ul>

          {next ? (
            <div className="mt-3 rounded-[16px] bg-[var(--theme-accent-soft)] p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-[16px] font-black tracking-[-0.02em]">{petTitle(pet)}</span>
                {next.points ? <span className="shrink-0 text-[15px] font-black tabular-nums" aria-label={`이번 단계 성장 ${next.points}`}>{next.points}</span> : null}
              </div>
              <div className="mt-2"><StageBar fraction={next.fraction} label={next.title ? `${next.title}까지` : '다 자람'} track="bg-[var(--theme-surface)]" /></div>
              {next.title ? <p className="mt-1.5 text-[13px] font-bold text-[var(--theme-accent-text)]">다음 단계: {next.title}</p> : (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[14px] font-bold text-[var(--theme-accent-text)]">다 자랐어요!</span>
                  {canGraduate ? (
                    <Button variant="primary" size="sm" icon="gift" {...soft(view.awake ? '' : offText)}
                      onClick={(event) => (view.awake ? setGraduateOpen(event.currentTarget) : blocked(offText))}>졸업하기</Button>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {/* The only ways to reach the animals: phones get the paid feeding on its own row. */}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 [&_svg]:shrink-0">
            {egg ? (
              <Button variant="primary" icon="sparkle" loading={busy === 'warm'} disabled={Boolean(busy)} {...soft(warmBlock)}
                onClick={() => (warmBlock ? blocked(warmBlock) : void care('WARM'))}
                className={cx('col-span-2 sm:col-span-3', warmBlock && 'opacity-45')}>알 품어 주기</Button>
            ) : null}
            {canFeed ? (
              <>
                <Button variant={egg ? 'secondary' : 'primary'} icon="bowl" loading={busy === 'feed'} disabled={Boolean(busy)} {...soft(feedBlock)}
                  onClick={() => (feedBlock ? blocked(feedBlock) : void care('FEED'))}
                  className={cx('col-span-2 sm:col-span-1', feedBlock && 'opacity-45')}>{feedLabel}</Button>
                <Button icon="hand" {...soft(patBlock)} onClick={() => (patBlock ? blocked(patBlock) : pat())}>쓰다듬기</Button>
                <Button icon="ball" onClick={play}>놀아 주기</Button>
              </>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon="store" aria-haspopup="dialog" onClick={(event) => {
              setPreview(null); setNotice(''); setActionError(''); setWearer(grownUps[0]?.petId ?? null); setPopup({ kind: 'shop', opener: event.currentTarget });
            }}>꾸미기/상점</Button>
            <Button size="sm" variant="ghost" icon="package" aria-haspopup="dialog" onClick={(event) => { setNotice(''); setActionError(''); setPopup({ kind: 'dex', opener: event.currentTarget }); }}>도감</Button>
          </div>
        </section>
      ) : null}

      {popup?.kind === 'shop' && view && pet && engine ? (
        <PetShop view={view} room={engine} animals={animals} running={motion} balance={balance} currencyUnit={currencyUnit} slot={shopSlot}
          onSlot={(slot) => { setShopSlot(slot); setPreview(null); }} preview={preview} onPreview={setPreview}
          wearer={wearer} onWearer={(id) => { setWearer(id); setPreview(null); }} busy={busy === 'decor'}
          notice={notice} error={actionError} opener={popup.opener} onClose={() => { setPopup(null); setPreview(null); setActionError(''); }}
          onBuy={(slot, id) => void decor(slot, id, 'buy', wearer)} onPlace={(slot, id) => void decor(slot, id, 'place', wearer)} />
      ) : null}
      {popup?.kind === 'dex' && view ? (
        <Modal title="도감" size="lg" opener={popup.opener} onClose={() => { setPopup(null); setActionError(''); }} busy={busy === 'company'}
          description="다 키워 졸업한 펫이 남아요. 졸업한 펫은 방으로 불러 함께 지낼 수 있어요(키우는 펫까지 세 마리)."
          footer={<Button variant="ghost" onClick={() => { setPopup(null); setActionError(''); }}>닫기</Button>}>
          {actionError ? <div role="alert" className="mb-2"><Callout tone="danger">{actionError}</Callout></div> : null}
          <PetDex view={view} busy={busy === 'company'} onCompany={(petIds) => void company(petIds)} />
        </Modal>
      ) : null}
      {graduateOpen && pet ? (
        <GraduateConfirm pet={pet} prize={prize} busy={busy === 'graduate'} onConfirm={() => void graduate()} onClose={() => setGraduateOpen(null)} />
      ) : null}
      {celebrate && view && !popup && !graduateOpen ? <PetCelebration moment={celebrate} goal={view.goal} onClose={() => setCelebrate(null)} /> : null}
      {toast ? <NoticeToast notice={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
});

/** The 꾸미기/상점 popup: the room on top (a tried-on item shows there), the items below, buying or placing in the footer. */
function PetShop({ view, room, animals, running, balance, currencyUnit, slot, onSlot, preview, onPreview, wearer, onWearer, busy, notice, error, opener, onClose, onBuy, onPlace }: Readonly<{
  view: PetStudentViewDto; room: PetRoom; animals: ReadonlyArray<PetDto>; running: boolean; balance: number; currencyUnit: string;
  slot: PetShopSlot; onSlot: (slot: PetShopSlot) => void; preview: Preview; onPreview: (preview: Preview) => void;
  wearer: string | null; onWearer: (petId: string) => void;
  busy: boolean; notice: string; error: string; opener: HTMLElement | null; onClose: () => void;
  onBuy: (slot: PetShopSlot, id: string) => void; onPlace: (slot: PetShopSlot, id: string) => void;
}>) {
  const owned = new Set(view.owned);
  const prices = new Map(view.shop.map((item) => [item.key, item.price]));
  const items = PET_SHOP_ITEMS[slot].filter((item) => item.base || owned.has(petDecorKey(slot, item.id)) || prices.has(petDecorKey(slot, item.id)));
  const chosen = preview && preview.slot === slot ? PET_SHOP_ITEMS[slot].find((item) => item.id === preview.id) ?? null : null;
  const chosenKey = chosen ? petDecorKey(slot, chosen.id) : '';
  const grownUps = animals.filter((entry) => entry.stage > 0);
  const target = slot === 'acc' ? grownUps.find((entry) => entry.petId === wearer) ?? grownUps[0] ?? null : null;
  const inUse = (id: string) => (slot === 'acc' ? (target?.accessory ?? 'none') === id : view.room[slot] === id);
  const placed = chosen ? inUse(chosen.id) : false;
  const has = chosen ? chosen.base === true || owned.has(chosenKey) : false;
  const price = chosen ? prices.get(chosenKey) : undefined;
  const needsPet = slot === 'acc' && !target;
  const previewAccessories = chosen && slot === 'acc' && target ? { [target.petId]: chosen.id === 'none' ? null : chosen.id } : null;
  const previewDecor = chosen && slot !== 'acc' ? { [slot]: chosen.id } : null;
  const placeLabel = slot === 'acc' ? (chosen?.id === 'none' ? '장식 빼기' : '해 주기') : '방에 놓기';
  return (
    <Modal title="꾸미기/상점" size="lg" opener={opener} onClose={onClose} busy={busy}
      description={`내 돈 ${formatMoney(balance, currencyUnit)} · 가진 물건으로 방과 펫을 꾸미고, 새 물건은 여기서 사요. 산 물건은 펫이 졸업해도 그대로 남아요.`}
      footer={chosen ? (
        <>
          <span className="mr-auto min-w-0 truncate text-[13px] font-bold">{chosen.name}</span>
          <Button variant="ghost" onClick={() => onPreview(null)} disabled={busy}>미리 보기 끄기</Button>
          {placed ? <Button disabled>{slot === 'acc' ? (chosen.id === 'none' ? '장식 없음' : '하고 있어요') : '놓여 있어요'}</Button>
            : has ? <Button variant="primary" onClick={() => onPlace(slot, chosen.id)} loading={busy} disabled={busy || !view.awake || needsPet}>{placeLabel}</Button>
              : <Button variant="primary" icon="coins" onClick={() => onBuy(slot, chosen.id)} loading={busy}
                disabled={busy || !view.awake || !view.shopEnabled || price === undefined || balance < price}>
                {price !== undefined && balance < price ? `돈이 모자라요 · ${formatMoney(price, currencyUnit)}` : `사기 · ${formatMoney(price ?? 0, currencyUnit)}`}
              </Button>}
        </>
      ) : <Button variant="ghost" onClick={onClose}>닫기</Button>}>
      <div className="sticky top-0 z-10 -mx-5 bg-[var(--theme-surface)] px-5 pb-3 sm:-mx-6 sm:px-6">
        <div className="relative mx-auto max-w-[26rem]">
          <PetRoomCanvas room={room} running={running} previewDecor={previewDecor} previewAccessories={previewAccessories}
            label={chosen ? `${withParticle(chosen.name, '을/를')} 해 본 미리 보기` : '지금 방'} />
          <p className="absolute bottom-2 left-2 rounded-[8px] bg-[rgba(38,30,24,0.78)] px-2 py-0.5 text-[12px] font-bold text-[#fff8ef]">
            {chosen ? `미리 보기 · ${chosen.name}` : '지금 방'}
          </p>
        </div>
      </div>
      {error ? <div role="alert" className="mb-2"><Callout tone="danger">{error}</Callout></div> : null}
      {notice ? <p role="status" className="mb-2 text-[13.5px] font-bold text-[var(--theme-accent-text)]">{notice}</p> : null}
      {!view.shopEnabled ? <div className="mb-2"><Callout tone="info">선생님이 상점을 닫아 두었어요. 가지고 있는 물건으로만 꾸밀 수 있어요.</Callout></div> : null}
      {!view.awake ? <div className="mb-2"><Callout tone="info">이용 시간이 아니라 꾸미기와 상점도 쉬어요.</Callout></div> : null}
      <SegmentedControl ariaLabel="물건 종류" value={slot} onChange={onSlot} size="sm"
        options={PET_SHOP_SLOTS.map((value) => ({ value, label: PET_SHOP_SLOT_NAMES[value] }))} />
      {slot === 'acc' ? (
        grownUps.length > 1 ? (
          <div role="group" aria-label="장식을 할 펫" className="mt-3 flex flex-wrap gap-2">
            {grownUps.map((entry) => (
              <button key={entry.petId} type="button" aria-pressed={target?.petId === entry.petId} onClick={() => onWearer(entry.petId)}
                className={cx('inline-flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-3 text-[13px] font-bold transition-colors',
                  target?.petId === entry.petId ? 'border-[var(--theme-accent-solid)] ring-2 ring-[var(--theme-accent-solid)]' : 'border-[var(--crs-line)] hover:bg-[var(--crs-subtle-hover)]')}>
                <PetPicture species={entry.species} stage={entry.stage} color={entry.color} accessory={entry.accessory} size={26} crop={[2, 6, 18, 18]} />
                {entry.name}
              </button>
            ))}
          </div>
        ) : needsPet ? <div className="mt-3"><Callout tone="info">알이 부화하면 장식을 해 줄 수 있어요. 미리 사 둘 수는 있어요.</Callout></div> : null
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {items.map((item) => {
          const key = petDecorKey(slot, item.id);
          const isPlaced = inUse(item.id);
          const isOwned = item.base === true || owned.has(key);
          const selected = preview?.slot === slot && preview.id === item.id;
          return (
            <button key={item.id} type="button" aria-pressed={selected} onClick={() => onPreview(selected ? null : { slot, id: item.id })}
              className={cx('flex flex-col items-center gap-1 rounded-[14px] border bg-[var(--theme-surface)] p-2 text-center transition-colors',
                selected ? 'border-[var(--theme-accent-solid)] ring-2 ring-[var(--theme-accent-solid)]' : 'border-[var(--crs-line)] hover:bg-[var(--crs-subtle-hover)]')}>
              {slot === 'acc' ? (
                <span className="flex h-[72px] items-center justify-center">
                  <PetPicture species={target?.species ?? 'dog'} stage={target?.stage ?? 3} color={target?.color ?? 'brown'}
                    accessory={item.id === 'none' ? null : item.id} size={72} crop={[2, 4, 20, 20]} />
                </span>
              ) : <DecorPreview room={room} slot={slot} id={item.id} crop={ROOM.DECOR_CROP[slot]} size={96} />}
              <span className="text-[13px] font-bold">{item.name}</span>
              <span className={cx('text-[12px] font-semibold tabular-nums', isPlaced || isOwned ? 'text-[var(--theme-accent-text)]' : 'text-[var(--theme-muted-text)]')}>
                {isPlaced ? (slot === 'acc' ? (item.id === 'none' ? '지금 모습' : '하고 있어요') : '놓여 있어요') : isOwned ? '가지고 있어요' : formatMoney(prices.get(key) ?? 0, currencyUnit)}
              </span>
            </button>
          );
        })}
      </div>
      {items.length === 1 ? <p className="mt-2 text-[13px] font-semibold text-[var(--theme-muted-text)]">{withParticle(PET_SHOP_SLOT_NAMES[slot], '은/는')} 아직 파는 물건이 없어요.</p> : null}
      {!chosen ? <p className="mt-3 text-[12.5px] font-semibold text-[var(--theme-muted-text)]">물건을 누르면 위의 방에서 먼저 볼 수 있어요.</p> : null}
    </Modal>
  );
}

/** The 도감: graduated pets to call back to the room, then every species and color, the collected ones in color. */
function PetDex({ view, busy, onCompany }: Readonly<{ view: PetStudentViewDto; busy: boolean; onCompany: (petIds: string[]) => void }>) {
  const got = new Map(view.dex.map((entry) => [`${entry.species}:${entry.color}`, entry]));
  const total = Object.values(PET_COLORS).reduce((sum, colors) => sum + colors.length, 0);
  const company = view.companions.map((entry) => entry.petId);
  const full = company.length >= PET_MAX_COMPANIONS;
  return (
    <div className="space-y-5">
      {view.dex.length > 0 ? (
        <section aria-labelledby="pet-dex-company" className="space-y-2">
          <h3 id="pet-dex-company" className="text-[15px] font-black">졸업한 펫 <span className="text-[13px] font-bold text-[var(--theme-muted-text)]">· 방에 {company.length}/{PET_MAX_COMPANIONS}마리</span></h3>
          {!view.pet ? <p className="text-[12.5px] font-semibold text-[var(--theme-muted-text)]">새 알을 고르면 졸업한 펫을 방으로 부를 수 있어요.</p> : null}
          <ul className="grid gap-2 sm:grid-cols-2">
            {[...view.dex].reverse().map((entry) => {
              const here = company.includes(entry.petId);
              return (
                <li key={entry.petId} className="flex items-center gap-3 rounded-[14px] border border-[var(--crs-line)] p-2">
                  <span className="shrink-0 rounded-[10px] bg-[var(--theme-accent-soft)]">
                    <PetPicture species={entry.species} stage={3} color={entry.color} accessory={entry.accessory} size={48} crop={[2, 4, 20, 20]} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-bold">{entry.name}</span>
                    <span className="block truncate text-[12px] font-semibold text-[var(--theme-muted-text)]">{petColorName(entry.species, entry.color)} {PET_SPECIES_NAMES[entry.species]}</span>
                  </span>
                  <Button size="sm" variant={here ? 'secondary' : 'primary'} disabled={busy || !view.awake || !view.pet || (!here && full)}
                    onClick={() => onCompany(here ? company.filter((id) => id !== entry.petId) : [...company, entry.petId])}>
                    {here ? '돌려보내기' : '방에 부르기'}
                  </Button>
                </li>
              );
            })}
          </ul>
          {full && view.pet ? <p className="text-[12.5px] font-semibold text-[var(--theme-muted-text)]">키우는 펫까지 세 마리가 함께 지내요. 다른 펫을 부르려면 먼저 한 마리를 돌려보내 주세요.</p> : null}
        </section>
      ) : null}
      <section aria-labelledby="pet-dex-all">
        <h3 id="pet-dex-all" className="text-[15px] font-black">모은 펫 <span className="text-[13px] font-bold tabular-nums text-[var(--theme-muted-text)]">{got.size}/{total}</span></h3>
        <p className="mt-0.5 text-[12.5px] font-semibold text-[var(--theme-muted-text)]">아직 키우지 못한 종·색은 그림자로 보여요.</p>
        <ul className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-7">
          {PET_SPECIES.flatMap((value) => PET_COLORS[value].map((color) => {
            const entry = got.get(`${value}:${color.id}`);
            return (
              <li key={`${value}:${color.id}`} className="flex flex-col items-center gap-0.5 rounded-[12px] bg-[var(--theme-accent-soft)] p-1.5 text-center">
                <PetPicture species={value} stage={3} color={color.id} accessory={entry?.accessory ?? null} size={64} silhouette={!entry}
                  label={entry ? `${entry.name}, ${color.name} ${PET_SPECIES_NAMES[value]}` : '아직 키우지 않은 펫'} />
                <span className="w-full truncate text-[11.5px] font-bold">{entry ? entry.name : '???'}</span>
                {entry ? <span className="w-full truncate text-[10.5px] font-semibold text-[var(--theme-muted-text)]">{color.name} {PET_SPECIES_NAMES[value]}</span> : null}
              </li>
            );
          }))}
        </ul>
      </section>
    </div>
  );
}
