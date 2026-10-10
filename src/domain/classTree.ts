/*
 * The class apple tree: what a teacher can set and how the goal and the stage follow from it.
 * Shared by the server (validation, goal) and the screens (stage, apples).
 */

export type ClassTreeSettings = Readonly<{
  enabled: boolean;
  /** The name the class gives its tree; screens show just this name. */
  treeName: string;
  /** Price of one watering, in the class currency. 0 makes watering free. */
  waterPrice: number;
  /** Waterings per student per day (Korea time). 0 turns watering off. */
  waterDailyLimit: number;
  /** Drops a completed task adds. 0 turns it off. */
  taskDrops: number;
  /** About how many weeks a tree should take; sets the goal with the student count. */
  targetWeeks: number;
  /** A goal the teacher typed in instead of the computed one. */
  goalOverride: number | null;
  /** Money every active student receives at the harvest. */
  rewardAmount: number;
  /**
   * A store product every active student receives at the harvest (null for none): a 디지털 상품 goes
   * into the 보관함 as itself, any other product as its 교환권.
   */
  rewardProductId: string | null;
}>;

export const DEFAULT_TREE_NAME = '사과나무';
export const TREE_NAME_LENGTH = 12;

export const DEFAULT_CLASS_TREE_SETTINGS: ClassTreeSettings = Object.freeze({
  enabled: false,
  treeName: DEFAULT_TREE_NAME,
  waterPrice: 10,
  waterDailyLimit: 2,
  taskDrops: 1,
  targetWeeks: 4,
  goalOverride: null,
  rewardAmount: 100,
  rewardProductId: null,
});

export const CLASS_TREE_LIMITS = Object.freeze({
  waterPrice: { min: 0, max: 1_000_000 },
  waterDailyLimit: { min: 0, max: 10 },
  taskDrops: { min: 0, max: 10 },
  targetWeeks: { min: 1, max: 20 },
  goal: { min: 1, max: 1_000_000 },
  rewardAmount: { min: 0, max: 1_000_000 },
  classFeedDrops: { min: 1, max: 10_000 },
  classFeedNoteLength: 40,
});

/** School days in a week, for turning weeks into drops. */
const SCHOOL_DAYS_PER_WEEK = 5;

/**
 * The drops a tree needs: every active student giving their daily waterings plus about one
 * completed task a day, over the chosen number of weeks. A typed-in goal wins.
 */
export function classTreeGoal(settings: ClassTreeSettings, activeStudents: number): number {
  if (settings.goalOverride !== null) return settings.goalOverride;
  const perDay = Math.max(1, settings.waterDailyLimit + settings.taskDrops);
  const goal = Math.max(1, activeStudents) * perDay * SCHOOL_DAYS_PER_WEEK * settings.targetWeeks;
  return Math.min(CLASS_TREE_LIMITS.goal.max, Math.max(CLASS_TREE_LIMITS.goal.min, goal));
}

export const CLASS_TREE_STAGES = ['씨앗', '새싹', '떡잎', '묘목', '어린 나무', '큰 나무', '꽃', '열매'] as const;
/** Progress at which each stage begins. */
export const CLASS_TREE_STAGE_STARTS = [0, 0.05, 0.15, 0.28, 0.42, 0.58, 0.72, 0.84] as const;

export type ClassTreeLook = Readonly<{
  stage: number;
  progress: number;
  /** Apples already red (in the last stage). */
  ripe: number;
  /** Blossoms showing (in the flower stage). */
  flowers: number;
  ready: boolean;
}>;

/** How the tree looks with `drops` of `goal`, carrying `apples` (one per student). */
export function classTreeLook(drops: number, goal: number, apples: number): ClassTreeLook {
  const progress = goal > 0 ? Math.min(1, Math.max(0, drops / goal)) : 0;
  let stage = 0;
  CLASS_TREE_STAGE_STARTS.forEach((start, index) => { if (progress >= start) stage = index; });
  const ripe = stage === 7 ? Math.floor(apples * Math.min(1, (progress - 0.84) / 0.16) + 1e-9) : 0;
  const flowers = stage === 6 ? Math.round(12 + 22 * Math.min(1, (progress - 0.72) / 0.12)) : 0;
  return { stage, progress, ripe, flowers, ready: goal > 0 && drops >= goal };
}

export type ClassTreeSettingsParse = { ok: true; settings: ClassTreeSettings } | { ok: false; error: string };

function wholeNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

/** Checks settings sent by a teacher's screen; every field is required. */
export function parseClassTreeSettings(value: unknown): ClassTreeSettingsParse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: '설정 값이 올바르지 않아요.' };
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== 'boolean') return { ok: false, error: '학급 나무를 켤지 정해 주세요.' };
  const treeName = typeof input.treeName === 'string' ? input.treeName.trim().replace(/\s+/gu, ' ') : '';
  if (!treeName || [...treeName].length > TREE_NAME_LENGTH || /[\p{Cc}<>]/u.test(treeName)) {
    return { ok: false, error: `나무 이름은 1~${TREE_NAME_LENGTH}자로 적어 주세요.` };
  }
  const L = CLASS_TREE_LIMITS;
  const waterPrice = wholeNumber(input.waterPrice, L.waterPrice.min, L.waterPrice.max);
  if (waterPrice === null) return { ok: false, error: `양분 주기 가격은 0~${L.waterPrice.max.toLocaleString('ko-KR')} 사이의 정수로 적어 주세요.` };
  const waterDailyLimit = wholeNumber(input.waterDailyLimit, L.waterDailyLimit.min, L.waterDailyLimit.max);
  if (waterDailyLimit === null) return { ok: false, error: `하루 양분 주기 횟수는 0~${L.waterDailyLimit.max}번 사이로 정해 주세요.` };
  const taskDrops = wholeNumber(input.taskDrops, L.taskDrops.min, L.taskDrops.max);
  if (taskDrops === null) return { ok: false, error: `과제 완료 양분은 0~${L.taskDrops.max}개 사이로 정해 주세요.` };
  const targetWeeks = wholeNumber(input.targetWeeks, L.targetWeeks.min, L.targetWeeks.max);
  if (targetWeeks === null) return { ok: false, error: `기간은 ${L.targetWeeks.min}~${L.targetWeeks.max}주 사이로 정해 주세요.` };
  const goalOverride = input.goalOverride === null ? null : wholeNumber(input.goalOverride, L.goal.min, L.goal.max);
  if (input.goalOverride !== null && goalOverride === null) {
    return { ok: false, error: `목표 양분은 ${L.goal.min}~${L.goal.max.toLocaleString('ko-KR')}개 사이로 적어 주세요.` };
  }
  const rewardAmount = wholeNumber(input.rewardAmount, L.rewardAmount.min, L.rewardAmount.max);
  if (rewardAmount === null) return { ok: false, error: `수확 보상은 0~${L.rewardAmount.max.toLocaleString('ko-KR')} 사이의 정수로 적어 주세요.` };
  const rewardProductId = input.rewardProductId;
  if (rewardProductId !== null && (typeof rewardProductId !== 'string' || !rewardProductId || rewardProductId !== rewardProductId.trim()
    || rewardProductId.length > 200)) {
    return { ok: false, error: '수확 보상 상품을 다시 골라 주세요.' };
  }
  return { ok: true, settings: { enabled: input.enabled, treeName, waterPrice, waterDailyLimit, taskDrops, targetWeeks, goalOverride, rewardAmount, rewardProductId } };
}
