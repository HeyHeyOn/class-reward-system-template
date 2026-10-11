'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CLASS_TREE_LIMITS,
  CLASS_TREE_STAGES,
  classTreeEstimateDays,
  classTreeLook,
  parseClassTreeSettings,
  DEFAULT_TREE_NAME,
  TREE_NAME_LENGTH,
  type ClassTreeSettings,
} from '@/domain/classTree';
import type { ClassTreeAdminBoardDto } from '@/lib/classTreeApi';
import { schoolDaysEstimate } from '@/domain/schoolDays';
import { withParticle } from '@/lib/koreanParticle';
import { DIGITAL_KIND_LABELS } from '@/lib/studentBagApi';
import { Button, Callout, Card, CardHeader, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, StatCard, Switch } from '../ui';
import { TreeCanvas, treePercent, type TreePlay } from './TreeCanvas';
import { fetchClassTreeBoard, giveClassFeed, harvestTree, saveClassTreeSettings } from './classTreeClient';

type Draft = Readonly<{
  enabled: boolean; waterPrice: string; waterDailyLimit: string; taskDrops: string; goal: string; tasksPerWeek: string;
  rewardAmount: string; rewardProductId: string; treeName: string;
}>;

const toDraft = (settings: ClassTreeSettings): Draft => ({
  enabled: settings.enabled,
  waterPrice: String(settings.waterPrice),
  waterDailyLimit: String(settings.waterDailyLimit),
  taskDrops: String(settings.taskDrops),
  goal: String(settings.goal),
  tasksPerWeek: String(settings.tasksPerWeek),
  rewardAmount: String(settings.rewardAmount),
  rewardProductId: settings.rewardProductId ?? '',
  treeName: settings.treeName,
});

const wholeOrNaN = (text: string) => (/^\d+$/u.test(text.trim()) ? Number(text.trim()) : Number.NaN);

function fromDraft(draft: Draft, enabled = draft.enabled) {
  return parseClassTreeSettings({
    enabled,
    waterPrice: wholeOrNaN(draft.waterPrice),
    waterDailyLimit: wholeOrNaN(draft.waterDailyLimit),
    taskDrops: wholeOrNaN(draft.taskDrops),
    goal: wholeOrNaN(draft.goal),
    tasksPerWeek: wholeOrNaN(draft.tasksPerWeek),
    rewardAmount: wholeOrNaN(draft.rewardAmount),
    rewardProductId: draft.rewardProductId || null,
    treeName: draft.treeName,
  });
}

const fmt = (value: number) => value.toLocaleString('ko-KR');
const dateLabel = (iso: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' }).format(new Date(iso));

/** The teacher's class apple tree: settings, classFeed, harvest, who helped, and the coupons given out. */
export function ClassTreePanel({ unit, notify }: Readonly<{ unit: string; notify: (message: string) => void }>) {
  const [board, setBoard] = useState<ClassTreeAdminBoardDto | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [feedAmount, setFeedAmount] = useState('');
  const [feedNote, setFeedNote] = useState('');
  const [feedBusy, setFeedBusy] = useState<'add' | 'remove' | null>(null);
  const [actionError, setActionError] = useState('');
  const [harvestOpen, setHarvestOpen] = useState<HTMLElement | null>(null);
  const [harvesting, setHarvesting] = useState(false);
  const [play, setPlay] = useState<TreePlay | null>(null);
  const pendingFeed = useRef<{ key: string; id: string } | null>(null);
  const pendingHarvest = useRef<string | null>(null);

  const applyBoard = useCallback((next: ClassTreeAdminBoardDto, resetDraft: boolean) => {
    setBoard(next);
    if (resetDraft) setDraft(toDraft(next.settings));
    setFeedAmount((current) => current || String(Math.max(1, next.activeStudents)));
  }, []);

  const load = useCallback(async (resetDraft: boolean) => {
    setLoading(true);
    const result = await fetchClassTreeBoard();
    setLoading(false);
    if (result.ok) { setLoadError(''); applyBoard(result.data, resetDraft); }
    else setLoadError(result.error);
  }, [applyBoard]);

  useEffect(() => { void Promise.resolve().then(() => load(true)); }, [load]);

  const dirty = Boolean(board && draft && JSON.stringify(toDraft(board.settings)) !== JSON.stringify(draft));

  async function save(enabled?: boolean) {
    if (!draft) return;
    const checked = fromDraft(draft, enabled ?? draft.enabled);
    if (!checked.ok) { setFormError(checked.error); return; }
    setSaving(true);
    setFormError('');
    const result = await saveClassTreeSettings(checked.settings);
    setSaving(false);
    if (!result.ok) { setFormError(result.error); return; }
    const wasOff = !board?.tree;
    applyBoard(result.data, true);
    notify(checked.settings.enabled && wasOff && result.data.tree ? `${withParticle(checked.settings.treeName, '을/를')} 심었어요. 학생 은행 화면에 나무가 보여요.` : '나무 키우기 설정을 저장했어요.');
  }

  /** 양분 조정: drops for the whole class (a class-wide praise), or drops taken away. */
  async function classFeed(direction: 'add' | 'remove') {
    const amount = wholeOrNaN(feedAmount);
    if (!Number.isSafeInteger(amount) || amount < CLASS_TREE_LIMITS.classFeedDrops.min || amount > CLASS_TREE_LIMITS.classFeedDrops.max) {
      setActionError(`조정할 양분은 1~${fmt(CLASS_TREE_LIMITS.classFeedDrops.max)} 사이로 적어 주세요.`);
      return;
    }
    const signed = direction === 'add' ? amount : -amount;
    const key = `${signed}:${feedNote}`;
    // A resend after a lost answer reuses the same operation, so it is never applied twice.
    if (pendingFeed.current?.key !== key) pendingFeed.current = { key, id: crypto.randomUUID() };
    setFeedBusy(direction);
    setActionError('');
    const before = board?.tree ? { drops: board.tree.drops, goal: board.tree.goal, apples: board.activeStudents } : null;
    const result = await giveClassFeed({ operationId: pendingFeed.current.id, amount: signed, note: feedNote });
    setFeedBusy(null);
    if (result.ok) {
      pendingFeed.current = null;
      const applied = result.data.result.amount;
      if (before && applied > 0) setPlay({ key: Date.now(), kind: 'classFeed', before, amount: applied });
      applyBoard(result.data.board, false);
      setFeedNote('');
      notify(applied > 0 ? `반 전체에 양분을 ${fmt(applied)}만큼 줬어요.` : `양분을 ${fmt(-applied)}만큼 뺐어요. 지금 ${fmt(result.data.result.drops)}이에요.`);
      return;
    }
    if (result.status !== 0) pendingFeed.current = null;
    setActionError(result.error);
  }

  async function harvest() {
    if (!board?.tree) return;
    const operationId = pendingHarvest.current ?? crypto.randomUUID();
    pendingHarvest.current = operationId;
    setHarvesting(true);
    setActionError('');
    const full = { drops: board.tree.drops, goal: board.tree.goal, apples: board.activeStudents };
    const result = await harvestTree({ operationId, treeNo: board.tree.treeNo });
    setHarvesting(false);
    if (result.ok) {
      pendingHarvest.current = null;
      setHarvestOpen(null);
      setPlay({ key: Date.now(), kind: 'harvest', before: full, amount: 0 });
      applyBoard(result.data.board, false);
      const { recipients } = result.data.result;
      notify(`${withParticle(result.data.board.settings.treeName, '을/를')} 수확했어요! 학생 ${recipients}명에게 보상을 줬고, 새 씨앗을 심었어요.`);
      return;
    }
    if (result.status !== 0) pendingHarvest.current = null;
    setHarvestOpen(null);
    setActionError(result.error);
    if (result.status === 409) void load(false);
  }

  if (!board || !draft) {
    return (
      <div className="space-y-6">
        <PageHeader title="나무 키우기" description="학생들이 함께 양분을 주어 나무를 키우고, 열매가 다 익으면 반 전체가 보상을 받아요." />
        {loadError ? (
          <Callout tone="danger" title="불러오지 못했어요">
            <p>{loadError}</p>
            <Button className="mt-3" size="sm" variant="secondary" icon="refresh" onClick={() => void load(true)}>다시 불러오기</Button>
          </Callout>
        ) : <div role="status" className="flex items-center gap-2 text-sm font-semibold text-[var(--theme-muted-text)]"><Spinner size={18} />불러오는 중이에요.</div>}
      </div>
    );
  }

  const tree = board.tree;
  const look = tree ? classTreeLook(tree.drops, tree.goal, board.activeStudents) : null;
  const settings = board.settings;
  const productById = new Map(board.rewardProducts.map((product) => [product.productId, product]));
  const rewardTitle = (productId: string | null | undefined) => {
    const product = productId ? productById.get(productId) : undefined;
    return product ? (product.digitalKind ? product.name : `${product.name} 교환권`) : '';
  };
  const rewardItem = rewardTitle(settings.rewardProductId);
  const draftRewardProduct = draft.rewardProductId ? productById.get(draft.rewardProductId) ?? null : null;
  const set = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  return (
    <div className="space-y-6">
      <PageHeader title="나무 키우기" description="학생들이 함께 양분을 주어 나무를 키우고, 열매가 다 익으면 반 전체가 보상을 받아요."
        actions={<Button variant="secondary" size="sm" icon="refresh" onClick={() => void load(!dirty)} disabled={loading}>새로고침</Button>} />

      {actionError ? <div role="alert"><Callout tone="danger">{actionError}</Callout></div> : null}

      {!settings.enabled && !tree ? (
        <Card>
          <EmptyState icon="sprout" title="아직 학급 나무를 심지 않았어요"
            description="아래에서 이름과 목표 양분, 보상을 정하고 시작하면 씨앗이 심어져요. 학생들은 은행 화면에서 양분을 주고, 과제를 완료해도 양분이 쌓여요."
            action={<Button variant="primary" icon="sprout" onClick={() => void save(true)} loading={saving} disabled={saving}>학급 나무 시작하기</Button>} />
        </Card>
      ) : null}

      {tree && look ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card className="flex flex-col items-center gap-4">
            <div className="w-full rounded-[20px] bg-[var(--theme-accent-soft)] p-3">
              <div className="flex justify-center"><TreeCanvas drops={tree.drops} goal={tree.goal} apples={board.activeStudents} size={320} play={play} onPlayEnd={() => setPlay(null)} name={settings.treeName} /></div>
            </div>
            <div className="w-full">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[20px] font-black tracking-[-0.02em]">{settings.treeName} · {CLASS_TREE_STAGES[look.stage]}</span>
                <span className="text-sm font-bold tabular-nums text-[var(--theme-muted-text)]">{treePercent(tree.drops, tree.goal)}%</span>
              </div>
              <span role="progressbar" aria-label="양분 진행" aria-valuemin={0} aria-valuemax={tree.goal} aria-valuenow={Math.min(tree.drops, tree.goal)}
                className="mt-2 block h-3 overflow-hidden rounded-full bg-[var(--theme-accent-soft)]">
                <span className="block h-full rounded-full bg-[var(--theme-accent-solid)]" style={{ width: `${treePercent(tree.drops, tree.goal)}%` }} />
              </span>
              <p className="mt-2 text-[13px] text-[var(--theme-muted-text)]">{dateLabel(tree.startedAt)}에 심었어요.{settings.enabled ? '' : ' 지금은 꺼 두어서 학생 화면에 보이지 않아요.'}</p>
            </div>
          </Card>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <StatCard label="양분" icon="sprout" value={fmt(tree.drops)} hint={`목표 ${fmt(tree.goal)}`} />
              <StatCard label="오늘 양분 준 학생" icon="users" value={`${board.waterersToday}명`} hint={`전체 ${board.activeStudents}명`} />
            </div>

            {look.ready ? (
              <Card className="space-y-3">
                <CardHeader title="열매가 다 익었어요!" description={`수확하면 학생 ${board.activeStudents}명 모두에게 보상을 주고 새 씨앗을 심어요.`} />
                <p className="text-sm font-semibold">
                  보상: {settings.rewardAmount > 0 ? `${fmt(settings.rewardAmount)}${unit}` : '화폐 없음'}{rewardItem ? ` + ${rewardItem}` : ''}
                </p>
                <Button variant="primary" size="lg" block icon="gift" onClick={(event) => setHarvestOpen(event.currentTarget)} disabled={!settings.enabled}>수확하기</Button>
                {!settings.enabled ? <p className="text-xs text-[var(--theme-muted-text)]">학급 나무를 켜야 수확할 수 있어요.</p> : null}
              </Card>
            ) : null}
            <TreeAdjustCard tree={tree} activeStudents={board.activeStudents} amount={feedAmount} note={feedNote} busy={feedBusy}
              enabled={settings.enabled} adjustedTotal={board.classFeedTotal} onAmount={setFeedAmount} onNote={setFeedNote}
              onApply={(direction) => void classFeed(direction)} />
          </div>
        </div>
      ) : null}

      <Card className="space-y-5">
        <CardHeader title="키우기 설정" description="목표 양분은 선생님이 정해요. 아래에서 예상 키우기 기간을 참고할 수 있어요. 보상은 수확할 때의 설정으로 줘요." />
        {tree || settings.enabled ? (
          <Switch checked={draft.enabled} onChange={(enabled) => set({ enabled })} label="학생 화면에 학급 나무 보이기"
            description="끄면 학생들은 나무를 볼 수 없고 양분도 쌓이지 않아요. 지금까지 쌓인 양분은 그대로 남아요." />
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="나무 이름" htmlFor="tree-name" className="sm:col-span-2"
            hint={`학생 은행 화면에 이 이름으로 보여요. ${TREE_NAME_LENGTH}자까지 쓸 수 있어요.`}>
            <Input id="tree-name" value={draft.treeName} maxLength={TREE_NAME_LENGTH} placeholder={DEFAULT_TREE_NAME}
              onChange={(event) => set({ treeName: event.target.value })} />
          </Field>
          <Field label="목표 양분" htmlFor="tree-goal" hint="양분이 이만큼 쌓이면 열매가 다 익어요. 바꾸면 지금 자라는 나무에도 바로 적용돼요.">
            <Input id="tree-goal" inputMode="numeric" value={draft.goal} onChange={(event) => set({ goal: event.target.value })} suffix="개" />
          </Field>
          <Field label="양분 주기 가격" htmlFor="tree-price" hint="0으로 두면 무료로 줄 수 있어요.">
            <Input id="tree-price" inputMode="numeric" value={draft.waterPrice} onChange={(event) => set({ waterPrice: event.target.value })} suffix={unit} />
          </Field>
          <Field label="하루에 양분 줄 수 있는 횟수" htmlFor="tree-limit" hint="학생이 나무 화면에서 직접 주는 양분만 세요. 과제를 완료해서 받는 양분은 횟수 제한이 없어요.">
            <Select id="tree-limit" value={draft.waterDailyLimit} onChange={(event) => set({ waterDailyLimit: event.target.value })}>
              {Array.from({ length: 11 }, (_, i) => i).map((count) => <option key={count} value={count}>{count === 0 ? '양분 주기 끄기' : `${count}번`}</option>)}
            </Select>
          </Field>
          <Field label="과제 완료 양분" htmlFor="tree-task" hint="보상이 있는 과제를 완료할 때마다 더해요.">
            <Select id="tree-task" value={draft.taskDrops} onChange={(event) => set({ taskDrops: event.target.value })}>
              {Array.from({ length: 11 }, (_, i) => i).map((count) => <option key={count} value={count}>{count === 0 ? '더하지 않기' : `${count}개`}</option>)}
            </Select>
          </Field>
          <Field label="수확 보상 (학생 한 명에게)" htmlFor="tree-reward">
            <Input id="tree-reward" inputMode="numeric" value={draft.rewardAmount} onChange={(event) => set({ rewardAmount: event.target.value })} suffix={unit} />
          </Field>
          <Field label="수확 보상 아이템" htmlFor="tree-reward-product" optional className="sm:col-span-2"
            hint={draftRewardProduct ? (draftRewardProduct.digitalKind
              ? `디지털 상품(${DIGITAL_KIND_LABELS[draftRewardProduct.digitalKind]})이라 수확할 때 학생마다 '${draftRewardProduct.name}' 1개를 보관함에 넣어 줘요.`
              : `수확할 때 학생마다 '${draftRewardProduct.name} 교환권' 1장을 보관함에 넣어 줘요. 매점에서 이 상품을 살 때 쓸 수 있어요.`)
              : '매점에 등록된 상품 중에서 골라요. 디지털 상품은 그대로, 다른 상품은 교환권으로 보관함에 들어가요.'}>
            <Select id="tree-reward-product" value={draft.rewardProductId} onChange={(event) => set({ rewardProductId: event.target.value })}>
              <option value="">없음</option>
              {board.rewardProducts.map((product) => (
                <option key={product.productId} value={product.productId}>
                  {product.name}{product.digitalKind ? ` (디지털 ${DIGITAL_KIND_LABELS[product.digitalKind]})` : ' (교환권으로)'}{product.isActive ? '' : ' · 판매 중지'}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <TreeEstimate draft={draft} activeStudents={board.activeStudents} drops={tree?.drops ?? null} onTasks={(tasksPerWeek) => set({ tasksPerWeek })} />
        {formError ? <p role="alert" className="text-sm font-semibold text-[var(--crs-danger-text)]">{formError}</p> : null}
        <div className="flex flex-wrap gap-2">
          {tree || settings.enabled ? (
            <Button variant="primary" icon="check" onClick={() => void save()} loading={saving} disabled={saving || !dirty}>설정 저장</Button>
          ) : (
            <Button variant="primary" icon="sprout" onClick={() => void save(true)} loading={saving} disabled={saving}>이 설정으로 시작하기</Button>
          )}
          {dirty ? <Button variant="ghost" onClick={() => { setDraft(toDraft(board.settings)); setFormError(''); }} disabled={saving}>되돌리기</Button> : null}
        </div>
      </Card>

      {tree ? (
        <Card className="space-y-3">
          <CardHeader title="함께 키운 학생" description={`${settings.treeName}에 양분을 보탠 기록이에요. ‘오늘 양분’에는 과제를 완료해서 준 양분도 함께 세요(괄호 안은 그중 과제). 학생 화면에는 순위를 보여 주지 않아요.`} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="border-b border-[var(--crs-line)] text-left text-xs font-bold text-[var(--theme-muted-text)]">
                  <th className="py-2 pr-3">학생</th><th className="py-2 pr-3 text-right">양분 주기</th><th className="py-2 pr-3 text-right">과제</th>
                  <th className="py-2 pr-3 text-right">합계</th><th className="py-2 text-right">오늘 양분</th>
                </tr>
              </thead>
              <tbody>
                {board.contributions.map((row) => (
                  <tr key={row.studentId} className="border-b border-[var(--crs-line)] last:border-0">
                    <td className="py-2 pr-3 font-semibold">{row.name}<span className="ml-1.5 text-xs font-normal text-[var(--theme-muted-text)]">{row.studentId}</span></td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmt(row.water)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmt(row.task)}</td>
                    <td className="py-2 pr-3 text-right font-bold tabular-nums">{fmt(row.total)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {row.waterToday + row.taskToday > 0 ? `${row.waterToday + row.taskToday}번${row.taskToday > 0 ? ` (과제 ${row.taskToday})` : ''}` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {board.harvests.length > 0 ? (
        <Card className="space-y-3">
          <CardHeader title="수확 기록" />
          <ul className="divide-y divide-[var(--crs-line)]">
            {board.harvests.map((harvest) => (
              <li key={harvest.treeNo} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5 text-sm">
                <span className="font-bold">{dateLabel(harvest.harvestedAt)} 수확</span>
                <span className="text-[var(--theme-muted-text)]">
                  {dateLabel(harvest.startedAt)}부터 키움 · 학생 {harvest.recipients}명 ·
                  {harvest.rewardAmount > 0 ? ` ${fmt(harvest.rewardAmount)}${unit}` : ' 화폐 없음'}{harvest.rewardItem ? ` + ${harvest.rewardItem}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {harvestOpen && tree ? (
        <Modal title={`${withParticle(settings.treeName, '을/를')} 수확할까요?`} onClose={() => { if (!harvesting) setHarvestOpen(null); }} busy={harvesting} opener={harvestOpen} size="sm"
          footer={<>
            <Button variant="ghost" onClick={() => setHarvestOpen(null)} disabled={harvesting}>취소</Button>
            <Button variant="primary" icon="gift" onClick={() => void harvest()} loading={harvesting} disabled={harvesting}>수확하기</Button>
          </>}>
          <p className="text-sm leading-relaxed">
            학생 {board.activeStudents}명에게 줄 보상: {[
              settings.rewardAmount > 0 ? `${fmt(settings.rewardAmount)}${unit}` : '',
              rewardItem,
            ].filter(Boolean).join(', ') || '없음(축하만 해요)'}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-[var(--theme-muted-text)]">
            수확하면 새 씨앗을 심고 처음부터 다시 키워요. 수확한 뒤에는 되돌릴 수 없어요.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

/** 예상 키우기 기간: what the settings typed so far mean in school days, for the teacher's reference only. */
function TreeEstimate({ draft, activeStudents, drops, onTasks }: Readonly<{
  draft: Draft; activeStudents: number; drops: number | null; onTasks: (tasksPerWeek: string) => void;
}>) {
  const input = {
    goal: wholeOrNaN(draft.goal), tasksPerWeek: wholeOrNaN(draft.tasksPerWeek),
    waterDailyLimit: wholeOrNaN(draft.waterDailyLimit), taskDrops: wholeOrNaN(draft.taskDrops),
  };
  const ready = Object.values(input).every((value) => Number.isSafeInteger(value)) && input.goal >= 1;
  const days = ready ? classTreeEstimateDays(input, activeStudents) : null;
  const left = ready && drops !== null ? classTreeEstimateDays(input, activeStudents, drops) : null;
  return (
    <section aria-labelledby="tree-estimate" className="space-y-3 rounded-[16px] bg-[var(--theme-accent-soft)] p-4">
      <h3 id="tree-estimate" className="text-sm font-black">예상 키우기 기간 <span className="text-xs font-semibold text-[var(--theme-muted-text)]">· 참고용</span></h3>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="tree-tasks-week" className="text-sm font-semibold">학생 한 명당 일주일에 과제를 몇 개 정도 완료하나요?</label>
        <Input id="tree-tasks-week" inputMode="numeric" value={draft.tasksPerWeek} className="w-[6.5rem]" suffix="개" onChange={(event) => onTasks(event.target.value)} />
      </div>
      <p className="text-[22px] font-black tracking-[-0.02em]" aria-live="polite">
        {!ready ? '숫자를 모두 넣으면 계산해요' : days === null ? '이 설정으로는 열매가 익지 않아요' : schoolDaysEstimate(days)}
      </p>
      <p className="text-[13px] text-[var(--theme-muted-text)]">
        {left !== null && drops !== null && drops > 0 ? `지금 자라는 나무는 평일 약 ${left}일 뒤에 다 익어요. ` : ''}
        학생 {activeStudents}명이 평일마다 양분을 하루 {Number.isSafeInteger(input.waterDailyLimit) ? input.waterDailyLimit : '?'}번(하루 최대)씩 주고,
        과제를 일주일에 {Number.isSafeInteger(input.tasksPerWeek) ? input.tasksPerWeek : '?'}개 완료한다고 보고 계산했어요. 과제로 받는 양분은 하루 횟수와 상관없이 더해져요. 선생님이 조정한 양분은 빼고 셌어요.
        과제 수는 이 계산에만 쓰여요.
      </p>
    </section>
  );
}

/**
 * 양분 조정: the teacher adds drops for the whole class (a class-wide praise) or takes drops away.
 * The resulting drops and stage show before anything is saved.
 */
function TreeAdjustCard({ tree, activeStudents, amount, note, busy, enabled, adjustedTotal, onAmount, onNote, onApply }: Readonly<{
  tree: NonNullable<ClassTreeAdminBoardDto['tree']>; activeStudents: number; amount: string; note: string; busy: 'add' | 'remove' | null;
  enabled: boolean; adjustedTotal: number; onAmount: (value: string) => void; onNote: (value: string) => void; onApply: (direction: 'add' | 'remove') => void;
}>) {
  const value = wholeOrNaN(amount);
  const { min, max } = CLASS_TREE_LIMITS.classFeedDrops;
  const valid = Number.isSafeInteger(value) && value >= min && value <= max;
  const full = tree.drops >= tree.goal;
  const plus = valid ? tree.drops + value : tree.drops;
  const minus = valid ? Math.max(0, tree.drops - value) : tree.drops;
  const stageOf = (drops: number) => CLASS_TREE_STAGES[classTreeLook(drops, tree.goal, 0).stage];
  const steps = [...new Set([1, 10, Math.max(1, activeStudents)])].sort((a, b) => a - b);
  return (
    <Card className="space-y-3">
      <CardHeader title="양분 조정" description="반 전체를 칭찬할 때 양분을 더하고, 잘못 쌓인 양분은 뺄 수 있어요." />
      <p className="text-sm font-semibold tabular-nums">지금 양분 {fmt(tree.drops)} / {fmt(tree.goal)} · {stageOf(tree.drops)}</p>
      <Field label="바꿀 양분" htmlFor="tree-feed-amount">
        <div className="flex items-center gap-2">
          <IconButton icon="minus" label="1 줄이기" variant="secondary" disabled={!valid || value <= min} onClick={() => onAmount(String(Math.max(min, value - 1)))} />
          <Input id="tree-feed-amount" inputMode="numeric" value={amount} className="w-[7rem] text-center" suffix="개" onChange={(event) => onAmount(event.target.value)} />
          <IconButton icon="plus" label="1 늘리기" variant="secondary" disabled={valid && value >= max} onClick={() => onAmount(String(valid ? value + 1 : 1))} />
        </div>
      </Field>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="자주 쓰는 값">
        {steps.map((step) => (
          <Button key={step} size="sm" variant={value === step ? 'primary' : 'ghost'} onClick={() => onAmount(String(step))}>
            {step === activeStudents && step !== 1 && step !== 10 ? `학생 수 ${step}개` : `${step}개`}
          </Button>
        ))}
      </div>
      <Field label="메모" htmlFor="tree-feed-note" optional>
        <Input id="tree-feed-note" value={note} maxLength={CLASS_TREE_LIMITS.classFeedNoteLength} placeholder="예: 모둠 활동 칭찬" onChange={(event) => onNote(event.target.value)} />
      </Field>
      {valid ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-[14px] bg-[var(--crs-subtle-hover)] p-3 text-sm">
          <dt className="font-bold">더하면</dt>
          <dd className="tabular-nums">{full ? '이미 다 자라서 더할 수 없어요' : `${fmt(plus)} · ${plus >= tree.goal ? '열매가 다 익어요' : stageOf(plus)}`}</dd>
          <dt className="font-bold">빼면</dt>
          <dd className="tabular-nums">{fmt(minus)} · {stageOf(minus)}</dd>
        </dl>
      ) : <p className="text-sm font-semibold text-[var(--crs-danger-text)]">{min}~{fmt(max)} 사이의 숫자로 적어 주세요.</p>}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" icon="minus" onClick={() => onApply('remove')} loading={busy === 'remove'}
          disabled={!valid || busy !== null || !enabled || tree.drops === 0}>양분 빼기{valid ? ` −${fmt(value)}` : ''}</Button>
        <Button variant="primary" icon="plus" onClick={() => onApply('add')} loading={busy === 'add'}
          disabled={!valid || busy !== null || !enabled || full}>양분 더하기{valid ? ` +${fmt(value)}` : ''}</Button>
      </div>
      {adjustedTotal !== 0 ? <p className="text-xs text-[var(--theme-muted-text)]">이 나무에 선생님이 조정한 양분은 합쳐서 {adjustedTotal > 0 ? '+' : '−'}{fmt(Math.abs(adjustedTotal))}이에요.</p> : null}
      {!enabled ? <p className="text-xs text-[var(--theme-muted-text)]">나무 키우기를 켜야 조정할 수 있어요.</p> : null}
    </Card>
  );
}
