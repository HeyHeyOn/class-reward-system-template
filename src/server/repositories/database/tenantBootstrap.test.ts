import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  verifyGoogleSheetSourceControl,
  type VerifiedGoogleSourceControlProof,
} from '@/server/migration/googleSourceControl';
import { createTenantBootstrapper } from '@/server/repositories/database/tenantBootstrap';

const fingerprint = 'a'.repeat(64);
const NOW = Date.parse('2026-09-04T02:00:00.000Z');
const adminPasswordHash = `scrypt$16384$8$1$${'b'.repeat(32)}$${'c'.repeat(64)}`;
const recoveryCodeHash = 'd'.repeat(64);

type VerifiedBinding = Readonly<{
  proof: VerifiedGoogleSourceControlProof;
  subject: string;
  email: string;
  externalSourceId: string;
}>;

async function verifiedBinding(overrides: Partial<Omit<VerifiedBinding, 'proof'>> = {}): Promise<VerifiedBinding> {
  const subject = overrides.subject ?? 'google-subject-owner';
  const email = overrides.email ?? 'owner@example.com';
  const externalSourceId = overrides.externalSourceId ?? 'sheet-source-one';
  const proof = await verifyGoogleSheetSourceControl({
    fileId: externalSourceId,
    session: { subject, email, issuedAt: NOW - 60_000 },
    reader: {
      readMetadataAndPermissions: async () => ({
        observedAt: NOW - 1_000,
        file: {
          id: externalSourceId,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          trashed: false,
          owners: [{ emailAddress: email }],
        },
        permissions: [{ type: 'user', role: 'owner', emailAddress: email, deleted: false }],
      }),
    },
    now: () => NOW,
  });
  return { proof, subject, email, externalSourceId };
}

function input(slug: string, binding: VerifiedBinding) {
  return {
    slug,
    displayName: `${slug} display`,
    owner: {
      subject: binding.subject,
      email: binding.email,
      name: 'Teacher',
    },
    proof: binding.proof,
    sourceFingerprint: fingerprint,
  };
}

function untrustedInput(slug: string, proof: unknown) {
  return {
    slug,
    displayName: `${slug} display`,
    owner: { subject: 'google-subject-owner', email: 'owner@example.com', name: 'Teacher' },
    proof,
    sourceFingerprint: fingerprint,
  };
}

describe('verified source tenant bootstrap', () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite({ extensions: { pgcrypto } });
    for (const migration of [
      '0001_identity_tenants.sql',
      '0002_operational.sql',
      '0003_operations_migrations.sql',
    ]) {
      await database.exec(await readFile(resolve(process.cwd(), 'src/server/db/migrations', migration), 'utf8'));
    }
  });

  afterEach(async () => {
    await database.close();
  });

  function bootstrapper() {
    return createTenantBootstrapper({
      runTransaction: async (callback) => database.transaction(async (transaction) => callback({
        query: (text, values) => transaction.query(text, values) as never,
      })),
    });
  }

  it('atomically creates tenant, owner membership, migration job, and one source binding', async () => {
    const binding = await verifiedBinding();
    const result = await bootstrapper()(input('alpha-class', binding));

    expect(result).toMatchObject({ slug: 'alpha-class', role: 'OWNER', externalSourceId: 'sheet-source-one' });
    const rows = await database.query<Record<string, unknown>>(`
      SELECT t.slug, tm.role, u.google_subject, mj.status, ms.provider,
             ms.external_source_id, ms.ownership_subject_hash
      FROM tenants t
      JOIN tenant_memberships tm ON tm.tenant_id = t.id
      JOIN users u ON u.id = tm.user_id
      JOIN migration_jobs mj ON mj.tenant_id = t.id
      JOIN migration_sources ms ON ms.tenant_id = t.id AND ms.job_id = mj.job_id
    `);
    expect(rows.rows).toEqual([expect.objectContaining({
      slug: 'alpha-class',
      role: 'OWNER',
      google_subject: binding.subject,
      status: 'DISCOVERED',
      provider: 'GOOGLE_SHEETS',
      external_source_id: binding.externalSourceId,
      ownership_subject_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })]);
  });

  it('imports supported tenant credential hashes in the same bootstrap transaction without plaintext', async () => {
    const binding = await verifiedBinding();
    await bootstrapper()({
      ...input('alpha-class', binding),
      credentialHashes: { adminPasswordHash, recoveryCodeHash },
    });

    const secrets = await database.query<Record<string, unknown>>(`
      SELECT kind, secret_hash, hash_algorithm, version
      FROM tenant_auth_secrets
      ORDER BY kind
    `);
    expect(secrets.rows).toEqual([
      { kind: 'ADMIN_PASSWORD', secret_hash: adminPasswordHash, hash_algorithm: 'scrypt', version: 1 },
      { kind: 'RECOVERY_CODE', secret_hash: recoveryCodeHash, hash_algorithm: 'sha256', version: 1 },
    ]);
  });

  it.each([
    ['plaintext admin password', { adminPasswordHash: 'teacher-password' }],
    ['malformed recovery hash', { recoveryCodeHash: 'recovery-code' }],
    ['unknown credential field', { adminPassword: 'teacher-password' }],
  ])('rejects %s before opening a transaction', async (_label, credentialHashes) => {
    const runTransaction = vi.fn();
    const bootstrap = createTenantBootstrapper({ runTransaction });

    await expect(bootstrap({
      ...input('alpha-class', await verifiedBinding()),
      credentialHashes,
    })).rejects.toThrow(/bootstrap input is invalid/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('rolls back the whole second bootstrap when the source is already bound', async () => {
    const bootstrap = bootstrapper();
    await bootstrap(input('alpha-class', await verifiedBinding()));

    await expect(bootstrap(input('beta-class', await verifiedBinding({
      subject: 'google-subject-other',
      email: 'other@example.com',
    })))).rejects.toThrow();

    const counts = await database.query<{ tenants: number; memberships: number; sources: number; users: number }>(`
      SELECT
        (SELECT count(*)::int FROM tenants) tenants,
        (SELECT count(*)::int FROM tenant_memberships) memberships,
        (SELECT count(*)::int FROM migration_sources) sources,
        (SELECT count(*)::int FROM users) users
    `);
    expect(counts.rows).toEqual([{ tenants: 1, memberships: 1, sources: 1, users: 1 }]);
  });

  it('rejects a structurally valid plain JSON proof before opening a transaction', async () => {
    const runTransaction = vi.fn();
    const bootstrap = createTenantBootstrapper({ runTransaction });

    await expect(bootstrap(untrustedInput('alpha-class', {
      externalSourceId: 'sheet-source-one',
      googleSubject: 'google-subject-owner',
      googleEmail: 'owner@example.com',
      role: 'OWNER',
      verifiedAt: new Date(NOW).toISOString(),
    })))
      .rejects.toThrow(/verified Google source control capability/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['subject', { subject: 'google-subject-other', email: 'owner@example.com', name: 'Teacher' }],
    ['email', { subject: 'google-subject-owner', email: 'other@example.com', name: 'Teacher' }],
  ])('rejects a real capability bound to a different owner %s before opening a transaction', async (_field, owner) => {
    const runTransaction = vi.fn();
    const bootstrap = createTenantBootstrapper({ runTransaction });
    const binding = await verifiedBinding();

    await expect(bootstrap({
      ...input('alpha-class', binding),
      owner,
    })).rejects.toThrow(/does not match the tenant owner/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });
});
