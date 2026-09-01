import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TaskCompletionEvidence } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import { isCanonicalPadletPostId } from '@/server/padletClient';

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
  findClaimedPostIds(
    transaction: TenantTransaction,
    boardId: string,
    postIds: readonly string[],
  ): Promise<readonly string[]>;
}

const CLAIM_CONFLICT_CONSTRAINTS = new Set([
  'padlet_claim_digest_registry_pkey',
  'padlet_evidence_claims_pkey',
  'padlet_evidence_claims_digest_unique',
]);

export function createDatabasePadletClaimRepository(): DatabasePadletClaimRepository {
  return {
    async findClaimedPostIds(transaction, boardId, postIds) {
      const requestedPostIds = canonicalClaimLookupRequest(boardId, postIds);
      const result = await transaction.execute(sql`
        SELECT post_id
        FROM padlet_evidence_claims
        WHERE provider = 'PADLET'
          AND board_id = ${boardId}
          AND post_id IN (${sql.join(requestedPostIds.map((postId) => sql`${postId}`), sql`, `)})
        ORDER BY post_id COLLATE "C"
      `);
      return projectClaimedPostIds(result.rows, requestedPostIds);
    },

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

function canonicalClaimLookupRequest(boardId: unknown, postIds: unknown): string[] {
  if (typeof boardId !== 'string'
    || boardId.length < 1
    || boardId.length > 128
    || boardId !== boardId.trim()
    || !Array.isArray(postIds)
    || postIds.length < 1
    || postIds.length > 200) {
    throw new Error('Invalid Padlet claim lookup request.');
  }

  const uniquePostIds = new Set<string>();
  for (const postId of postIds) {
    if (!isCanonicalPadletPostId(postId) || uniquePostIds.has(postId)) {
      throw new Error('Invalid Padlet claim lookup request.');
    }
    uniquePostIds.add(postId);
  }
  return [...uniquePostIds].sort(compareCodeUnits);
}

function projectClaimedPostIds(rows: readonly unknown[], requestedPostIds: readonly string[]): readonly string[] {
  const requested = new Set(requestedPostIds);
  const claimedPostIds: string[] = [];
  let previous: string | undefined;

  for (const row of rows) {
    const ownKeys = typeof row === 'object' && row !== null ? Reflect.ownKeys(row) : [];
    if (typeof row !== 'object' || row === null || Array.isArray(row)
      || Object.getPrototypeOf(row) !== Object.prototype
      || ownKeys.length !== 1
      || ownKeys[0] !== 'post_id') {
      throw new Error('Invalid Padlet claim lookup result row.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(row, 'post_id');
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('Invalid Padlet claim lookup result row.');
    }
    const postId = descriptor.value as unknown;
    if (!isCanonicalPadletPostId(postId)
      || !requested.has(postId)
      || (previous !== undefined && compareCodeUnits(previous, postId) >= 0)) {
      throw new Error('Invalid Padlet claim lookup result row.');
    }
    claimedPostIds.push(postId);
    previous = postId;
  }

  return Object.freeze([...claimedPostIds]);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
