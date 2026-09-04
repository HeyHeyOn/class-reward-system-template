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
  return authorizeTenantAdminPage(
    slug,
    new Request(`http://tenant.internal/c/${slug}/admin`, { headers: requestHeaders }),
    getProductionTenantAccessDependencies(),
    { redirect, notFound },
  );
}
