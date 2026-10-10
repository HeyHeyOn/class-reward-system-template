'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CLASS_TREE_LIMITS,
  CLASS_TREE_STAGES,
  classTreeGoal,
  classTreeLook,
  parseClassTreeSettings,
  DEFAULT_TREE_NAME,
  TREE_NAME_LENGTH,
  type ClassTreeSettings,
} from '@/domain/classTree';
import type { ClassTreeAdminBoardDto } from '@/lib/classTreeApi';
import { withParticle } from '@/lib/koreanParticle';
import { DIGITAL_KIND_LABELS } from '@/lib/studentBagApi';
import { Button, Callout, Card, CardHeader, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, StatCard, Switch } from '../ui';
import { TreeCanvas, treePercent, type TreePlay } from './TreeCanvas';
import { fetchClassTreeBoard, giveClassFeed, harvestTree, saveClassTreeSettings } from './classTreeClient';

type Draft = Readonly<{
  enabled: boolean; waterPrice: string; waterDailyLimit: string; taskDrops: string; targetWeeks: string;
  manualGoal: boolean; goalOverride: string; rewardAmount: string; rewardProductId: string; treeName: string;
}>;

const toDraft = (settings: ClassTreeSettings, computedGoal: number): Draft => ({
  enabled: settings.enabled,
  waterPrice: String(settings.waterPrice),
  waterDailyLimit: String(settings.waterDailyLimit),
  taskDrops: String(settings.taskDrops),
  targetWeeks: String(settings.targetWeeks),
  manualGoal: settings.goalOverride !== null,
  goalOverride: String(settings.goalOverride ?? computedGoal),
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
    targetWeeks: wholeOrNaN(draft.targetWeeks),
    goalOverride: draft.manualGoal ? wholeOrNaN(draft.goalOverride) : null,
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
  const [feedBusy, setFeedBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [harvestOpen, setHarvestOpen] = useState<HTMLElement | null>(null);
  const [harvesting, setHarvesting] = useState(false);
  const [play, setPlay] = useState<TreePlay | null>(null);
  const pendingFeed = useRef<string | null>(null);
  const pendingHarvest = useRef<string | null>(null);

  const applyBoard = useCallback((next: ClassTreeAdminBoardDto, resetDraft: boolean) => {
    setBoard(next);
    if (resetDraft) setDraft(toDraft(next.settings, next.computedGoal));
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

  const parsed = useMemo(() => (draft ? fromDraft(draft) : null), [draft]);
  const previewGoal = board && parsed?.ok ? classTreeGoal({ ...parsed.settings, goalOverride: null }, board.activeStudents) : null;
  const dirty = Boolean(board && draft && JSON.stringify(toDraft(board.settings, board.computedGoal)) !== JSON.stringify(draft));

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
    notify(checked.settings.enabled && wasOff && result.data.tree ? `${withParticle(checked.settings.treeName, '을/를')} 심었어요. 학생 은행 화면에 나무가 보여요.` : '학급 나무 설정을 저장했어요.');
  }

  async function classFeed() {
    const amount = wholeOrNaN(feedAmount);
    if (!Number.isSafeInteger(amount) || amount < CLASS_TREE_LIMITS.classFeedDrops.min || amount > CLASS_TREE_LIMITS.classFeedDrops.max) {
      setActionError(`반 전체에 줄 양분은 1~${fmt(CLASS_TREE_LIMITS.classFeedDrops.max)} 사이로 적어 주세요.`);
      return;
    }
    const operationId = pendingFeed.current ?? crypto.randomUUID();
    pendingFeed.current = operationId;
    setFeedBusy(true);
    setActionError('');
    const before = board?.tree ? { drops: board.tree.drops, goal: board.tree.goal, apples: board.activeStudents } : null;
    const result = await giveClassFeed({ operationId, amount, note: feedNote });
    setFeedBusy(false);
    if (result.ok) {
      pendingFeed.current = null;
      if (before) setPlay({ key: Date.now(), kind: 'classFeed', before, amount });
      applyBoard(result.data.board, false);
      setFeedNote('');
      notify(`반 전체에 양분을 ${fmt(amount)}만큼 줬어요.`);
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
        <PageHeader title="학급 나무" description="학생들이 함께 양분을 주어 나무를 키우고, 열매가 다 익으면 반 전체가 보상을 받아요." />
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
      <PageHeader title="학급 나무" description="학생들이 함께 양분을 주어 나무를 키우고, 열매가 다 익으면 반 전체가 보상을 받아요."
        actions={<Button variant="secondary" size="sm" icon="refresh" onClick={() => void load(!dirty)} disabled={loading}>새로고침</Button>} />

      {actionError ? <div role="alert"><Callout tone="danger">{actionError}</Callout></div> : null}

      {!settings.enabled && !tree ? (
        <Card>
          <EmptyState icon="sprout" title="아직 학급 나무를 심지 않았어요"
            description="아래에서 이름과 기간, 보상을 정하고 시작하면 씨앗이 심어져요. 학생들은 은행 화면에서 양분을 주고, 과제를 완료해도 양분이 쌓여요."
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
            ) : (
              <Card className="space-y-3">
                <CardHeader title="반 전체 양분 주기" description="반 전체를 칭찬할 때 선생님이 양분을 한꺼번에 줘요." />
                <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <Field label="양분" htmlFor="tree-feed-amount">
                    <Input id="tree-feed-amount" inputMode="numeric" value={feedAmount} onChange={(event) => setFeedAmount(event.target.value)} suffix="개" />
                  </Field>
                  <Field label="메모" htmlFor="tree-feed-note" optional>
                    <Input id="tree-feed-note" value={feedNote} maxLength={CLASS_TREE_LIMITS.classFeedNoteLength} placeholder="예: 모둠 활동 칭찬" onChange={(event) => setFeedNote(event.target.value)} />
                  </Field>
                </div>
                <Button variant="primary" icon="sprout" onClick={() => void classFeed()} loading={feedBusy} disabled={feedBusy || !settings.enabled}>양분 주기</Button>
                {board.classFeedTotal > 0 ? <p className="text-xs text-[var(--theme-muted-text)]">이 나무에 선생님이 지금까지 준 양분은 {fmt(board.classFeedTotal)}이에요.</p> : null}
              </Card>
            )}
          </div>
        </div>
      ) : null}

      <Card className="space-y-5">
        <CardHeader title="키우기 설정" description="기간을 고르면 학생 수에 맞춰 목표 양분을 계산해요. 보상은 수확할 때의 설정으로 줘요." />
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
          <Field label="키우는 기간" htmlFor="tree-weeks"
            hint={previewGoal !== null && board ? `학생 ${board.activeStudents}명 × 하루 ${Math.max(1, wholeOrNaN(draft.waterDailyLimit) + wholeOrNaN(draft.taskDrops) || 1)}개 × ${wholeOrNaN(draft.targetWeeks) * 5}일 = ${fmt(previewGoal)}개` : undefined}>
            <Select id="tree-weeks" value={draft.targetWeeks} onChange={(event) => set({ targetWeeks: event.target.value })}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((weeks) => <option key={weeks} value={weeks}>약 {weeks}주</option>)}
            </Select>
          </Field>
          <Field label="목표 양분" htmlFor="tree-goal" hint={draft.manualGoal ? '직접 정한 목표를 써요.' : '기간에 맞춰 자동으로 정해요.'}>
            <div className="flex items-center gap-2">
              <Input id="tree-goal" inputMode="numeric" value={draft.manualGoal ? draft.goalOverride : String(previewGoal ?? '')} disabled={!draft.manualGoal}
                onChange={(event) => set({ goalOverride: event.target.value })} suffix="개" />
              <Switch checked={draft.manualGoal} onChange={(manualGoal) => set({ manualGoal, goalOverride: draft.goalOverride || String(previewGoal ?? '') })} ariaLabel="목표 양분 직접 정하기" />
            </div>
          </Field>
          <Field label="양분 주기 가격" htmlFor="tree-price" hint="0으로 두면 무료로 줄 수 있어요.">
            <Input id="tree-price" inputMode="numeric" value={draft.waterPrice} onChange={(event) => set({ waterPrice: event.target.value })} suffix={unit} />
          </Field>
          <Field label="하루에 양분 줄 수 있는 횟수" htmlFor="tree-limit" hint="학생 한 명 기준이에요.">
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
        {formError ? <p role="alert" className="text-sm font-semibold text-[var(--crs-danger-text)]">{formError}</p> : null}
        <div className="flex flex-wrap gap-2">
          {tree || settings.enabled ? (
            <Button variant="primary" icon="check" onClick={() => void save()} loading={saving} disabled={saving || !dirty}>설정 저장</Button>
          ) : (
            <Button variant="primary" icon="sprout" onClick={() => void save(true)} loading={saving} disabled={saving}>이 설정으로 시작하기</Button>
          )}
          {dirty ? <Button variant="ghost" onClick={() => { setDraft(toDraft(board.settings, board.computedGoal)); setFormError(''); }} disabled={saving}>되돌리기</Button> : null}
        </div>
      </Card>

      {tree ? (
        <Card className="space-y-3">
          <CardHeader title="함께 키운 학생" description={`${settings.treeName}에 양분을 보탠 기록이에요. 학생 화면에는 순위를 보여 주지 않아요.`} />
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
                    <td className="py-2 text-right tabular-nums">{row.waterToday > 0 ? `${row.waterToday}번` : '-'}</td>
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
