import 'server-only';

import {
  resolveTenantAdminContext,
  TenantAuthorizationError,
  type TenantAdminContextDependencies,
} from '@/server/tenantAuth';
import {
  resolveTenantContext,
  TenantContextError,
  type TenantDirectory,
} from '@/server/tenantContext';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';

export type TenantApiAccess = 'public' | 'admin';
export type TenantApiAccessResolver = TenantApiAccess | ((request: Request) => TenantApiAccess);
export type TenantApiHandler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response> | Response;
export type TenantApiRoute = Readonly<{
  method: string;
  pattern: string;
  access: TenantApiAccessResolver;
  handler: TenantApiHandler;
}>;

export function createTenantApiDispatcher(
  dependencies: TenantDirectory & TenantAdminContextDependencies,
  routes: readonly TenantApiRoute[],
) {
  return async function dispatch(
    request: Request,
    routeContext: { slug: unknown; path: string[] },
  ): Promise<Response> {
    const route = findRoute(routes, request.method, routeContext.path);
    if (!route) return Response.json({ error: 'Not found.' }, { status: 404 });

    try {
      const access = typeof route.route.access === 'function'
        ? route.route.access(request)
        : route.route.access;
      const resolved = access === 'admin'
        ? await resolveTenantAdminContext(routeContext.slug, request, dependencies)
        : await resolveTenantContext(routeContext.slug, dependencies);
      const context = access === 'admin'
        ? resolved
        : { ...resolved, session: undefined, membership: undefined };
      const legacyRequest = await rewriteScopedRequest(request, routeContext.slug as string, routeContext.path);
      return await runWithTrustedTenantRequestContext(context, () =>
        route.route.handler(legacyRequest, { params: Promise.resolve(route.params) }));
    } catch (error) {
      if (error instanceof TenantContextError || error instanceof TenantAuthorizationError) {
        return Response.json({ error: error.message, code: error.code }, { status: error.status });
      }
      throw error;
    }
  };
}

function findRoute(routes: readonly TenantApiRoute[], method: string, path: string[]) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = route.pattern.split('/').filter(Boolean);
    if (pattern.length !== path.length) continue;
    const params: Record<string, string> = {};
    let matches = true;
    for (let index = 0; index < pattern.length; index += 1) {
      const expected = pattern[index];
      const actual = path[index];
      const parameter = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(expected);
      if (parameter) params[parameter[1]] = actual;
      else if (expected !== actual) matches = false;
    }
    if (matches) return { route, params };
  }
  return undefined;
}

async function rewriteScopedRequest(request: Request, slug: string, path: string[]): Promise<Request> {
  const url = new URL(request.url);
  const expectedPrefix = `/api/c/${encodeURIComponent(slug)}/`;
  if (!url.pathname.startsWith(expectedPrefix)) {
    throw new TenantContextError('TENANT_CONTEXT_MISMATCH', 403, 'Request URL does not match tenant route context.');
  }
  url.pathname = `/api/${path.map(encodeURIComponent).join('/')}`;
  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : await request.arrayBuffer();
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: request.redirect,
    signal: request.signal,
  });
}
