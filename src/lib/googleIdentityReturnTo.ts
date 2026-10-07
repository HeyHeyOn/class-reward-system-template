export type GoogleIdentityReturnTo = '/classes' | `/c/${string}/admin`;

// Navigation only: the destination page must still authorize tenant membership.
export function parseGoogleIdentityReturnTo(value: unknown): GoogleIdentityReturnTo | undefined {
  if (value === '/classes') return value;
  if (typeof value !== 'string') return undefined;
  const match = /^\/c\/([a-z0-9]+(?:-[a-z0-9]+)*)\/admin$/.exec(value);
  if (!match || match[0] !== value || match[1].length > 63) return undefined;
  return value as GoogleIdentityReturnTo;
}

export function googleIdentityLoginPath(returnTo?: GoogleIdentityReturnTo): string {
  if (!returnTo) return '/admin/login';
  return returnTo === '/classes' ? returnTo : `${returnTo}/login`;
}
