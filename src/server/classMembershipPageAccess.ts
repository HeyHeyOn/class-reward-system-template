import 'server-only';

import type { GoogleSession } from '@/server/googleOAuth';
import type {
  ClassMembership,
  ClassMembershipRepository,
} from '@/server/repositories/database/classMemberships';
import type { TenantLifecycle } from '@/server/tenantContext';
import type { TenantMembershipRole } from '@/server/tenantAuth';

export type ClassMembershipPageModel =
  | Readonly<{ kind: 'LOGIN_REQUIRED'; loginHref: '/api/google/login?returnTo=%2Fclasses' }>
  | Readonly<{
      kind: 'MEMBERSHIPS';
      accountLabel: string;
      memberships: ClassMembershipPageItem[];
    }>;

export type ClassMembershipPageItem = Readonly<{
  slug: string;
  displayName: string;
  roleLabel: string;
  lifecycleLabel: string;
  href: `/c/${string}` | null;
  selectable: boolean;
}>;

export type ClassMembershipPageDependencies = ClassMembershipRepository & Readonly<{
  getSession(request: Request): GoogleSession | null | Promise<GoogleSession | null>;
}>;

const roleLabels: Record<TenantMembershipRole, string> = {
  OWNER: '소유자',
  ADMIN: '관리자',
};

const lifecycleLabels: Record<TenantLifecycle, string> = {
  DRAFT: '준비 중',
  IMPORTING: '가져오는 중',
  READY: '활성화 대기',
  ACTIVE: '사용 중',
  MIGRATION_READ_ONLY: '읽기 전용 전환 중',
  SUSPENDED: '사용 중지',
};

export async function loadClassMembershipPage(
  request: Request,
  dependencies: ClassMembershipPageDependencies,
): Promise<ClassMembershipPageModel> {
  const session = await dependencies.getSession(request);
  if (!session) {
    return { kind: 'LOGIN_REQUIRED', loginHref: '/api/google/login?returnTo=%2Fclasses' };
  }

  const memberships = await dependencies.listByGoogleSubject(session.subject);
  return {
    kind: 'MEMBERSHIPS',
    accountLabel: session.name?.trim() || session.email,
    memberships: memberships.map(toPageItem),
  };
}

function toPageItem(membership: ClassMembership): ClassMembershipPageItem {
  const selectable = membership.lifecycle === 'ACTIVE';
  return {
    slug: membership.slug,
    displayName: membership.displayName,
    roleLabel: roleLabels[membership.role],
    lifecycleLabel: lifecycleLabels[membership.lifecycle],
    href: selectable ? `/c/${membership.slug}` : null,
    selectable,
  };
}
