import 'server-only';

import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  resolveTenantAdminContext,
  TenantAuthorizationError,
  type TenantAdminContext,
  type TenantAdminContextDependencies,
} from '@/server/tenantAuth';
import { TenantContextError } from '@/server/tenantContext';
import { getProductionTenantAccessDependencies } from '@/server/tenantAccess';
import { hubLoginEnabled } from '@/server/ddanssaem/hub';
import { followHubSignIn, teacherScreenRedirect } from '@/server/ddanssaem/teacherGate';

export type TenantAdminPageNavigation = Readonly<{
  redirect(path: string): never;
  notFound(): never;
}>;

export async function authorizeTenantAdminPage(
  slug: string,
  request: Request,
  dependencies: TenantAdminContextDependencies,
  navigation: TenantAdminPageNavigation,
): Promise<TenantAdminContext> {
  try {
    return await resolveTenantAdminContext(slug, request, dependencies);
  } catch (error) {
    if (error instanceof TenantAuthorizationError && error.code === 'UNAUTHENTICATED') {
      navigation.redirect(`/c/${slug}/admin/login`);
    }
    if (error instanceof TenantAuthorizationError || error instanceof TenantContextError) {
      navigation.notFound();
    }
    throw error;
  }
}

export async function requireTenantAdminPage(slug: string): Promise<TenantAdminContext> {
  const requestHeaders = await headers();
  const path = `/c/${slug}/admin`;
  // With the 딴쌤 hub, a signed-out teacher goes to the hub's sign-in page, not the class's own.
  const hub = hubLoginEnabled();
  const access = await authorizeTenantAdminPage(
    slug,
    new Request(`http://tenant.internal${path}`, { headers: requestHeaders }),
    getProductionTenantAccessDependencies(),
    { redirect: (target) => redirect(hub && target === `${path}/login`
      ? teacherScreenRedirect({ path, session: null, cookieHeader: requestHeaders.get('cookie') }) ?? target : target), notFound },
  );
  if (hub) followHubSignIn(path, access.session, requestHeaders.get('cookie'));
  return access;
}
