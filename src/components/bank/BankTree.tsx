'use client';

import { forwardRef, useState } from 'react';
import { CLASS_TREE_STAGES, classTreeLook, classTreeStageProgress } from '@/domain/classTree';
import { TreeCanvas, type TreePlay } from '../classTree/TreeCanvas';
import { Button, Callout, Icon, IconButton, Spinner } from '../ui';
import type { ClassTreeStudentViewDto } from './bankClient';
import { formatMoney } from './format';
import { NoticeToast, type Notice } from './NoticeToast';

/** The way to the next stage only — students never see how far the whole goal is. */
function StageBar({ drops, goal }: Readonly<{ drops: number; goal: number }>) {
  const progress = classTreeStageProgress(drops, goal);
  const percent = Math.round(progress.fraction * 100);
  const label = progress.next === null ? '수확까지' : `${CLASS_TREE_STAGES[progress.next]}까지`;
  return (
    <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
      className="block h-2.5 overflow-hidden rounded-full bg-[var(--theme-accent-soft)]">
      <span className="block h-full rounded-full bg-[var(--theme-accent-solid)] transition-[width] duration-300" style={{ width: `${percent}%` }} />
    </span>
  );
}

/** '다음 단계: 새싹' (or the harvest after the last stage). */
function nextStageText(drops: number, goal: number): string {
  const next = classTreeStageProgress(drops, goal).next;
  return `다음 단계: ${next === null ? '수확' : CLASS_TREE_STAGES[next]}`;
}

/** The drops in the stage the tree is in, out of all the stage takes ('3/40'). */
function stagePoints(drops: number, goal: number): string {
  const { done, need } = classTreeStageProgress(drops, goal);
  return `${done}/${need}`;
}

/** The class tree on the bank home: a small picture, and how close it is to its next stage. Opens the tree. */
export function BankTreeCard({ view, onOpen }: Readonly<{ view: ClassTreeStudentViewDto; onOpen: () => void }>) {
  const tree = view.tree;
  if (!view.enabled || !tree) return null;
  const look = classTreeLook(tree.drops, tree.goal, view.apples);
  return (
    <button type="button" onClick={onOpen}
      aria-label={`${view.treeName}, ${CLASS_TREE_STAGES[look.stage]}${look.ready ? ', 열매가 다 익었어요' : ` ${stagePoints(tree.drops, tree.goal)}, ${nextStageText(tree.drops, tree.goal)}`}`}
      className="mt-4 flex w-full items-center gap-4 rounded-[22px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-4 text-left shadow-[var(--crs-shadow-sm)] transition-[transform,background-color] duration-150 hover:bg-[var(--crs-subtle-hover)] active:scale-[0.99]">
      <span aria-hidden="true" className="shrink-0 rounded-2xl bg-[var(--theme-accent-soft)] p-1">
        <TreeCanvas drops={tree.drops} goal={tree.goal} apples={view.apples} size={80} name={view.treeName} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[18px] font-black tracking-[-0.02em]">{view.treeName}</span>
        <span className="mt-0.5 flex items-baseline justify-between gap-2 text-[13px] font-semibold text-[var(--theme-muted-text)]">
          <span className="min-w-0 truncate">{look.ready ? '열매가 다 익었어요! 수확을 기다려요' : CLASS_TREE_STAGES[look.stage]}</span>
          {look.ready ? null : <span className="shrink-0 font-bold tabular-nums text-[var(--theme-text)]">{stagePoints(tree.drops, tree.goal)}</span>}
        </span>
        <span className="mt-1.5 block">
          <StageBar drops={tree.drops} goal={tree.goal} />
          {!look.ready ? <span className="mt-1 block text-[12px] font-bold text-[var(--theme-accent-text)]">{nextStageText(tree.drops, tree.goal)}</span> : null}
        </span>
      </span>
      <Icon name="chevronRight" size={20} className="shrink-0 text-[var(--theme-muted-text)]" />
    </button>
  );
}

type BankTreeViewProps = Readonly<{
  view: ClassTreeStudentViewDto | null;
  balance: number;
  currencyUnit: string;
  loading: boolean;
  watering: boolean;
  error: string;
  notice: string;
  /** The animation of the latest 양분 주기. */
  play: TreePlay | null;
  /** The animation finished (or was skipped): it must not play again when the view opens next time. */
  onPlayEnd: () => void;
  onBack: () => void;
  onRefresh: () => void;
  onWater: () => void;
}>;

/** The class tree page: the big tree, watering, and the student's coupons. */
export const BankTreeView = forwardRef<HTMLHeadingElement, BankTreeViewProps>(function BankTreeView(
  { view, balance, currencyUnit, loading, watering, error, notice, play, onPlayEnd, onBack, onRefresh, onWater }, headingRef,
) {
  const [toast, setToast] = useState<Notice | null>(null);
  const tree = view?.enabled ? view.tree : null;
  const look = tree && view ? classTreeLook(tree.drops, tree.goal, view.apples) : null;
  const doneToday = view ? view.myWaterToday >= view.waterDailyLimit : false;
  const tooPoor = view ? balance < view.waterPrice : false;
  const waterLabel = view && view.waterPrice > 0 ? `양분 주기 · ${formatMoney(view.waterPrice, currencyUnit)}` : '양분 주기';
  let blocked = '';
  if (look?.ready) blocked = '열매가 다 익었어요! 선생님이 수확할 때까지 기다려요.';
  else if (view && view.waterDailyLimit === 0) blocked = '지금은 양분 주기를 쉬고 있어요.';
  else if (doneToday) blocked = '오늘은 양분을 다 줬어요. 내일 또 줄 수 있어요.';
  else if (tooPoor) blocked = `잔액이 부족해서 양분을 줄 수 없어요. 양분 주기는 ${formatMoney(view?.waterPrice ?? 0, currencyUnit)}이에요.`;

  return (
    <div className="pb-[max(2rem,calc(env(safe-area-inset-bottom)+1.5rem))] pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-center gap-2">
        <IconButton icon="chevronLeft" label="홈으로 돌아가기" onClick={onBack} className="-ml-2" size="lg" />
        <h2 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 truncate text-[22px] font-black tracking-[-0.03em] outline-none">
          {view?.treeName ?? '학급 나무'}
        </h2>
        <IconButton icon="refresh" label="나무 새로고침" onClick={onRefresh} disabled={loading} />
      </header>

      {error ? <div role="alert" className="mt-4"><Callout tone="danger">{error}</Callout></div> : null}
      {!view && loading ? (
        <div role="status" className="mt-10 flex flex-col items-center gap-3 text-[15px] font-bold text-[var(--theme-muted-text)]">
          <Spinner size={26} className="text-[var(--theme-accent-text)]" />나무를 불러오는 중이에요.
        </div>
      ) : null}
      {view && !tree ? <div className="mt-5"><Callout tone="info">선생님이 아직 학급 나무를 열지 않았어요.</Callout></div> : null}

      {tree && view && look ? (
        <section className="mt-4 rounded-[26px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-4 shadow-[var(--crs-shadow-sm)] sm:p-5">
          <div className="flex justify-center rounded-[20px] bg-[var(--theme-accent-soft)] p-3">
            <TreeCanvas drops={tree.drops} goal={tree.goal} apples={view.apples} size={320} play={play} onPlayEnd={onPlayEnd} name={view.treeName} />
          </div>
          <div className="mt-4 flex items-baseline justify-between gap-3">
            <span className="text-[20px] font-black tracking-[-0.02em]">{CLASS_TREE_STAGES[look.stage]}</span>
            {look.ready ? null : <span className="text-[16px] font-black tabular-nums" aria-label={`이번 단계 양분 ${stagePoints(tree.drops, tree.goal)}`}>{stagePoints(tree.drops, tree.goal)}</span>}
          </div>
          <div className="mt-2"><StageBar drops={tree.drops} goal={tree.goal} /></div>
          <p className="mt-1.5 text-[13px] font-bold text-[var(--theme-accent-text)]">{look.ready ? '열매가 다 익었어요!' : nextStageText(tree.drops, tree.goal)}</p>
          <p className="mt-2 text-[13px] font-semibold text-[var(--theme-muted-text)]">
            {look.stage === 7 ? `사과 ${view.apples}개 중 ${look.ripe}개가 빨갛게 익었어요. ` : ''}
            오늘 양분 준 친구 {view.waterersToday}명{view.harvestedTrees > 0 ? ` · 지금까지 수확한 나무 ${view.harvestedTrees}그루` : ''}
          </p>

          <div className="mt-4">
            {/* A button that cannot be used now still answers when pressed: its reason in a notice at the top. */}
            <Button variant="primary" size="lg" block icon="sprout" loading={watering} disabled={watering}
              aria-disabled={blocked ? true : undefined} className={blocked ? 'opacity-45' : undefined}
              onClick={() => (blocked ? setToast({ message: blocked }) : onWater())}>{waterLabel}</Button>
            {notice ? <p role="status" className="sr-only">{notice}</p> : null}
          </div>
        </section>
      ) : null}
      {toast ? <NoticeToast notice={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
});
