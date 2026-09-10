import 'server-only';
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { getTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { getProductionFreezingConsentDependencies } from './freezingConsentProduction';
import { createFreezingReacquisitionIntake, createFreezingReacquisitionStatus } from './freezingReacquisitionIntake';
import { validateFreezingReacquisitionRegistration } from './registeredFreezingReacquisition';
import { canonicalJson, sha256 } from './validators';
import { getDatabaseClient } from '@/server/db/client';
import { createTenantTransactionRunner } from '@/server/db/transaction';

const KEYS = ['tenantId', 'sourceId', 'spreadsheetId', 'deploymentId', 'registrationVersion', 'endpoint', 'approvedScope',
  'requestKeyId', 'requestPublicKey', 'requestPrivateKey', 'manifestKeyId', 'manifestPublicKey', 'writerKeyId', 'writerPublicKey', 'encryptionKey'];
function refused(): never { throw Error('Freezing reacquisition configuration refused.'); }
function publicBytes(key: KeyObject) { return key.export({ type: 'spki', format: 'der' }).toString('base64'); }

/** Request-local, explicitly provisioned server configuration. One registered
 * source per tenant in this bounded slice; duplicate/partial registrations fail
 * closed. No credential/endpoint/readers/control-plane authority from HTTP. */
function configuration() {
  const dependencies = getProductionFreezingConsentDependencies();
  const raw = dependencies.env.MIGRATION_FREEZING_REACQUISITION_REGISTRATIONS;
  if (!raw || Buffer.byteLength(raw) > 128_000) refused();
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows) || !rows.length || rows.length > 256) refused();
  const seen = new Set<string>();
  const registrations = rows.map(row => {
    if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== [...KEYS].sort().join(',')) refused();
    for (const k of KEYS) if (typeof row[k] !== 'string' || !row[k] || (!k.endsWith('Key') && row[k].trim() !== row[k]) || row[k].length > 8192) refused();
    if (seen.has(row.tenantId)) refused(); seen.add(row.tenantId);
    const sheets = dependencies.registeredSheets.filter(s => s.tenantId === row.tenantId && s.sourceId === row.sourceId && s.spreadsheetId === row.spreadsheetId);
    if (sheets.length !== 1) refused();
    const requestPrivateKey = createPrivateKey(row.requestPrivateKey);
    const requestPublicKey = createPublicKey(row.requestPublicKey);
    const manifestPublicKey = createPublicKey(row.manifestPublicKey);
    const writerPublicKey = createPublicKey(row.writerPublicKey);
    if ([requestPrivateKey, requestPublicKey, manifestPublicKey, writerPublicKey].some(k => k.asymmetricKeyType !== 'ed25519')
      || publicBytes(createPublicKey(requestPrivateKey)) !== publicBytes(requestPublicKey)) refused();
    for (const k of ['manifestKeyId', 'writerKeyId']) if (!/^[A-Za-z0-9_-]{1,128}$/.test(row[k])) refused();
    if (new Set([row.requestKeyId, row.manifestKeyId, row.writerKeyId]).size !== 3) refused();
    const encryptionKey = Buffer.from(row.encryptionKey, 'base64');
    if (encryptionKey.length !== 32 || encryptionKey.toString('base64') !== row.encryptionKey) refused();
    const publicConfiguration = { tenantId: row.tenantId as string, sourceId: row.sourceId as string,
      spreadsheetId: row.spreadsheetId as string, deploymentId: row.deploymentId as string,
      registrationVersion: row.registrationVersion as string, endpoint: row.endpoint as string,
      approvedScope: row.approvedScope, requestKeyId: row.requestKeyId as string,
      requestPublicKey: publicBytes(requestPublicKey), manifestKeyId: row.manifestKeyId as string,
      manifestPublicKey: publicBytes(manifestPublicKey), writerKeyId: row.writerKeyId as string,
      writerPublicKey: publicBytes(writerPublicKey), encryptionKeyDigest: sha256(encryptionKey.toString('base64')) };
    const registrationDigest = sha256(canonicalJson({ purpose: 'CLASS_STORE_FREEZING_REACQUISITION_CONFIGURATION_V1', ...publicConfiguration }));
    const bridge = validateFreezingReacquisitionRegistration({ ...publicConfiguration, registrationDigest, requestPublicKey, manifestPublicKey, writerPublicKey });
    return { registration: bridge, requestPrivateKey, encryptionKey, manifestKeyId: row.manifestKeyId as string };
  });
  return { dependencies, registrations };
}

/** Archival identity/membership and exact original intent only: no dispatch,
 * producer, encryption or Google resource credential configuration needed. */
export function getProductionFreezingReacquisitionStatus(migrationJobId: string) {
  const { tenant } = getTrustedTenantRequestContext();
  const env = Object.freeze({ ...process.env });
  if (env.CLASS_STORE_STORAGE !== 'postgresql' || !env.MIGRATION_GOOGLE_OAUTH_ORIGIN) refused();
  return createFreezingReacquisitionStatus({ tenantId: tenant.id, migrationJobId, env,
    origin: env.MIGRATION_GOOGLE_OAUTH_ORIGIN,
    canonicalPath: `/api/c/${tenant.slug}/migrations/${migrationJobId}/freezing/reacquisition`,
    runTransaction: createTenantTransactionRunner({ get pool() { return getDatabaseClient().pool; } },
      { maxAttempts: 1, isolationLevel: 'READ COMMITTED' }) });
}
/** The canonical directory owns tenant/slug; HTTP and old start registration
 * never select companion configuration or confer read approval. */
export function getProductionFreezingReacquisitionHandlers(migrationJobId: string) {
  try {
    const { tenant } = getTrustedTenantRequestContext();
    const { dependencies, registrations } = configuration();
    const matches = registrations.filter(r => r.registration.tenantId === tenant.id);
    if (matches.length !== 1) refused();
    return createFreezingReacquisitionIntake({ ...matches[0], tenantId: tenant.id, migrationJobId,
      origin: dependencies.origin, env: dependencies.env, runTransaction: dependencies.runTransaction,
      canonicalPath: `/api/c/${tenant.slug}/migrations/${migrationJobId}/freezing/reacquisition` });
  } catch { return refused(); }
}
