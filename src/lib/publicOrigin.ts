// The address people are given (shared links, QR codes, copied addresses). The production project's
// Vercel addresses (crs-postgresql.vercel.app and each deployment's own address) and the old address
// crs.hwanit.com all stand for class.schoolit.kr, so links made from them use class.schoolit.kr.
// Any other host (local development, another deployment of this code) keeps its own origin.

export const CANONICAL_ORIGIN = 'https://class.schoolit.kr';

const PRODUCTION_PROJECT_HOST = /^crs-postgresql(?:-[a-z0-9]+-hey-hey-on-s-projects)?\.vercel\.app$/;
/** The address the service used before class.schoolit.kr; it now redirects there. */
const OLD_HOST = 'crs.hwanit.com';

export function publicOrigin(location: Pick<Location, 'origin' | 'hostname'> = window.location): string {
  return PRODUCTION_PROJECT_HOST.test(location.hostname) || location.hostname === OLD_HOST ? CANONICAL_ORIGIN : location.origin;
}
