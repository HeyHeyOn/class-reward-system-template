import type { TenantId } from '@/server/repositories/contracts';

const TENANT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SLUG_LENGTH = 63;

export type TenantLifecycle =
  | 'DRAFT'
  | 'IMPORTING'
  | 'READY'
  | 'ACTIVE'
  | 'MIGRATION_READ_ONLY'
  | 'SUSPENDED';

export type TenantRecord = Readonly<{
  id: string;
  slug: string;
  displayName: string;
  lifecycle: TenantLifecycle;
  timezone: 'Asia/Seoul';
}>;

export type TenantContext = Readonly<{
  tenant: TenantRecord & { id: TenantId };
  needsRedirect: boolean;
}>;

export type TenantDirectory = Readonly<{
  findBySlug(slug: string): Promise<TenantRecord | null>;
}>;

export type TenantContextErrorCode =
  | 'INVALID_TENANT_SLUG'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_CONTEXT_MISMATCH';

export class TenantContextError extends Error {
  constructor(
    readonly code: TenantContextErrorCode,
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'TenantContextError';
  }
}

export function parseTenantSlug(value: unknown): { slug: string; needsRedirect: boolean } {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SLUG_LENGTH) {
    throw new TenantContextError('INVALID_TENANT_SLUG', 400, 'Tenant slug is invalid.');
  }
  const slug = value.toLowerCase();
  if (!TENANT_SLUG.test(slug)) {
    throw new TenantContextError('INVALID_TENANT_SLUG', 400, 'Tenant slug is invalid.');
  }
  return { slug, needsRedirect: slug !== value };
}

export function scopedTenantPath(
  requestedSlug: unknown,
  suffix: '' | '/bank' | '/admin' | `/admin/${string}` = '',
): { path: string; needsRedirect: boolean } {
  const parsed = parseTenantSlug(requestedSlug);
  if (suffix.includes('?') || suffix.includes('#') || suffix.includes('..') || suffix.includes('//')) {
    throw new TenantContextError('INVALID_TENANT_SLUG', 400, 'Tenant route suffix is invalid.');
  }
  return { path: `/c/${parsed.slug}${suffix}`, needsRedirect: parsed.needsRedirect };
}

export async function resolveTenantContext(
  requestedSlug: unknown,
  directory: TenantDirectory,
): Promise<TenantContext> {
  const parsed = parseTenantSlug(requestedSlug);
  const tenant = await directory.findBySlug(parsed.slug);
  if (!tenant) {
    throw new TenantContextError('TENANT_NOT_FOUND', 404, 'Tenant was not found.');
  }
  if (tenant.slug !== parsed.slug || !TENANT_UUID.test(tenant.id)) {
    throw new TenantContextError(
      'TENANT_CONTEXT_MISMATCH',
      403,
      'Resolved tenant does not match the requested tenant context.',
    );
  }
  return {
    tenant: tenant as TenantRecord & { id: TenantId },
    needsRedirect: parsed.needsRedirect,
  };
}

export function compatibilityRedirectForPath(
  pathname: string,
  defaultTenantSlug: string | undefined,
): string | null {
  if (!defaultTenantSlug) return null;
  const { slug } = parseTenantSlug(defaultTenantSlug);
  if (pathname === '/') return `/c/${slug}`;
  if (pathname === '/bank') return `/c/${slug}/bank`;
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return `/c/${slug}${pathname}`;
  }
  return null;
}
