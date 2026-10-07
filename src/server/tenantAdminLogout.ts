import 'server-only';
import { createHash } from 'node:crypto';
import { getDatabaseClient } from '@/server/db/client';
import { parseTenantAdminSessionToken, readTenantAdminSessionCookie } from '@/server/tenantAdminSessionCookie';

/** The opaque bearer token is sufficient to revoke only its own session. The
 * narrow database function reveals no tenant or session details to the caller. */
export async function revokeTenantAdminSessionFromRequest(request: Request): Promise<void> {
  if (process.env.CLASS_STORE_STORAGE !== 'postgresql') return;
  const token = readTenantAdminSessionCookie(request);
  const parsed = token ? parseTenantAdminSessionToken(token) : null;
  if (!parsed) return;
  const hash = createHash('sha256').update(parsed.raw, 'utf8').digest('hex');
  await getDatabaseClient().pool.query('SELECT public.platform_revoke_tenant_session($1, $2)', [hash, parsed.sessionVersion]);
}
