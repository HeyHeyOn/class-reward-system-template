import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TaskCompletionEvidence } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';

export type PadletClaimInput = Readonly<{
  tenantId: string;
  operationId: string;
  evidence: TaskCompletionEvidence;
  claimedAt: Date;
}>;

/**
 * Privileged, global claim seam. Production composition must grant only the
 * narrow INSERT authority needed by this implementation (or inject an
 * equivalent same-transaction implementation); it must never SET ROLE.
 */
export interface DatabasePadletClaimRepository {
  claim(transaction: TenantTransaction, input: PadletClaimInput): Promise<'CLAIMED' | 'CONFLICT'>;
}

const CLAIM_CONFLICT_CONSTRAINTS = new Set([
  'padlet_claim_digest_registry_pkey',
  'padlet_evidence_claims_pkey',
  'padlet_evidence_claims_digest_unique',
]);

export function createDatabasePadletClaimRepository(): DatabasePadletClaimRepository {
  return {
    async claim(transaction, input) {
      const tupleDigest = padletTupleDigest(
        input.evidence.evidenceBoardId,
        input.evidence.evidencePostId,
      );
      try {
        await transaction.execute(sql`
          INSERT INTO padlet_evidence_claims
            (provider, board_id, post_id, tuple_digest, claimed_by_tenant_id,
             claimed_by_operation_id, evidence_created_at,
             evidence_author_full_name, claimed_at)
          VALUES
            ('PADLET', ${input.evidence.evidenceBoardId}, ${input.evidence.evidencePostId},
             ${tupleDigest}, ${input.tenantId}, ${input.operationId},
             ${new Date(input.evidence.evidenceCreatedAt)},
             ${input.evidence.evidenceAuthorFullName}, ${input.claimedAt})
        `);
        return 'CLAIMED';
      } catch (error) {
        const databaseError = readDatabaseError(error);
        // The immutable digest registry is the shared namespace for current
        // claims and migrated v1 tombstones. Only known tuple-ownership
        // constraints represent an expected global one-use conflict.
        if (databaseError?.code === '23505'
          && databaseError.constraint
          && CLAIM_CONFLICT_CONSTRAINTS.has(databaseError.constraint)) {
          return 'CONFLICT';
        }
        throw error;
      }
    },
  };
}

export function padletTupleDigest(boardId: string, postId: string): string {
  return createHash('sha256').update(boardId, 'utf8').update('\0').update(postId, 'utf8').digest('hex');
}

type DatabaseErrorIdentity = { code: string; constraint?: string };

function readDatabaseError(error: unknown): DatabaseErrorIdentity | undefined {
  const seen = new Set<object>();
  let current = error;
  let codeOnly: DatabaseErrorIdentity | undefined;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) break;
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') {
      const identity: DatabaseErrorIdentity = {
        code: current.code,
        ...('constraint' in current && typeof current.constraint === 'string'
          ? { constraint: current.constraint }
          : {}),
      };
      if (identity.constraint) return identity;
      codeOnly ??= identity;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return codeOnly;
}
