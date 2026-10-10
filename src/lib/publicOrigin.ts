// The address people are given (shared links, QR codes, copied addresses). The production project's
// Vercel addresses — crs-postgresql.vercel.app, which redirects there, and each deployment's own
// address — all stand for crs.hwanit.com, so links made from them use crs.hwanit.com.
// Any other host (local development, another deployment of this code) keeps its own origin.

export const CANONICAL_ORIGIN = 'https://crs.hwanit.com';

const PRODUCTION_PROJECT_HOST = /^crs-postgresql(?:-[a-z0-9]+-hey-hey-on-s-projects)?\.vercel\.app$/;

export function publicOrigin(location: Pick<Location, 'origin' | 'hostname'> = window.location): string {
  return PRODUCTION_PROJECT_HOST.test(location.hostname) ? CANONICAL_ORIGIN : location.origin;
}
