const TENANT_PATH = /^\/c\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/|$)/;
const PLATFORM_API = /^\/api\/(?:google|generator)(?:\/|\?|$)/;

export function tenantApiPath(apiPath: string, pathname?: string): string {
  if (!apiPath.startsWith('/api/') || PLATFORM_API.test(apiPath)) return apiPath;
  const currentPathname = pathname ?? (typeof window === 'undefined' ? '' : window.location.pathname);
  const match = TENANT_PATH.exec(currentPathname);
  if (!match) return apiPath;
  return `/api/c/${match[1]}${apiPath.slice('/api'.length)}`;
}

export function tenantFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(typeof input === 'string' ? tenantApiPath(input) : input, init);
}

export function tenantPagePath(pagePath: string, pathname?: string): string {
  if (pagePath !== '/' && pagePath !== '/bank'
    && pagePath !== '/admin' && !pagePath.startsWith('/admin/')) return pagePath;
  const currentPathname = pathname ?? (typeof window === 'undefined' ? '' : window.location.pathname);
  const match = TENANT_PATH.exec(currentPathname);
  if (!match) return pagePath;
  return pagePath === '/' ? `/c/${match[1]}` : `/c/${match[1]}${pagePath}`;
}