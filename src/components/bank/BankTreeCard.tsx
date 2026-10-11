'use client';

import { CLASS_TREE_STAGES, classTreeLook } from '@/domain/classTree';
import { TreeCanvas } from '../classTree/TreeCanvas';
import { Icon } from '../ui';
import type { ClassTreeStudentViewDto } from './bankClient';
import { StageBar, nextStageText, stagePoints } from './treeProgress';

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

