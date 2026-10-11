import { CLASS_TREE_STAGES, classTreeStageProgress } from '@/domain/classTree';

/** The way to the next stage only — students never see how far the whole goal is. */
export function StageBar({ drops, goal }: Readonly<{ drops: number; goal: number }>) {
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
export function nextStageText(drops: number, goal: number): string {
  const next = classTreeStageProgress(drops, goal).next;
  return `다음 단계: ${next === null ? '수확' : CLASS_TREE_STAGES[next]}`;
}

/** The drops in the stage the tree is in, out of all the stage takes ('3/40'). */
export function stagePoints(drops: number, goal: number): string {
  const { done, need } = classTreeStageProgress(drops, goal);
  return `${done}/${need}`;
}

