import type { ClassTreeSettings } from '@/domain/classTree';
import type { DigitalKind } from '@/lib/studentBagApi';

/* What the class tree API sends to the student bank and to the teacher's screen. */

export type ClassTreeDto = Readonly<{
  treeNo: number;
  goal: number;
  drops: number;
  startedAt: string;
}>;

/** The tree as one student sees it in the bank. `tree` is null while the teacher has it turned off. */
export type ClassTreeStudentViewDto = Readonly<{
  enabled: boolean;
  /** The class's name for its tree. */
  treeName: string;
  tree: ClassTreeDto | null;
  /** One apple per active student. */
  apples: number;
  waterPrice: number;
  waterDailyLimit: number;
  myWaterToday: number;
  waterersToday: number;
  harvestedTrees: number;
}>;

export type ClassTreeContributionDto = Readonly<{
  studentId: string;
  name: string;
  water: number;
  task: number;
  total: number;
  waterToday: number;
}>;

export type ClassTreeRewardProductDto = Readonly<{
  productId: string;
  name: string;
  imageUrl: string | null;
  isActive: boolean;
  /** A 디지털 상품 (its type) goes into the 보관함 as itself; any other product (null) as its 교환권. */
  digitalKind: DigitalKind | null;
}>;

export type ClassTreeHarvestDto = Readonly<{
  treeNo: number;
  goal: number;
  drops: number;
  startedAt: string;
  harvestedAt: string;
  recipients: number;
  rewardAmount: number;
  /** The item every student got ('' for none). */
  rewardItem: string;
}>;

export type ClassTreeAdminBoardDto = Readonly<{
  settings: ClassTreeSettings;
  activeStudents: number;
  /** Store products a harvest reward can be picked from (deleted ones excluded). */
  rewardProducts: ReadonlyArray<ClassTreeRewardProductDto>;
  tree: ClassTreeDto | null;
  waterersToday: number;
  classFeedTotal: number;
  contributions: ReadonlyArray<ClassTreeContributionDto>;
  harvests: ReadonlyArray<ClassTreeHarvestDto>;
}>;

export type ClassTreeWaterResultDto = Readonly<{
  ok: true;
  operationId: string;
  treeNo: number;
  drops: number;
  goal: number;
  ready: boolean;
  myWaterToday: number;
  price: number;
  balanceAfter: number;
  wateredAt: string;
}>;

export type ClassTreeClassFeedResultDto = Readonly<{
  ok: true;
  operationId: string;
  treeNo: number;
  amount: number;
  drops: number;
  goal: number;
  ready: boolean;
}>;

export type ClassTreeHarvestResultDto = Readonly<{
  ok: true;
  operationId: string;
  treeNo: number;
  recipients: number;
  rewardAmount: number;
  rewardItem: string;
  nextTreeNo: number;
  nextGoal: number;
  harvestedAt: string;
}>;

export const CLASS_TREE_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
