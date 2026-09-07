// Trusted request context imports node:async_hooks, keeping this policy server-runtime-only.
// Match that module's convention so direct route tests need no application-policy mocks.
import { getOptionalTrustedTenantRequestContext } from './trustedTenantRequestContext';

type LegacyDeploymentEnv = Readonly<Record<string, string | undefined>>;
export type LegacyDeploymentMode = Readonly<{ readOnly: boolean; centralTargetUrl: string | null }>;

// An unrecognized nonempty value must not accidentally re-enable the writer.
function freezeRequested(env: LegacyDeploymentEnv): boolean {
  return Boolean(env.MIGRATION_READ_ONLY && env.MIGRATION_READ_ONLY !== 'false');
}

export function getLegacyDeploymentMode(env: LegacyDeploymentEnv = process.env): LegacyDeploymentMode {
  const readOnly = freezeRequested(env) && env.CLASS_STORE_STORAGE !== 'postgresql';
  return { readOnly, centralTargetUrl: readOnly ? safeCentralTarget(env.MIGRATION_CENTRAL_TARGET_URL) : null };
}

function safeCentralTarget(value: string | undefined): string | null {
  if (!value || value.length > 2048 || /[?#]/.test(value)) return null;
  try {
    const url = new URL(value);
    // Require exact canonical bytes: no URL parser repairs, userinfo, query, hash,
    // encoded/relative paths, or deep links capable of carrying a QR/credential.
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.href !== value || !/^\/c\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(url.pathname)
      || url.pathname.slice(3).length > 63) return null;
    return value;
  } catch {
    return null;
  }
}

/** Refusal only, never routing/auth authority or a Task 19 verified freeze proof. */
export function legacyWriteFreezeResponse(kind?: 'generator-sheets'): Response | null {
  if (kind === 'generator-sheets') {
    if (!freezeRequested(process.env)) return null;
  } else if (getOptionalTrustedTenantRequestContext() || !getLegacyDeploymentMode().readOnly) {
    return null;
  }
  return Response.json({
    code: 'MIGRATION_READ_ONLY',
    error: '이전 서비스는 이전 작업으로 읽기 전용입니다.',
  }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
