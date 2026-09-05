// node:async_hooks makes this module server-runtime-only while keeping route unit tests importable.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { GoogleSession } from '@/server/googleOAuth';
import type { TenantCompatibilitySession, TenantMembership } from '@/server/tenantAuth';
import type { TenantRecord } from '@/server/tenantContext';

export type TrustedTenantRequestContext = Readonly<{
  tenant: TenantRecord;
  session?: GoogleSession;
  membership?: TenantMembership;
  compatibilitySession?: TenantCompatibilitySession;
}>;

const storage = new AsyncLocalStorage<TrustedTenantRequestContext>();

export function runWithTrustedTenantRequestContext<TResult>(
  context: TrustedTenantRequestContext,
  callback: () => TResult,
): TResult {
  return storage.run(Object.freeze({ ...context }), callback);
}

export function getTrustedTenantRequestContext(): TrustedTenantRequestContext {
  const context = storage.getStore();
  if (!context) throw new Error('Trusted tenant request context is unavailable.');
  return context;
}

export function getOptionalTrustedTenantRequestContext(): TrustedTenantRequestContext | undefined {
  return storage.getStore();
}
