import 'server-only';

import type { TenantTransaction } from '@/server/db/transaction';
import { addTaskTreeDrops } from './classTree';
import { addTaskPetGrowth } from './pets';

export type TaskGrowthInput = Readonly<{ studentId: string; transactionId: string; operationId: string }>;

/** Run after other reward bookkeeping, still before commit. Keep tree→pet lock order. */
export async function applyTaskGrowth(tx: TenantTransaction, tenantId: string, input: TaskGrowthInput): Promise<void> {
  await addTaskTreeDrops(tx, tenantId, input);
  await addTaskPetGrowth(tx, tenantId, input);
}
