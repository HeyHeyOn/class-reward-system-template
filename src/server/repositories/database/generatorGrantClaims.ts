import { createHash } from 'node:crypto';

export type GeneratorGrantClaim = {
  grantId: string;
  subject: string;
  email: string;
  clientFingerprint: string;
  expiresAt: number;
};

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export function createGeneratorGrantClaimer(queryable: Queryable) {
  return async (grant: GeneratorGrantClaim): Promise<boolean> => {
    const result = await queryable.query(
      `INSERT INTO generator_grant_claims (
         grant_id_hash, subject_hash, email_hash, client_fingerprint, expires_at, consumed_at
       )
       SELECT $1, $2, $3, $4, $5::timestamptz, now()
       WHERE $5::timestamptz > now()
       ON CONFLICT (grant_id_hash) DO NOTHING
       RETURNING grant_id_hash`,
      [
        hash(grant.grantId),
        hash(grant.subject),
        hash(grant.email.trim().toLowerCase()),
        grant.clientFingerprint,
        new Date(grant.expiresAt).toISOString(),
      ],
    );
    return result.rows.length === 1;
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
