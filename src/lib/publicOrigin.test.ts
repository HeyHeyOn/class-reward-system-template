import { describe, expect, it } from 'vitest';
import { CANONICAL_ORIGIN, publicOrigin } from './publicOrigin';

const at = (origin: string) => ({ origin, hostname: new URL(origin).hostname });

describe('publicOrigin', () => {
  it('gives crs.hwanit.com for the production project’s Vercel addresses', () => {
    expect(publicOrigin(at('https://crs-postgresql.vercel.app'))).toBe(CANONICAL_ORIGIN);
    expect(publicOrigin(at('https://crs-postgresql-hq5nfhg7r-hey-hey-on-s-projects.vercel.app'))).toBe(CANONICAL_ORIGIN);
    expect(publicOrigin(at('https://crs.hwanit.com'))).toBe('https://crs.hwanit.com');
  });

  it('keeps any other address as it is', () => {
    expect(publicOrigin(at('http://localhost:3100'))).toBe('http://localhost:3100');
    expect(publicOrigin(at('https://crs-hwanit.vercel.app'))).toBe('https://crs-hwanit.vercel.app');
    expect(publicOrigin(at('https://crs-postgresql-evil.vercel.app'))).toBe('https://crs-postgresql-evil.vercel.app');
    expect(publicOrigin(at('https://crs-postgresql.vercel.app.example.com'))).toBe('https://crs-postgresql.vercel.app.example.com');
  });
});
