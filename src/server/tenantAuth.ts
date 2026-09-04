import 'server-only';

import type { GoogleSession } from '@/server/googleOAuth';
import {
  resolveTenantContext,
  type TenantContext,
  type TenantDirectory,
  type TenantRecord,
} from '@/server/tenantContext';

export type TenantMembershipRole = 'OWNER' | 'ADMIN';

export type TenantMembership = Readonly<{
  id: string;
  tenantId: string;
  userId: string;
  googleSubject: string;
  role: TenantMembershipRole;
}>;

export type TenantMembershipStore = Readonly<{
  findByTenantAndSubject(tenantId: string, googleSubject: string): Promise<TenantMembership | null>;
}>;

export type TenantAuthorizationErrorCode =
  | 'UNAUTHENTICATED'
  | 'NOT_A_MEMBER'
  | 'MEMBERSHIP_CONTEXT_MISMATCH'
  | 'UNSUPPORTED_MEMBERSHIP_ROLE';

export class TenantAuthorizationError extends Error {
  constructor(
    readonly code: TenantAuthorizationErrorCode,
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = 'TenantAuthorizationError';
  }
}

export async function authorizeTenantAdmin(
  tenant: TenantRecord,
  session: Pick<GoogleSession, 'subject'> | null,
  memberships: TenantMembershipStore,
): Promise<TenantMembership> {
  if (!session) {
    throw new TenantAuthorizationError('UNAUTHENTICATED', 401, 'Google authentication is required.');
  }
  const membership = await memberships.findByTenantAndSubject(tenant.id, session.subject);
  if (!membership) {
    throw new TenantAuthorizationError('NOT_A_MEMBER', 403, 'Tenant membership is required.');
  }
  if (membership.tenantId !== tenant.id || membership.googleSubject !== session.subject) {
    throw new TenantAuthorizationError(
      'MEMBERSHIP_CONTEXT_MISMATCH',
      403,
      'Membership does not match the selected tenant and authenticated identity.',
    );
  }
  if (membership.role !== 'OWNER' && membership.role !== 'ADMIN') {
    throw new TenantAuthorizationError(
      'UNSUPPORTED_MEMBERSHIP_ROLE',
      403,
      'Membership role has no tenant-admin authority.',
    );
  }
  return membership;
}

export type TenantAdminContextDependencies = TenantDirectory & TenantMembershipStore & Readonly<{
  getSession(request: Request): GoogleSession | null | Promise<GoogleSession | null>;
}>;

export type TenantAdminContext = TenantContext & Readonly<{
  session: GoogleSession;
  membership: TenantMembership;
}>;

export async function resolveTenantAdminContext(
  requestedSlug: unknown,
  request: Request,
  dependencies: TenantAdminContextDependencies,
): Promise<TenantAdminContext> {
  // Tenant authority comes only from the canonical path slug and trusted directory.
  // Request headers, query parameters and bodies are deliberately not candidates.
  const context = await resolveTenantContext(requestedSlug, dependencies);
  const session = await dependencies.getSession(request);
  const membership = await authorizeTenantAdmin(context.tenant, session, dependencies);
  if (!session) {
    throw new TenantAuthorizationError('UNAUTHENTICATED', 401, 'Google authentication is required.');
  }
  return { ...context, session, membership };
}
