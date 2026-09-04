import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGeneratorGrantClaimer } from './generatorGrantClaims';

const grant = {
  grantId: 'single-use-grant-id-that-is-long-enough',
  subject: 'google-subject-123',
  email: 'teacher@example.com',
  clientFingerprint: 'a'.repeat(64),
  expiresAt: Date.now() + 600_000,
};

describe('generator grant claims', () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    const migration = await readFile(resolve(process.cwd(), 'src/server/db/migrations/0011_generator_grant_claims.sql'), 'utf8');
    await database.exec(migration);
  });

  afterEach(async () => {
    await database.close();
  });

  it('atomically allows exactly one concurrent claim of the same grant', async () => {
    const claim = createGeneratorGrantClaimer({ query: (text, values) => database.query(text, values) });

    const results = await Promise.all([claim(grant), claim(grant)]);

    expect(results.sort()).toEqual([false, true]);
    const rows = await database.query<Record<string, unknown>>('SELECT * FROM generator_grant_claims');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      grant_id_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      subject_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      email_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      client_fingerprint: grant.clientFingerprint,
    });
    expect(JSON.stringify(rows.rows)).not.toContain(grant.grantId);
    expect(JSON.stringify(rows.rows)).not.toContain(grant.subject);
    expect(JSON.stringify(rows.rows)).not.toContain(grant.email);
    expect(Object.keys(rows.rows[0])).not.toContain('refresh_token');
  });

  it('does not claim an expired grant', async () => {
    const claim = createGeneratorGrantClaimer({ query: (text, values) => database.query(text, values) });

    await expect(claim({ ...grant, expiresAt: Date.now() - 1 })).resolves.toBe(false);
    const rows = await database.query('SELECT 1 FROM generator_grant_claims');
    expect(rows.rows).toHaveLength(0);
  });

  it('makes consumed claim records append-only', async () => {
    const claim = createGeneratorGrantClaimer({ query: (text, values) => database.query(text, values) });
    await claim(grant);

    await expect(database.exec("UPDATE generator_grant_claims SET client_fingerprint = 'b' || repeat('0', 63)")).rejects.toThrow(/append-only/);
    await expect(database.exec('DELETE FROM generator_grant_claims')).rejects.toThrow(/append-only/);
  });
});
