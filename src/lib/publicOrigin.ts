// The address people are given (shared links, QR codes, copied addresses). The production project's
// Vercel addresses (crs-postgresql.vercel.app and each deployment's own address) and the old addresses
// crs.hwanit.com and class.schoolit.kr all stand for class.ddanssaem.com, so links made from them use it.
// Any other host (local development, another deployment of this code) keeps its own origin.

export const CANONICAL_ORIGIN = 'https://class.ddanssaem.com';

const PRODUCTION_PROJECT_HOST = /^crs-postgresql(?:-[a-z0-9]+-hey-hey-on-s-projects)?\.vercel\.app$/;
/** Addresses the service used before class.ddanssaem.com; they now redirect there. */
const OLD_HOSTS = new Set(['crs.hwanit.com', 'class.schoolit.kr']);

export function publicOrigin(location: Pick<Location, 'origin' | 'hostname'> = window.location): string {
  return PRODUCTION_PROJECT_HOST.test(location.hostname) || OLD_HOSTS.has(location.hostname) ? CANONICAL_ORIGIN : location.origin;
}
