'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  PET_LIMITS,
  PET_NAME_LENGTH,
  PET_SELLABLE_DECOR,
  PET_SHOP_ITEMS,
  PET_SHOP_SLOTS,
  PET_SHOP_SLOT_NAMES,
  PET_SPECIES_NAMES,
  cleanPetName,
  parsePetSettings,
  petEstimateDays,
  petStageFor,
  petStageStarts,
  type PetSettings,
  type PetShopSlot,
} from '@/domain/pet';
import type { PetAdminBoardDto, PetAdminStudentDto } from '@/lib/petApi';
import PETS from '@/lib/pet/petSprites';
import ROOM from '@/lib/pet/petRoom';
import { schoolDaysEstimate } from '@/domain/schoolDays';
import { DIGITAL_KIND_LABELS } from '@/lib/studentBagApi';
import { Button, Callout, Card, Checkbox, EmptyState, Field, Icon, IconButton, Input, Modal, PageHeader, SegmentedControl, Select, Spinner, StatCard, Switch, cx } from '../ui';
import { PetPicture } from './PetPicture';
import { DecorPreview } from './PetRoomCanvas';
import { adjustPetGrowth, fetchPetBoard, renamePet, savePetSettings } from './petAdminClient';

type Draft = Readonly<{
  enabled: boolean; goal: string; tasksPerWeek: string; careGrowth: string; taskGrowth: string;
  feedPrice: string; feedDailyLimit: string; hoursEnabled: boolean; hours: ReadonlyArray<Readonly<{ start: string; end: string }>>;
  rewardAmount: string; rewardProductId: string; shopEnabled: boolean; shopPrices: Readonly<Record<string, Readonly<{ price: string; sell: boolean }>>>;
}>;

const toDraft = (settings: PetSettings): Draft => ({
  enabled: settings.enabled,
  goal: String(settings.goal),
  tasksPerWeek: String(settings.tasksPerWeek),
  careGrowth: String(settings.careGrowth),
  taskGrowth: String(settings.taskGrowth),
  feedPrice: String(settings.feedPrice),
  feedDailyLimit: String(settings.feedDailyLimit),
  hoursEnabled: settings.hoursEnabled,
  hours: settings.hours.map((span) => ({ ...span })),
  rewardAmount: String(settings.rewardAmount),
  rewardProductId: settings.rewardProductId ?? '',
  shopEnabled: settings.shopEnabled,
  shopPrices: Object.fromEntries(PET_SELLABLE_DECOR.map((item) => {
    const entry = settings.shopPrices[item.key];
    return [item.key, { price: entry?.price === null || entry === undefined ? '' : String(entry.price), sell: entry?.sell === true }];
  })),
});

const wholeOrNaN = (text: string) => (/^\d+$/u.test(text.trim()) ? Number(text.trim()) : Number.NaN);

function fromDraft(draft: Draft, enabled = draft.enabled) {
  return parsePetSettings({
    enabled,
    goal: wholeOrNaN(draft.goal),
    tasksPerWeek: wholeOrNaN(draft.tasksPerWeek),
    careGrowth: wholeOrNaN(draft.careGrowth),
    taskGrowth: wholeOrNaN(draft.taskGrowth),
    feedPrice: wholeOrNaN(draft.feedPrice),
    feedDailyLimit: wholeOrNaN(draft.feedDailyLimit),
    hoursEnabled: draft.hoursEnabled,
    // A row left completely empty is dropped; a half-filled one is refused by the parser.
    hours: draft.hours.filter((span) => span.start || span.end),
    rewardAmount: wholeOrNaN(draft.rewardAmount),
    rewardProductId: draft.rewardProductId || null,
    shopEnabled: draft.shopEnabled,
    shopPrices: Object.fromEntries(Object.entries(draft.shopPrices).map(([key, entry]) => [key, {
      price: entry.price.trim() === '' ? null : wholeOrNaN(entry.price), sell: entry.sell && entry.price.trim() !== '',
    }])),
  });
}

const fmt = (value: number) => value.toLocaleString('ko-KR');
const STAGE_WORDS = ['', '아기', '어린', '다 자란'] as const;
const TABS = [
  { id: 'list', label: '펫 목록' }, { id: 'growth', label: '성장' }, { id: 'food', label: '먹이' },
  { id: 'hours', label: '이용 시간' }, { id: 'grad', label: '졸업' }, { id: 'shop', label: '꾸미기/상점' },
] as const;
type TabId = typeof TABS[number]['id'];
type Sort = 'growth' | 'care' | 'name';

function petTitle(pet: NonNullable<PetAdminStudentDto['pet']>): string {
  return pet.stage === 0 ? `${PET_SPECIES_NAMES[pet.species]} 알` : `${STAGE_WORDS[pet.stage]} ${PET_SPECIES_NAMES[pet.species]}`;
}

/** The teacher's 펫 키우기 screen: every student's pet and the rules, in sub-tabs. */
export function PetPanel({ unit, notify }: Readonly<{ unit: string; notify: (message: string) => void }>) {
  const [board, setBoard] = useState<PetAdminBoardDto | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [tab, setTab] = useState<TabId>('list');
  const [shopSlot, setShopSlot] = useState<PetShopSlot | 'all'>('all');
  // A room with no pet, only for the item pictures in 꾸미기/상점.
  const [previewRoom] = useState(() => ROOM.create(PETS, { pets: [] }));
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  const applyBoard = useCallback((next: PetAdminBoardDto, resetDraft: boolean) => {
    setBoard(next);
    if (resetDraft) setDraft(toDraft(next.settings));
  }, []);

  const load = useCallback(async (resetDraft: boolean) => {
    setLoading(true);
    const result = await fetchPetBoard();
    setLoading(false);
    if (result.ok) { setLoadError(''); applyBoard(result.data, resetDraft); }
    else setLoadError(result.error);
  }, [applyBoard]);

  useEffect(() => { void Promise.resolve().then(() => load(true)); }, [load]);

  const parsed = useMemo(() => (draft ? fromDraft(draft) : null), [draft]);
  const dirty = Boolean(board && draft && JSON.stringify(toDraft(board.settings)) !== JSON.stringify(draft));

  async function save(enabled?: boolean) {
    if (!draft) return;
    const checked = fromDraft(draft, enabled ?? draft.enabled);
    if (!checked.ok) { setFormError(checked.error); return; }
    setSaving(true);
    setFormError('');
    const result = await savePetSettings(checked.settings);
    setSaving(false);
    if (!result.ok) { setFormError(result.error); return; }
    const wasOff = !board?.settings.enabled;
    applyBoard(result.data, true);
    notify(checked.settings.enabled && wasOff ? '펫 키우기를 열었어요. 학생 은행 화면에서 알을 고를 수 있어요.' : '펫 키우기 설정을 저장했어요.');
  }

  function selectTab(next: TabId, focus = false) {
    setTab(next);
    if (focus) tabRefs.current[next]?.focus();
  }
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, current: TabId) {
    const index = TABS.findIndex((entry) => entry.id === current);
    const to = { ArrowRight: (index + 1) % TABS.length, ArrowLeft: (index - 1 + TABS.length) % TABS.length, Home: 0, End: TABS.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    selectTab(TABS[to].id, true);
  }

  if (!board || !draft) {
    return (
      <div className="space-y-6">
        <PageHeader title="펫 키우기" description="학생마다 알을 골라 펫을 키워요. 먹이를 주고 과제를 하면 자라고, 다 자라면 학생이 원할 때 졸업시켜 도감에 남겨요." />
        {loadError ? (
          <Callout tone="danger" title="불러오지 못했어요">
            <p>{loadError}</p>
            <Button className="mt-3" size="sm" variant="secondary" icon="refresh" onClick={() => void load(true)}>다시 불러오기</Button>
          </Callout>
        ) : <div role="status" className="flex items-center gap-2 text-sm font-semibold text-[var(--theme-muted-text)]"><Spinner size={18} />불러오는 중이에요.</div>}
      </div>
    );
  }

  const set = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));
  const shownGoal = parsed?.ok ? parsed.settings.goal : board.goal;
  const starts = petStageStarts(shownGoal);
  const productById = new Map(board.rewardProducts.map((product) => [product.productId, product]));
  const draftRewardProduct = draft.rewardProductId ? productById.get(draft.rewardProductId) ?? null : null;
  // The estimate follows whatever the teacher has typed so far, even before saving.
  const estimateInput = {
    goal: wholeOrNaN(draft.goal), tasksPerWeek: wholeOrNaN(draft.tasksPerWeek), careGrowth: wholeOrNaN(draft.careGrowth),
    taskGrowth: wholeOrNaN(draft.taskGrowth), feedDailyLimit: wholeOrNaN(draft.feedDailyLimit),
  };
  const estimateReady = Object.values(estimateInput).every((value) => Number.isSafeInteger(value)) && estimateInput.goal >= 1;
  const estimate = estimateReady ? petEstimateDays(estimateInput) : null;
  const hatchDays = estimateReady ? petEstimateDays({ ...estimateInput, goal: petStageStarts(estimateInput.goal).hatch }) : null;

  return (
    <div className="space-y-6">
      <PageHeader title="펫 키우기" description="학생마다 알을 골라 펫을 키워요. 먹이를 주고 과제를 하면 자라고, 다 자라면 학생이 원할 때 졸업시켜 도감에 남겨요."
        actions={<Button variant="secondary" size="sm" icon="refresh" onClick={() => void load(!dirty)} disabled={loading}>새로고침</Button>} />

      {!board.settings.enabled && board.students.every((row) => row.pet === null && row.graduations === 0) ? (
        <Card>
          <EmptyState icon="paw" title="아직 펫 키우기를 열지 않았어요"
            description="아래 탭에서 성장 목표와 먹이, 이용 시간, 졸업 보상, 꾸미기/상점을 정하고 시작하면 학생들이 은행 화면에서 알을 골라 키워요."
            action={<Button variant="primary" icon="paw" onClick={() => void save(true)} loading={saving} disabled={saving}>펫 키우기 시작하기</Button>} />
        </Card>
      ) : null}

      <Card className="space-y-5">
        <Switch checked={draft.enabled} onChange={(enabled) => set({ enabled })} label="학생 화면에 펫 키우기 보이기"
          description="끄면 학생들은 펫을 볼 수 없고 과제를 해도 자라지 않아요. 지금까지 키운 기록은 그대로 남아요." />

        <div role="tablist" aria-label="펫 키우기 설정" className="inline-flex max-w-full flex-wrap gap-0.5 rounded-[12px] bg-[var(--crs-subtle-hover)] p-1">
          {TABS.map((entry) => {
            const active = tab === entry.id;
            return (
              <button key={entry.id} ref={(node) => { tabRefs.current[entry.id] = node; }} id={`pet-tab-${entry.id}`} type="button" role="tab"
                aria-selected={active} aria-controls={`pet-panel-${entry.id}`} tabIndex={active ? 0 : -1}
                onClick={() => selectTab(entry.id)} onKeyDown={(event) => onTabKey(event, entry.id)}
                className={cx('h-8 whitespace-nowrap rounded-[9px] px-3 text-[13px] font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]',
                  active ? 'bg-[var(--theme-surface)] text-[var(--theme-text)] shadow-[var(--crs-shadow-sm)]' : 'text-[var(--theme-muted-text)] hover:text-[var(--theme-text)]')}>
                {entry.label}
              </button>
            );
          })}
        </div>

        <div id={`pet-panel-${tab}`} role="tabpanel" aria-labelledby={`pet-tab-${tab}`} tabIndex={0} className="outline-none">
          {tab === 'list' ? (
            <PetList board={board} onRenamed={(next, name) => { applyBoard(next, false); notify(`펫 이름을 '${name}'(으)로 고쳤어요.`); }}
              onAdjusted={(next, message) => { applyBoard(next, false); notify(message); }} />
          ) : null}

          {tab === 'growth' ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="다 자람 목표" htmlFor="pet-goal" hint="이만큼 성장하면 다 자라요.">
                  <Input id="pet-goal" inputMode="numeric" value={draft.goal} onChange={(event) => set({ goal: event.target.value })} suffix="점" />
                </Field>
                <Field label="먹이 성장" htmlFor="pet-care" hint="먹이를 줄 때마다 더해요. 알일 때는 하루 한 번 ‘알 품어 주기’가 이 점수를 받아요.">
                  <Select id="pet-care" value={draft.careGrowth} onChange={(event) => set({ careGrowth: event.target.value })}>
                    {Array.from({ length: PET_LIMITS.careGrowth.max + 1 }, (_, i) => i).map((count) => <option key={count} value={count}>{count === 0 ? '더하지 않기' : `${count}점`}</option>)}
                  </Select>
                </Field>
                <Field label="과제 완료 성장" htmlFor="pet-task" hint="보상이 있는 과제를 완료할 때마다 더해요.">
                  <Select id="pet-task" value={draft.taskGrowth} onChange={(event) => set({ taskGrowth: event.target.value })}>
                    {Array.from({ length: PET_LIMITS.taskGrowth.max + 1 }, (_, i) => i).map((count) => <option key={count} value={count}>{count === 0 ? '더하지 않기' : `${count}점`}</option>)}
                  </Select>
                </Field>
              </div>
              <p className="text-[13px] text-[var(--theme-muted-text)]">
                알은 {fmt(starts.hatch)}점에 부화하고, {fmt(starts.young)}점에 어린 단계가 되고, {fmt(shownGoal)}점에 다 자라요. 학생 화면에는 다음 단계까지의 게이지만 보여요.
              </p>
              <section aria-labelledby="pet-estimate" className="space-y-3 rounded-[16px] bg-[var(--theme-accent-soft)] p-4">
                <h3 id="pet-estimate" className="text-sm font-black">예상 키우기 기간 <span className="text-xs font-semibold text-[var(--theme-muted-text)]">· 참고용</span></h3>
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="pet-tasks-week" className="text-sm font-semibold">학생 한 명당 일주일에 과제를 몇 개 정도 완료하나요?</label>
                  <Input id="pet-tasks-week" inputMode="numeric" value={draft.tasksPerWeek} className="w-[6.5rem]" suffix="개"
                    onChange={(event) => set({ tasksPerWeek: event.target.value })} />
                </div>
                <p className="text-[22px] font-black tracking-[-0.02em]" aria-live="polite">
                  {!estimateReady ? '숫자를 모두 넣으면 계산해요' : estimate === null ? '이 설정으로는 다 자라지 않아요' : schoolDaysEstimate(estimate)}
                </p>
                <p className="text-[13px] text-[var(--theme-muted-text)]">
                  {estimateReady && estimate !== null && hatchDays !== null ? `부화까지 평일 약 ${hatchDays}일. ` : ''}
                  학생이 평일마다 알을 품어 주고, 부화한 뒤에는 먹이를 하루 {Number.isSafeInteger(estimateInput.feedDailyLimit) ? estimateInput.feedDailyLimit : '?'}번(하루 최대)씩 주며,
                  과제를 일주일에 {Number.isSafeInteger(estimateInput.tasksPerWeek) ? estimateInput.tasksPerWeek : '?'}개 완료한다고 보고 계산했어요. 과제로 받은 먹이도 하루 횟수에 함께 세요.
                  실제로는 학생마다 달라요. 과제 수는 이 계산에만 쓰여요.
                </p>
              </section>
            </div>
          ) : null}

          {tab === 'food' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="먹이 주기 가격" htmlFor="pet-price" hint="0으로 두면 무료로 줄 수 있어요. 알 품어 주기는 항상 무료예요.">
                <Input id="pet-price" inputMode="numeric" value={draft.feedPrice} onChange={(event) => set({ feedPrice: event.target.value })} suffix={unit} />
              </Field>
              <Field label="하루에 먹이 줄 수 있는 횟수" htmlFor="pet-limit" hint="학생 한 명 기준이고, 과제를 완료해서 받은 먹이도 함께 세요. 먹이를 줄 때마다 자라니, 하루에 한 번만 자라게 하려면 1번으로 정해 주세요.">
                <Select id="pet-limit" value={draft.feedDailyLimit} onChange={(event) => set({ feedDailyLimit: event.target.value })}>
                  {Array.from({ length: PET_LIMITS.feedDailyLimit.max + 1 }, (_, i) => i).map((count) => <option key={count} value={count}>{count === 0 ? '먹이 주기 끄기' : `${count}번`}</option>)}
                </Select>
              </Field>
              <p className="text-[13px] text-[var(--theme-muted-text)] sm:col-span-2">먹이 한 번이면 방에 함께 있는 펫 모두가 나눠 먹어요. 졸업한 펫은 더 자라지 않아요.</p>
            </div>
          ) : null}

          {tab === 'hours' ? (
            <div className="space-y-4">
              <Switch checked={draft.hoursEnabled} label="이용 시간" description="이용 시간 외에는 펫이 잠들어 상호작용할 수 없어요."
                onChange={(hoursEnabled) => set({ hoursEnabled, hours: hoursEnabled && draft.hours.length === 0 ? [{ start: '', end: '' }] : draft.hours })} />
              <div className="space-y-2">
                {draft.hours.length === 0 ? <p className="text-sm text-[var(--theme-muted-text)]">넣은 시간대가 없어요.{draft.hoursEnabled ? '' : ' 이용 시간이 꺼져 있어서 언제든 펫과 놀 수 있어요.'}</p> : null}
                {draft.hours.map((span, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <Input type="time" aria-label={`이용 시간 ${index + 1} 시작`} value={span.start} disabled={!draft.hoursEnabled} className="w-[9rem]"
                      onChange={(event) => set({ hours: draft.hours.map((entry, i) => (i === index ? { ...entry, start: event.target.value } : entry)) })} />
                    <span aria-hidden="true">~</span>
                    <Input type="time" aria-label={`이용 시간 ${index + 1} 끝`} value={span.end} disabled={!draft.hoursEnabled} className="w-[9rem]"
                      onChange={(event) => set({ hours: draft.hours.map((entry, i) => (i === index ? { ...entry, end: event.target.value } : entry)) })} />
                    <Button size="sm" variant="ghost" icon="trash" disabled={!draft.hoursEnabled}
                      onClick={() => set({ hours: draft.hours.filter((_, i) => i !== index) })}>지우기</Button>
                  </div>
                ))}
              </div>
              <Button size="sm" icon="plus" disabled={!draft.hoursEnabled || draft.hours.length >= PET_LIMITS.hourSpans}
                onClick={() => set({ hours: [...draft.hours, { start: '', end: '' }] })}>시간대 더하기</Button>
              <p className="text-[13px] text-[var(--theme-muted-text)]">
                {!draft.hoursEnabled ? '꺼 두면 시간 제한 없이 언제든 펫과 놀 수 있어요.'
                  : draft.hours.some((span) => span.start && span.end)
                    ? `학생은 ${draft.hours.filter((span) => span.start && span.end).map((span) => `${span.start}~${span.end}`).join(', ')}에만 펫과 놀 수 있어요. 시간대는 여러 개 넣을 수 있어요.`
                    : '켜 두고 시간대를 하나도 넣지 않으면 학생이 아무 때도 펫과 놀 수 없어요. 시간대를 넣어 주세요.'}
              </p>
            </div>
          ) : null}

          {tab === 'grad' ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="졸업 보상 (학생 한 명에게)" htmlFor="pet-reward">
                  <Input id="pet-reward" inputMode="numeric" value={draft.rewardAmount} onChange={(event) => set({ rewardAmount: event.target.value })} suffix={unit} />
                </Field>
                <Field label="졸업 보상 아이템" htmlFor="pet-reward-product" optional
                  hint={draftRewardProduct ? (draftRewardProduct.digitalKind
                    ? `디지털 상품(${DIGITAL_KIND_LABELS[draftRewardProduct.digitalKind]})이라 졸업할 때 '${draftRewardProduct.name}' 1개를 보관함에 넣어 줘요.`
                    : `졸업할 때 '${draftRewardProduct.name} 교환권' 1장을 보관함에 넣어 줘요.`)
                    : '학급 나무 수확 보상처럼 매점 상품에서 골라요.'}>
                  <Select id="pet-reward-product" value={draft.rewardProductId} onChange={(event) => set({ rewardProductId: event.target.value })}>
                    <option value="">없음</option>
                    {board.rewardProducts.map((product) => (
                      <option key={product.productId} value={product.productId}>
                        {product.name}{product.digitalKind ? ` (디지털 ${DIGITAL_KIND_LABELS[product.digitalKind]})` : ' (교환권으로)'}{product.isActive ? '' : ' · 판매 중지'}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <p className="text-[13px] text-[var(--theme-muted-text)]">다 자라면 학생이 원할 때 ‘졸업하기’를 눌러요. 졸업한 펫은 도감에 남고, 학생은 새 알을 골라요. 방과 꾸미기 물건은 그대로예요.</p>
            </div>
          ) : null}

          {tab === 'shop' ? (
            <div className="space-y-5">
              <Switch checked={draft.shopEnabled} onChange={(shopEnabled) => set({ shopEnabled })} label="상점 열기"
                description="끄면 학생은 새 물건을 살 수 없고, 가진 물건으로만 방과 펫을 꾸며요. 꾸미기/상점은 펫 화면 안에만 있고 매점 상품 목록이나 키오스크에는 나오지 않아요. 꾸미기는 성장에 영향을 주지 않아요." />
              <p className="text-[13px] text-[var(--theme-muted-text)]">
                기본 물건은 모든 학생이 처음부터 가져요. 나머지는 정해 둔 값이 없어서, 물건마다 값을 넣어야 상점에 나와요(0을 넣으면 무료). 잠깐 팔지 않으려면 ‘팔기’만 끄면 돼요.
                펫 장식은 모든 동물에게 어울리게 자리를 잡아요.
              </p>
              <SegmentedControl ariaLabel="물건 종류" value={shopSlot} onChange={setShopSlot} size="sm"
                options={[{ value: 'all' as const, label: '전체' }, ...PET_SHOP_SLOTS.map((value) => ({ value, label: PET_SHOP_SLOT_NAMES[value] }))]} />
              {PET_SHOP_SLOTS.filter((slot) => shopSlot === 'all' || shopSlot === slot).map((slot) => (
                <section key={slot} aria-labelledby={`pet-decor-${slot}`} className="space-y-2">
                  <h3 id={`pet-decor-${slot}`} className="text-sm font-black">{PET_SHOP_SLOT_NAMES[slot]}</h3>
                  <ul className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]">
                    {PET_SHOP_ITEMS[slot].map((decor) => {
                      const key = `${slot}:${decor.id}`;
                      const entry = draft.shopPrices[key] ?? { price: '', sell: false };
                      const update = (patch: Partial<{ price: string; sell: boolean }>) => set({ shopPrices: { ...draft.shopPrices, [key]: { ...entry, ...patch } } });
                      return (
                        <li key={key} className="flex items-center gap-3 rounded-[14px] border border-[var(--crs-line)] p-2.5">
                          <span className="flex w-[76px] shrink-0 justify-center">
                            {slot === 'acc' ? (
                              <span className="rounded-[10px] bg-[var(--theme-accent-soft)]">
                                <PetPicture species="dog" stage={3} color="cream" accessory={decor.id === 'none' ? null : decor.id} size={64} crop={[2, 4, 20, 20]} />
                              </span>
                            ) : <DecorPreview room={previewRoom} slot={slot} id={decor.id} crop={ROOM.DECOR_CROP[slot]} size={76} />}
                          </span>
                          <div className="min-w-0 flex-1 space-y-1.5">
                            <p className="truncate text-sm font-bold">{decor.name}</p>
                            {decor.base ? <p className="text-xs font-semibold text-[var(--theme-muted-text)]">기본 물건 · 모든 학생이 가져요</p> : (
                              <>
                                <Input inputMode="numeric" aria-label={`${decor.name} 가격`} placeholder="값 없음" value={entry.price} disabled={!draft.shopEnabled}
                                  suffix={unit} onChange={(event) => update({ price: event.target.value, sell: entry.price.trim() === '' && event.target.value.trim() !== '' ? true : entry.sell })} />
                                <label className="flex w-fit items-center gap-2 text-[13px] font-semibold">
                                  <Checkbox checked={entry.sell && entry.price.trim() !== ''} disabled={!draft.shopEnabled || entry.price.trim() === ''}
                                    onChange={(event) => update({ sell: event.target.checked })} />
                                  팔기
                                </label>
                              </>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          ) : null}
        </div>

        {formError ? <p role="alert" className="text-sm font-semibold text-[var(--crs-danger-text)]">{formError}</p> : null}
        <div className="flex flex-wrap gap-2 border-t border-[var(--crs-line)] pt-4">
          <Button variant="primary" icon="check" onClick={() => void save()} loading={saving} disabled={saving || !dirty}>설정 저장</Button>
          {dirty ? <Button variant="ghost" onClick={() => { setDraft(toDraft(board.settings)); setFormError(''); }} disabled={saving}>되돌리기</Button> : null}
          {dirty ? <span className="self-center text-xs font-semibold text-[var(--theme-muted-text)]">저장하지 않은 바뀐 설정이 있어요.</span> : null}
        </div>
      </Card>
    </div>
  );
}

function withoutKey(record: Readonly<Record<string, string>>, key: string): Record<string, string> {
  const next = { ...record };
  delete next[key];
  return next;
}

/** 펫 목록: how every student's pet is doing, with name corrections. */
function PetList({ board, onRenamed, onAdjusted }: Readonly<{
  board: PetAdminBoardDto; onRenamed: (board: PetAdminBoardDto, name: string) => void; onAdjusted: (board: PetAdminBoardDto, message: string) => void;
}>) {
  const [adjusting, setAdjusting] = useState<Readonly<{ studentId: string; opener: HTMLElement }> | null>(null);
  const [sort, setSort] = useState<Sort>('growth');
  const [names, setNames] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState('');
  const goal = board.goal;
  const raising = board.students.filter((row) => row.pet);
  const cared = raising.filter((row) => row.caresToday > 0);
  const waiting = raising.filter((row) => row.pet && row.pet.stage === 3 && row.pet.growth >= goal);
  const graduated = board.students.reduce((sum, row) => sum + row.graduations, 0);
  const progress = (row: PetAdminStudentDto) => (row.pet ? row.pet.stage + Math.min(row.pet.growth, goal) / goal : -1);
  const rows = [...board.students].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name, 'ko')
    : sort === 'care' ? ((a.pet && a.caresToday === 0 ? 0 : 1) - (b.pet && b.caresToday === 0 ? 0 : 1)) || progress(b) - progress(a)
      : progress(b) - progress(a)));

  function nameField(row: PetAdminStudentDto, width: string) {
    const pet = row.pet;
    if (!pet) return null;
    const typed = names[row.studentId];
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Input aria-label={`${row.name}의 펫 이름`} value={typed ?? pet.name} maxLength={PET_NAME_LENGTH} className={width}
          onChange={(event) => setNames((current) => ({ ...current, [row.studentId]: event.target.value }))}
          onKeyDown={(event) => { if (event.key === 'Enter') void rename(row); }} />
        {typed !== undefined && typed !== pet.name ? (
          <Button size="sm" variant="primary" className="shrink-0" onClick={() => void rename(row)} loading={renaming === row.studentId} disabled={renaming !== null}>고치기</Button>
        ) : null}
      </span>
    );
  }

  function growthCell(row: PetAdminStudentDto) {
    const pet = row.pet;
    if (!pet) return null;
    const value = Math.min(pet.growth, goal);
    return (
      <span className="flex min-w-0 items-center gap-2">
        <span className="grid min-w-[7.5rem] flex-1 gap-1 text-xs tabular-nums">
          <span>성장 {fmt(pet.growth)}/{fmt(goal)}{pet.stage === 3 && pet.growth >= goal ? <span className="ml-1.5 rounded-full border border-[var(--theme-accent-text)] px-1.5 text-[var(--theme-accent-text)]">졸업 기다림</span> : null}</span>
          <span className="block h-1.5 overflow-hidden rounded-full bg-[var(--crs-subtle-hover)]">
            <span className="block h-full rounded-full bg-[var(--theme-accent-text)]" style={{ width: `${Math.floor((value / goal) * 100)}%` }} />
          </span>
        </span>
        <Button size="sm" variant="secondary" icon="sliders" className="shrink-0" aria-label={`${row.name}의 펫 성장 조정`}
          onClick={(event) => setAdjusting({ studentId: row.studentId, opener: event.currentTarget })}>조정</Button>
      </span>
    );
  }

  const adjustRow = adjusting ? board.students.find((row) => row.studentId === adjusting.studentId) ?? null : null;

  const todayLabel = (row: PetAdminStudentDto) => (!row.pet ? '—' : row.pet.stage === 0 ? (row.caresToday > 0 ? '알 품어 줌' : '아직 안 품음')
    : row.caresToday > 0 ? `먹이 ${row.caresToday}번` : '아직 안 줌');

  async function rename(row: PetAdminStudentDto) {
    const pet = row.pet;
    const typed = names[row.studentId];
    if (!pet || typed === undefined) return;
    const name = cleanPetName(typed);
    if (name === null) { setError(`이름은 1~${PET_NAME_LENGTH}자로 적어 주세요.`); return; }
    if (name === pet.name) { setNames((current) => withoutKey(current, row.studentId)); return; }
    setRenaming(row.studentId);
    setError('');
    const result = await renamePet(pet.petId, name);
    setRenaming(null);
    if (!result.ok) { setError(result.error); return; }
    setNames((current) => withoutKey(current, row.studentId));
    onRenamed(result.data, name);
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="키우는 학생" icon="paw" value={`${raising.length}명`} hint={`전체 ${board.students.length}명 · 알 고르기 전 ${board.students.length - raising.length}명`} />
        <StatCard label="오늘 돌본 학생" icon="check" value={`${cared.length}명`} hint={`아직 안 돌봄 ${raising.length - cared.length}명`} />
        <StatCard label="졸업 기다리는 펫" icon="gift" value={`${waiting.length}마리`} hint="학생이 졸업시키면 돼요" />
        <StatCard label="지금까지 졸업" icon="package" value={`${graduated}마리`} hint="도감에 남은 펫" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="pet-sort" className="text-sm font-bold">정렬</label>
        <Select id="pet-sort" value={sort} onChange={(event) => setSort(event.target.value as Sort)} className="w-auto">
          <option value="growth">성장 높은 순</option>
          <option value="care">오늘 안 돌본 학생 먼저</option>
          <option value="name">학생 이름순</option>
        </Select>
      </div>
      {error ? <p role="alert" className="text-sm font-semibold text-[var(--crs-danger-text)]">{error}</p> : null}

      {/* Phones: one card per student, the name field as wide as the card. */}
      <ul className="grid gap-2 sm:hidden">
        {rows.map((row) => {
          const pet = row.pet;
          return (
            <li key={row.studentId} className="rounded-[14px] border border-[var(--crs-line)] p-3">
              <div className="flex items-center gap-3">
                {pet ? <PetPicture species={pet.species} stage={pet.stage} color={pet.color} accessory={pet.accessory} size={44} />
                  : <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--crs-subtle-hover)] text-[var(--theme-muted-text)]"><Icon name="paw" size={20} /></span>}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{row.name}<span className="ml-1.5 text-xs font-normal text-[var(--theme-muted-text)]">{row.studentId}</span></p>
                  <p className="truncate text-xs font-semibold text-[var(--theme-muted-text)]">{pet ? petTitle(pet) : '알 고르기 전'} · 졸업 {row.graduations}마리</p>
                </div>
              </div>
              {pet ? (
                <div className="mt-2.5 space-y-2">
                  {nameField(row, 'w-full')}
                  {growthCell(row)}
                  <p className={cx('text-xs font-semibold', row.caresToday === 0 ? 'text-[var(--theme-accent-text)]' : 'text-[var(--theme-muted-text)]')}>
                    오늘 {todayLabel(row)} · 최근 7일 {row.caredDays7}일
                  </p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-[var(--crs-line)] text-left text-xs font-bold text-[var(--theme-muted-text)]">
              <th className="py-2 pr-3">학생</th><th className="py-2 pr-3">펫</th><th className="py-2 pr-3">이름</th><th className="py-2 pr-3">성장</th>
              <th className="py-2 pr-3">오늘</th><th className="py-2 pr-3 text-right">최근 7일</th><th className="py-2 text-right">졸업</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const pet = row.pet;
              return (
                <tr key={row.studentId} className="border-b border-[var(--crs-line)] last:border-0">
                  <td className="py-2 pr-3 font-semibold">{row.name}<span className="ml-1.5 text-xs font-normal text-[var(--theme-muted-text)]">{row.studentId}</span></td>
                  <td className="py-2 pr-3">
                    {pet ? (
                      <span className="inline-flex items-center gap-2">
                        <PetPicture species={pet.species} stage={pet.stage} color={pet.color} accessory={pet.accessory} size={36} />
                        <span className="whitespace-nowrap">{petTitle(pet)}</span>
                      </span>
                    ) : <span className="text-[var(--theme-muted-text)]">알 고르기 전</span>}
                  </td>
                  <td className="py-2 pr-3">{pet ? nameField(row, 'w-full min-w-[6rem] max-w-[9rem]') : '—'}</td>
                  <td className="py-2 pr-3">{pet ? growthCell(row) : '—'}</td>
                  <td className={cx('py-2 pr-3 whitespace-nowrap', pet && row.caresToday === 0 ? 'font-bold text-[var(--theme-accent-text)]' : '')}>{pet ? todayLabel(row) : '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{pet ? `${row.caredDays7}일` : '—'}</td>
                  <td className="py-2 text-right tabular-nums">{row.graduations}마리</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {adjustRow?.pet && adjusting ? (
        <PetGrowthDialog row={adjustRow} goal={goal} opener={adjusting.opener} onClose={() => setAdjusting(null)}
          onDone={(next, message) => { setAdjusting(null); onAdjusted(next, message); }} />
      ) : null}
      <p className="text-xs text-[var(--theme-muted-text)]">펫 이름은 학생이 알을 고를 때 지어요. 알맞지 않은 이름은 여기서 고칠 수 있어요(1~{PET_NAME_LENGTH}자). ‘최근 7일’은 먹이를 주거나 알을 품어 준 날 수예요.</p>
    </div>
  );
}

const ADJUST_STEPS = [1, 5, 10] as const;

/**
 * 성장 조정: the teacher adds growth to one student's pet or takes some away. The new total and the
 * stage it leads to show before anything is saved. A hatched pet never turns back into an egg.
 */
function PetGrowthDialog({ row, goal, opener, onClose, onDone }: Readonly<{
  row: PetAdminStudentDto; goal: number; opener: HTMLElement; onClose: () => void; onDone: (board: PetAdminBoardDto, message: string) => void;
}>) {
  const pet = row.pet as NonNullable<PetAdminStudentDto['pet']>;
  const [amountText, setAmountText] = useState('5');
  const [busy, setBusy] = useState<'add' | 'remove' | null>(null);
  const [error, setError] = useState('');
  const pending = useRef<{ key: string; id: string } | null>(null);
  const amount = /^\d+$/u.test(amountText.trim()) ? Number(amountText.trim()) : Number.NaN;
  const valid = Number.isSafeInteger(amount) && amount >= 1 && amount <= 100_000;
  const stageTitle = (stage: number) => petTitle({ ...pet, stage: stage as 0 | 1 | 2 | 3 });
  const plus = valid ? pet.growth + amount : pet.growth;
  const minus = valid ? Math.max(0, pet.growth - amount) : pet.growth;
  const plusStage = Math.max(pet.stage, petStageFor(plus, goal));
  const minusStage = Math.max(pet.stage > 0 ? 1 : 0, petStageFor(minus, goal));

  async function apply(direction: 'add' | 'remove') {
    if (!valid || busy) return;
    const signed = direction === 'add' ? amount : -amount;
    const key = `${pet.petId}:${signed}`;
    // A resend after a lost answer reuses the same operation, so it is never applied twice.
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    setBusy(direction); setError('');
    const result = await adjustPetGrowth({ operationId: pending.current.id, petId: pet.petId, amount: signed });
    setBusy(null);
    if (!result.ok) { if (result.status !== 0) pending.current = null; setError(result.error); return; }
    pending.current = null;
    const after = result.data.students.find((entry) => entry.studentId === row.studentId)?.pet;
    onDone(result.data, `${row.name}의 펫 '${pet.name}' 성장을 ${direction === 'add' ? `${fmt(amount)}점 더했어요` : `${fmt(pet.growth - (after?.growth ?? minus))}점 뺐어요`}. 지금 ${fmt(after?.growth ?? (direction === 'add' ? plus : minus))}점이에요.`);
  }

  return (
    <Modal title="펫 성장 조정" size="sm" opener={opener} onClose={onClose} busy={busy !== null}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy !== null}>닫기</Button>
        <Button variant="secondary" icon="minus" onClick={() => void apply('remove')} loading={busy === 'remove'}
          disabled={!valid || busy !== null || pet.growth === 0}>빼기{valid ? ` −${fmt(amount)}` : ''}</Button>
        <Button variant="primary" icon="plus" onClick={() => void apply('add')} loading={busy === 'add'}
          disabled={!valid || busy !== null}>더하기{valid ? ` +${fmt(amount)}` : ''}</Button>
      </>}>
      <div className="flex items-center gap-3">
        <span className="shrink-0 rounded-[14px] bg-[var(--theme-accent-soft)] p-1">
          <PetPicture species={pet.species} stage={pet.stage} color={pet.color} accessory={pet.accessory} size={56}
            crop={pet.stage === 0 ? [6, 11, 12, 12] : [2, 4, 20, 20]} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-black">{pet.name} <span className="text-xs font-semibold text-[var(--theme-muted-text)]">{row.name}</span></p>
          <p className="text-sm font-semibold tabular-nums text-[var(--theme-muted-text)]">{stageTitle(pet.stage)} · 성장 {fmt(pet.growth)}/{fmt(goal)}</p>
        </div>
      </div>
      <Field label="바꿀 성장" htmlFor="pet-adjust-amount" className="mt-4">
        <div className="flex items-center gap-2">
          <IconButton icon="minus" label="1 줄이기" variant="secondary" disabled={!valid || amount <= 1} onClick={() => setAmountText(String(Math.max(1, amount - 1)))} />
          <Input id="pet-adjust-amount" inputMode="numeric" value={amountText} className="w-[7rem] text-center" suffix="점"
            onChange={(event) => setAmountText(event.target.value)} />
          <IconButton icon="plus" label="1 늘리기" variant="secondary" disabled={valid && amount >= 100_000} onClick={() => setAmountText(String(valid ? amount + 1 : 1))} />
        </div>
      </Field>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="자주 쓰는 값">
        {ADJUST_STEPS.map((step) => (
          <Button key={step} size="sm" variant={amount === step ? 'primary' : 'ghost'} onClick={() => setAmountText(String(step))}>{step}점</Button>
        ))}
      </div>
      {valid ? (
        <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-[14px] bg-[var(--crs-subtle-hover)] p-3 text-sm">
          <dt className="font-bold">더하면</dt>
          <dd className="tabular-nums">{fmt(plus)}점 · {stageTitle(plusStage)}{plusStage > pet.stage ? ' (자라요)' : ''}</dd>
          <dt className="font-bold">빼면</dt>
          <dd className="tabular-nums">{fmt(minus)}점 · {stageTitle(minusStage)}{minusStage < pet.stage ? ' (단계가 내려가요)' : ''}</dd>
        </dl>
      ) : <p className="mt-3 text-sm font-semibold text-[var(--crs-danger-text)]">1~100,000 사이의 숫자로 적어 주세요.</p>}
      <p className="mt-3 text-xs text-[var(--theme-muted-text)]">학생 화면에 바로 반영돼요. 0점 아래로는 줄지 않고, 부화한 펫은 알로 돌아가지 않아요.</p>
      {error ? <p role="alert" className="mt-2 text-sm font-semibold text-[var(--crs-danger-text)]">{error}</p> : null}
    </Modal>
  );
}
