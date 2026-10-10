'use client';

import { forwardRef } from 'react';
import { CLASS_TREE_STAGES, classTreeLook } from '@/domain/classTree';
import { TreeCanvas, treePercent, type TreePlay } from '../classTree/TreeCanvas';
import { Button, Callout, Icon, IconButton, Spinner } from '../ui';
import type { ClassTreeStudentViewDto } from './bankClient';
import { formatMoney } from './format';

function ProgressBar({ drops, goal }: Readonly<{ drops: number; goal: number }>) {
  const percent = treePercent(drops, goal);
  return (
    <span role="progressbar" aria-label="학급 나무 양분" aria-valuemin={0} aria-valuemax={goal} aria-valuenow={Math.min(drops, goal)}
      className="block h-2.5 overflow-hidden rounded-full bg-[var(--theme-accent-soft)]">
      <span className="block h-full rounded-full bg-[var(--theme-accent-solid)] transition-[width] duration-300" style={{ width: `${percent}%` }} />
    </span>
  );
}

/** The class tree on the bank home: a small picture and the class's progress. Opens the tree. */
export function BankTreeCard({ view, onOpen }: Readonly<{ view: ClassTreeStudentViewDto; onOpen: () => void }>) {
  const tree = view.tree;
  if (!view.enabled || !tree) return null;
  const look = classTreeLook(tree.drops, tree.goal, view.apples);
  return (
    <button type="button" onClick={onOpen} aria-label={`${view.treeName}, 양분 ${tree.drops}, 목표 ${tree.goal}`}
      className="mt-4 flex w-full items-center gap-4 rounded-[22px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-4 text-left shadow-[var(--crs-shadow-sm)] transition-[transform,background-color] duration-150 hover:bg-[var(--crs-subtle-hover)] active:scale-[0.99]">
      <span aria-hidden="true" className="shrink-0 rounded-2xl bg-[var(--theme-accent-soft)] p-1">
        <TreeCanvas drops={tree.drops} goal={tree.goal} apples={view.apples} size={80} name={view.treeName} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[18px] font-black tracking-[-0.02em]">{view.treeName}</span>
        <span className="mt-0.5 block text-[13px] font-semibold text-[var(--theme-muted-text)]">
          {look.ready ? '열매가 다 익었어요! 수확을 기다려요' : `${CLASS_TREE_STAGES[look.stage]} · 오늘 양분 준 친구 ${view.waterersToday}명`}
        </span>
        <span className="mt-2 block"><ProgressBar drops={tree.drops} goal={tree.goal} /></span>
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
  const tree = view?.enabled ? view.tree : null;
  const look = tree && view ? classTreeLook(tree.drops, tree.goal, view.apples) : null;
  const doneToday = view ? view.myWaterToday >= view.waterDailyLimit : false;
  const tooPoor = view ? balance < view.waterPrice : false;
  const waterLabel = view && view.waterPrice > 0 ? `양분 주기 · ${formatMoney(view.waterPrice, currencyUnit)}` : '양분 주기';
  let blocked = '';
  if (look?.ready) blocked = '열매가 다 익었어요! 선생님이 수확할 때까지 기다려요.';
  else if (view && view.waterDailyLimit === 0) blocked = '지금은 양분 주기를 쉬고 있어요.';
  else if (doneToday) blocked = `오늘은 양분을 다 줬어요(${view?.myWaterToday}/${view?.waterDailyLimit}). 내일 또 줄 수 있어요.`;
  else if (tooPoor) blocked = '잔액이 부족해서 양분을 줄 수 없어요.';

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
            <span className="text-[14px] font-bold tabular-nums text-[var(--theme-muted-text)]">
              양분 {tree.drops.toLocaleString('ko-KR')} / {tree.goal.toLocaleString('ko-KR')}
            </span>
          </div>
          <div className="mt-2"><ProgressBar drops={tree.drops} goal={tree.goal} /></div>
          <p className="mt-2 text-[13px] font-semibold text-[var(--theme-muted-text)]">
            {look.stage === 7 ? `사과 ${view.apples}개 중 ${look.ripe}개가 빨갛게 익었어요. ` : ''}
            오늘 양분 준 친구 {view.waterersToday}명{view.harvestedTrees > 0 ? ` · 지금까지 수확한 나무 ${view.harvestedTrees}그루` : ''}
          </p>

          <div className="mt-4">
            <Button variant="primary" size="lg" block icon="sprout" onClick={onWater} loading={watering}
              disabled={watering || Boolean(blocked)}>{waterLabel}</Button>
            <p className="mt-2 text-center text-[13px] font-semibold text-[var(--theme-muted-text)]">
              {blocked || `오늘 ${view.myWaterToday}/${view.waterDailyLimit}번 줬어요. 과제를 완료해도 양분이 쌓여요.`}
            </p>
            {notice ? <p role="status" className="mt-1 text-center text-[14px] font-bold text-[var(--theme-accent-text)]">{notice}</p> : null}
          </div>
        </section>
      ) : null}

    </div>
  );
});
