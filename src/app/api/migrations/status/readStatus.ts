import 'server-only';

import { getProductionTenantAccessDependencies } from '@/server/tenantAccess';
import { authorizeTenantAdmin, TenantAuthorizationError } from '@/server/tenantAuth';
import { parseTenantSlug, resolveTenantContext, TenantContextError } from '@/server/tenantContext';
import { isStatusJobId, readJobStatus, type JobReadResult } from './readJobStatus';

// This describes this view's availability, not a migration job's persisted state.
// Existing FREEZING readers are attempt/session-bound archival evidence only.
// Do not substitute local candidates, tenant lifecycle, request flags, or report
// builders for a trusted, tenant-scoped job/authority status reader. Preserve
// this degraded contract when no explicit job selector was provided.
const blockedStatus = Object.freeze({
  availability: 'BLOCKED' as const,
  reasonCode: 'TRUSTED_STATUS_READER_UNAVAILABLE' as const,
  reason: '검증된 이전 상태 조회가 연결되지 않아 진행 상태와 운영 권한을 확인할 수 없습니다.',
  readOnly: true as const,
  migrationStatus: 'UNKNOWN' as const,
  authority: 'UNKNOWN' as const,
});

type MigrationStatusReadResult =
  | JobReadResult
  | Readonly<{ kind: 'BLOCKED'; status: typeof blockedStatus }>
  | Readonly<{ kind: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'UNAVAILABLE' | 'INVALID_REQUEST' }>;

/** Access checks precede any explicit job read. No source probing, preflight,
 * challenge issuance, status repair, or compatibility-session fallback.
 * Never return identity, arbitrary persisted fields or raw exception data. */
export async function readMigrationStatus(
  slug: string,
  request: Request,
  jobId?: unknown,
): Promise<MigrationStatusReadResult> {
  try {
    if (jobId !== undefined && !isStatusJobId(jobId)) return { kind: 'INVALID_REQUEST' };
    if (parseTenantSlug(slug).needsRedirect) return { kind: 'FORBIDDEN' };
    const dependencies = getProductionTenantAccessDependencies();
    const originalCookie = request.headers.get('cookie');
    const session = await dependencies.getSession(request);
    if (!session) return { kind: 'UNAUTHENTICATED' };
    const { subject, issuedAt } = session;
    const hasCurrentIdentity = async () => {
      // Reverify the admitted request, never a replacement identity or a cached
      // session. Leave lifetime/key/format acceptance to the real verifier.
      if (request.headers.get('cookie') !== originalCookie) return false;
      const current = await dependencies.getSession(request);
      return current !== null && current.subject === subject && current.issuedAt === issuedAt
        && request.headers.get('cookie') === originalCookie;
    };

    const { tenant } = await resolveTenantContext(slug, dependencies);
    const membership = await authorizeTenantAdmin(tenant, session, dependencies);
    // Membership I/O must not extend identity lifetime or admit a new job read.
    if (!await hasCurrentIdentity()) return { kind: 'UNAUTHENTICATED' };
    if (typeof jobId === 'string') {
      const result = await readJobStatus(tenant, membership, jobId);
      // The reader has completed rollback/release before this publication gate.
      if (!await hasCurrentIdentity()) return { kind: 'UNAUTHENTICATED' };
      return result;
    }
    return { kind: 'BLOCKED', status: blockedStatus };
  } catch (error) {
    if (error instanceof TenantAuthorizationError || error instanceof TenantContextError) {
      return { kind: 'FORBIDDEN' };
    }
    return { kind: 'UNAVAILABLE' };
  }
}
