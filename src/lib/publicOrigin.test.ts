import { describe, expect, it } from 'vitest';
import { CANONICAL_ORIGIN, publicOrigin } from './publicOrigin';

const at = (origin: string) => ({ origin, hostname: new URL(origin).hostname });

describe('publicOrigin', () => {
  it('gives class.schoolit.kr for the production project’s Vercel addresses and the old address', () => {
    expect(publicOrigin(at('https://crs-postgresql.vercel.app'))).toBe(CANONICAL_ORIGIN);
    expect(publicOrigin(at('https://crs-postgresql-hq5nfhg7r-hey-hey-on-s-projects.vercel.app'))).toBe(CANONICAL_ORIGIN);
    expect(publicOrigin(at('https://crs.hwanit.com'))).toBe('https://class.schoolit.kr');
    expect(publicOrigin(at('https://class.schoolit.kr'))).toBe('https://class.schoolit.kr');
    expect(CANONICAL_ORIGIN).toBe('https://class.schoolit.kr');
  });

  it('keeps any other address as it is', () => {
    expect(publicOrigin(at('http://localhost:3100'))).toBe('http://localhost:3100');
    expect(publicOrigin(at('https://crs-hwanit.vercel.app'))).toBe('https://crs-hwanit.vercel.app');
    expect(publicOrigin(at('https://crs-postgresql-evil.vercel.app'))).toBe('https://crs-postgresql-evil.vercel.app');
    expect(publicOrigin(at('https://crs-postgresql.vercel.app.example.com'))).toBe('https://crs-postgresql.vercel.app.example.com');
  });
});
