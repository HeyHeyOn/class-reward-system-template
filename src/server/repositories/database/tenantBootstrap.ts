import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import {
  assertVerifiedGoogleSourceControlProof,
  getVerifiedGoogleSourceControlClaims,
  type VerifiedGoogleSourceControlProof,
} from '@/server/migration/googleSourceControl';
import { parseTenantSlug } from '@/server/tenantContext';

const SHA256 = /^[0-9a-f]{64}$/;
const SCRYPT = /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const allowedInputKeys = new Set(['slug', 'displayName', 'owner', 'proof', 'sourceFingerprint', 'credentialHashes']);
const allowedOwnerKeys = new Set(['subject', 'email', 'name']);
const allowedCredentialHashKeys = new Set(['adminPasswordHash', 'recoveryCodeHash']);

type ImportedCredentialHash = Readonly<{
  kind: 'ADMIN_PASSWORD' | 'RECOVERY_CODE';
  secretHash: string;
  hashAlgorithm: 'scrypt' | 'sha256';
}>;

export type TenantBootstrapInput = Readonly<{
  slug: string;
  displayName: string;
  owner: Readonly<{ subject: string; email: string; name?: string }>;
  proof: VerifiedGoogleSourceControlProof;
  sourceFingerprint: string;
  credentialHashes?: Readonly<{
    adminPasswordHash?: string;
    recoveryCodeHash?: string;
  }>;
}>;

type ValidatedTenantBootstrapInput = Omit<TenantBootstrapInput, 'credentialHashes'> & Readonly<{
  importedCredentials: ImportedCredentialHash[];
}>;

export type TenantBootstrapResult = Readonly<{
  tenantId: string;
  slug: string;
  userId: string;
  membershipId: string;
  role: 'OWNER';
  jobId: string;
  sourceId: string;
  externalSourceId: string;
}>;

type QueryResult = { rows: Record<string, unknown>[] };
type Queryable = {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
};

export type TenantBootstrapDependencies = Readonly<{
  runTransaction<TResult>(callback: (transaction: Queryable) => Promise<TResult>): Promise<TResult>;
  createId?: () => string;
}>;

export function createTenantBootstrapper(dependencies: TenantBootstrapDependencies) {
  const createId = dependencies.createId ?? randomUUID;
  return async function bootstrapTenant(input: unknown): Promise<TenantBootstrapResult> {
    const validated = validateInput(input);
    const proofClaims = getVerifiedGoogleSourceControlClaims(validated.proof);
    const tenantId = createId();
    const membershipId = createId();
    const jobId = `bootstrap-${createId()}`;
    const sourceId = `google-sheet-${createId()}`;
    const canonicalEmail = validated.owner.email.trim().toLowerCase();
    const ownershipSubjectHash = createHash('sha256').update(proofClaims.googleSubject).digest('hex');
    const importedCredentials = validated.importedCredentials;

    return dependencies.runTransaction(async (transaction) => {
      await transaction.query(
        `SELECT set_config('app.tenant_id', $1, true)`,
        [tenantId],
      );
      const user = await transaction.query(
        `INSERT INTO users (google_subject, canonical_email, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (google_subject) DO UPDATE
           SET updated_at = users.updated_at
         RETURNING id, google_subject, canonical_email`,
        [validated.owner.subject, canonicalEmail, validated.owner.name?.trim() || null],
      );
      const userRow = user.rows[0];
      if (!userRow
        || userRow.google_subject !== validated.owner.subject
        || userRow.canonical_email !== canonicalEmail
        || typeof userRow.id !== 'string') {
        throw new Error('Google identity conflicts with an existing platform identity.');
      }
      const userId = userRow.id;

      await transaction.query(
        `INSERT INTO tenants (id, slug, display_name, lifecycle)
         VALUES ($1, $2, $3, 'DRAFT')`,
        [tenantId, validated.slug, validated.displayName.trim()],
      );
      await transaction.query(
        `INSERT INTO tenant_memberships (tenant_id, id, user_id, role)
         VALUES ($1, $2, $3, 'OWNER')`,
        [tenantId, membershipId, userId],
      );
      for (const credential of importedCredentials) {
        await transaction.query(
          `INSERT INTO tenant_auth_secrets (tenant_id, kind, secret_hash, hash_algorithm, version)
           VALUES ($1, $2, $3, $4, 1)`,
          [tenantId, credential.kind, credential.secretHash, credential.hashAlgorithm],
        );
      }
      await transaction.query(
        `INSERT INTO migration_jobs (tenant_id, job_id, status)
         VALUES ($1, $2, 'DISCOVERED')`,
        [tenantId, jobId],
      );
      await transaction.query(
        `INSERT INTO migration_sources (
           tenant_id, job_id, source_id, provider, external_source_id,
           ownership_subject_hash, source_fingerprint
         ) VALUES ($1, $2, $3, 'GOOGLE_SHEETS', $4, $5, $6)`,
        [
          tenantId,
          jobId,
          sourceId,
          proofClaims.externalSourceId,
          ownershipSubjectHash,
          validated.sourceFingerprint,
        ],
      );

      return {
        tenantId,
        slug: validated.slug,
        userId,
        membershipId,
        role: 'OWNER',
        jobId,
        sourceId,
        externalSourceId: proofClaims.externalSourceId,
      };
    });
  };
}

function validateInput(input: unknown): ValidatedTenantBootstrapInput {
  if (!isRecord(input) || hasUnexpectedKeys(input, allowedInputKeys)
    || !isRecord(input.owner) || hasUnexpectedKeys(input.owner, allowedOwnerKeys)
    || typeof input.displayName !== 'string' || !input.displayName.trim()
    || typeof input.owner.subject !== 'string' || !input.owner.subject.trim()
    || input.owner.subject !== input.owner.subject.trim()
    || typeof input.owner.email !== 'string' || !EMAIL.test(input.owner.email.trim())
    || (input.owner.name !== undefined && (typeof input.owner.name !== 'string' || !input.owner.name.trim()))
    || typeof input.sourceFingerprint !== 'string' || !SHA256.test(input.sourceFingerprint)) {
    throw new Error('Tenant bootstrap input is invalid.');
  }
  const { slug } = parseTenantSlug(input.slug);
  if (slug !== input.slug) throw new Error('Tenant bootstrap slug must be canonical.');
  assertVerifiedGoogleSourceControlProof(input.proof);
  const claims = getVerifiedGoogleSourceControlClaims(input.proof);
  if (claims.googleSubject !== input.owner.subject
    || claims.googleEmail !== input.owner.email.trim().toLowerCase()) {
    throw new Error('The verified Google source control capability does not match the tenant owner.');
  }
  return {
    slug: input.slug,
    displayName: input.displayName,
    owner: {
      subject: input.owner.subject,
      email: input.owner.email,
      ...(input.owner.name === undefined ? {} : { name: input.owner.name }),
    },
    proof: input.proof,
    sourceFingerprint: input.sourceFingerprint,
    importedCredentials: parseImportedCredentialHashes(input.credentialHashes),
  };
}

function parseImportedCredentialHashes(value: unknown): ImportedCredentialHash[] {
  if (value === undefined) return [];
  if (!isRecord(value) || hasUnexpectedKeys(value, allowedCredentialHashKeys)) {
    throw new Error('Tenant bootstrap input is invalid.');
  }
  const credentials: ImportedCredentialHash[] = [];
  if (value.adminPasswordHash !== undefined) {
    if (typeof value.adminPasswordHash !== 'string'
      || (!SCRYPT.test(value.adminPasswordHash) && !SHA256.test(value.adminPasswordHash))) {
      throw new Error('Tenant bootstrap input is invalid.');
    }
    credentials.push({
      kind: 'ADMIN_PASSWORD',
      secretHash: value.adminPasswordHash,
      hashAlgorithm: SCRYPT.test(value.adminPasswordHash) ? 'scrypt' : 'sha256',
    });
  }
  if (value.recoveryCodeHash !== undefined) {
    if (typeof value.recoveryCodeHash !== 'string' || !SHA256.test(value.recoveryCodeHash)) {
      throw new Error('Tenant bootstrap input is invalid.');
    }
    credentials.push({ kind: 'RECOVERY_CODE', secretHash: value.recoveryCodeHash, hashAlgorithm: 'sha256' });
  }
  if (credentials.length === 0) throw new Error('Tenant bootstrap input is invalid.');
  return credentials;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnexpectedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}
