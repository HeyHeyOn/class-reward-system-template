import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantImportTransactionRunner } from './importer';
import type { TenantTransaction } from '@/server/db/transaction';

const COLUMNS = ['tenant_id', 'receipt_id', 'job_id', 'source_id', 'provider', 'external_source_id',
  'actor_user_id', 'actor_subject', 'action', 'expected_status', 'expected_state_version', 'source_fingerprint',
  'issued_at_ms', 'expires_at_ms', 'issuer_digest', 'content_digest',
  'final_sheet_digest', 'final_redis_digest', 'final_report_digest'] as const;
const KEYS = [...COLUMNS, 'replay_digest'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
type RecordBindings = Record<string, string | null>;
function parse(input: Record<string, unknown>, tenantId: string): RecordBindings {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Reflect.ownKeys(input).length !== KEYS.length) throw new Error('shape');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const value: RecordBindings = {};
  for (const key of KEYS) {
    const d = descriptors[key];
    if (!d?.enumerable || !('value' in d) || (typeof d.value !== 'string' && d.value !== null)) throw new Error('shape');
    value[key] = d.value;
  }
  if (value.tenant_id !== tenantId) throw new Error('tenant');
  for (const key of ['tenant_id', 'receipt_id', 'actor_user_id']) if (!UUID.test(value[key] ?? '')) throw new Error('uuid');
  for (const key of ['job_id', 'source_id', 'external_source_id', 'actor_subject']) {
    const s = value[key];
    if (!s || s.trim() !== s || s.length > (key === 'actor_subject' ? 255 : 1024)) throw new Error('identity');
  }
  for (const key of ['source_fingerprint', 'issuer_digest', 'content_digest', 'replay_digest']) {
    if (!DIGEST.test(value[key] ?? '')) throw new Error('digest');
  }
  for (const key of ['expected_state_version', 'issued_at_ms', 'expires_at_ms']) {
    if (!/^(0|[1-9][0-9]{0,15})$/.test(value[key] ?? '') || BigInt(value[key]!) > BigInt(9007199254740991)) throw new Error('number');
  }
  if (BigInt(value.expected_state_version!) < BigInt(1) || BigInt(value.expires_at_ms!) <= BigInt(value.issued_at_ms!)
    || BigInt(value.expires_at_ms!) - BigInt(value.issued_at_ms!) > BigInt(600000)) throw new Error('time');
  const activation = value.action === 'ACTIVATE_APPROVAL';
  if (value.provider !== 'GOOGLE_SHEETS' || !['START_FREEZING_APPROVAL', 'FREEZING_CONSENT', 'ACTIVATE_APPROVAL'].includes(value.action ?? '')
    || value.expected_status !== (activation ? 'FINAL_IMPORT' : 'READY')) throw new Error('action');
  for (const key of ['final_sheet_digest', 'final_redis_digest', 'final_report_digest']) {
    if (activation ? !DIGEST.test(value[key] ?? '') : value[key] !== null) throw new Error('final');
  }
  return value;
}
async function exactReadback(tx: TenantTransaction, v: RecordBindings) {
  const { rows } = await tx.execute(sql`SELECT r.*, p.replay_digest,
    r.expected_state_version::text AS expected_state_version, r.issued_at_ms::text AS issued_at_ms,
    r.expires_at_ms::text AS expires_at_ms FROM migration_authority_receipts r
    JOIN migration_authority_replays p ON p.tenant_id=r.tenant_id AND p.receipt_id=r.receipt_id
    WHERE r.tenant_id=${v.tenant_id} AND r.receipt_id=${v.receipt_id}`);
  if (rows.length !== 1 || KEYS.some((key) => rows[0][key] !== v[key])) throw new Error('readback');
  return { storage: 'NON_AUTHORITY' as const, receiptId: v.receipt_id! };
}
/** Internal consistency only. No authenticated intake exists: these records are NOT
 * capabilities, session authentication, consent, source control or permission to act.
 * Never compose directly with a public request or a forward state transition.
 * Replay digests must eventually be derived by separately reviewed trusted intake.
 */
export function createNonAuthorityReceiptStorage(dependencies: { tenantId: string; runTransaction: TenantImportTransactionRunner }) {
  const { tenantId, runTransaction } = dependencies;
  return {
    async append(input: Record<string, unknown>) {
      try {
        const v = parse(input, tenantId);
        return await runTransaction(tenantId, async (tx) => {
          const { rows: tenants } = await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${tenantId} FOR UPDATE`);
          if (tenants.length !== 1 || tenants[0].lifecycle !== 'IMPORTING') throw new Error('tenant');
          const { rows: jobs } = await tx.execute(sql`SELECT status,state_version::text AS version,source_fingerprint
            FROM migration_jobs WHERE tenant_id=${tenantId} AND job_id=${v.job_id} FOR UPDATE`);
          if (jobs.length !== 1 || jobs[0].status !== v.expected_status || jobs[0].version !== v.expected_state_version
            || jobs[0].source_fingerprint !== v.source_fingerprint) throw new Error('job');
          const { rows: sources } = await tx.execute(sql`SELECT provider,external_source_id,source_fingerprint
            FROM migration_sources WHERE tenant_id=${tenantId} AND job_id=${v.job_id} AND source_id=${v.source_id} FOR SHARE`);
          if (sources.length !== 1 || ['provider', 'external_source_id', 'source_fingerprint'].some((key) => sources[0][key] !== v[key])) throw new Error('source');
          const { rows: actors } = await tx.execute(sql`SELECT u.id FROM users u JOIN tenant_memberships m ON m.user_id=u.id
            WHERE m.tenant_id=${tenantId} AND u.id=${v.actor_user_id} AND u.google_subject=${v.actor_subject}
            AND m.role IN ('OWNER','ADMIN') FOR SHARE OF u,m`);
          if (actors.length !== 1) throw new Error('membership');
          const { rows: clock } = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms`);
          const now = BigInt(String(clock[0].ms));
          if (BigInt(v.issued_at_ms!) > now || BigInt(v.expires_at_ms!) <= now) throw new Error('freshness');
          await tx.execute(sql`INSERT INTO migration_authority_receipts (${sql.join(COLUMNS.map((key) => sql.identifier(key)), sql`,`)})
            VALUES (${sql.join(COLUMNS.map((key) => sql`${v[key]}`), sql`,`)})`);
          // No ON CONFLICT: even identical retries consume the same external artifact twice.
          await tx.execute(sql`INSERT INTO migration_authority_replays (replay_digest,tenant_id,receipt_id)
            VALUES (${v.replay_digest},${tenantId},${v.receipt_id})`);
          return exactReadback(tx, v);
        });
      } catch { throw new Error('Receipt storage refused.'); }
    },
    async recover(input: Record<string, unknown>) {
      try {
        const v = parse(input, tenantId);
        // Archival equality only, deliberately not a fresh-state or expiry authorization.
        return await runTransaction(tenantId, (tx) => exactReadback(tx, v));
      } catch { throw new Error('Receipt storage refused.'); }
    },
  };
}
