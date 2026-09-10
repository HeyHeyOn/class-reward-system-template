import 'server-only';
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { getTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { getProductionFreezingConsentDependencies } from './freezingConsentProduction';
import { createFreezingConsentHandlers } from './freezingConsentHandlers';
import { readFreezingConsentSession } from './freezingConsentSession';
import { createFinalBridgeIntake } from './finalBridgeIntake';
import { createRegisteredBridgeClient } from './registeredBridgeClient';
import { validateBridgeRegistration } from './registeredBridgeProducer';
import { continueStartFreezing, readStartFreezingStatus } from './startFreezing';
import { canonicalJson, sha256 } from './validators';

const KEYS = ['tenantId', 'sourceId', 'spreadsheetId', 'deploymentId', 'registrationVersion', 'endpoint', 'approvedScope',
  'requestKeyId', 'requestPublicKey', 'requestPrivateKey', 'manifestKeyId', 'manifestPublicKey', 'writerKeyId', 'writerPublicKey', 'encryptionKey'];
function refused(): never { throw Error('Start freezing configuration refused.'); }
function publicBytes(key: KeyObject) { return key.export({ type: 'spki', format: 'der' }).toString('base64'); }

/** Request-local, explicitly provisioned server configuration. One registered
 * source per tenant in this bounded slice; duplicate/partial registrations fail
 * closed. No credential/endpoint/readers/control-plane authority from HTTP. */
function configuration() {
  const dependencies = getProductionFreezingConsentDependencies();
  const raw = dependencies.env.MIGRATION_START_BRIDGE_REGISTRATIONS;
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
    if (requestPrivateKey.asymmetricKeyType !== 'ed25519'
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
    const registrationDigest = sha256(canonicalJson({ purpose: 'CLASS_STORE_START_BRIDGE_CONFIGURATION_V1', ...publicConfiguration }));
    const bridge = validateBridgeRegistration({ ...publicConfiguration, registrationDigest, requestPublicKey, manifestPublicKey, writerPublicKey });
    const start = { tenantId: bridge.tenantId, sourceId: bridge.sourceId, spreadsheetId: bridge.spreadsheetId,
      deploymentId: bridge.deploymentId, registrationVersion: bridge.registrationVersion, registrationDigest };
    // Instantiate and validate the client before any ceremony SQL/provider effect.
    const client = createRegisteredBridgeClient({ registration: bridge, requestPrivateKey });
    return { start, client, deployment: { ...start, spreadsheetIdDigest: sha256(start.spreadsheetId), keyId: row.manifestKeyId as string,
      signingPublicKey: manifestPublicKey, encryptionKey, writerKeyId: row.writerKeyId as string, writerSigningPublicKey: writerPublicKey } };
  });
  return { dependencies, registrations };
}
function compose(config: ReturnType<typeof configuration>, registration: ReturnType<typeof configuration>['registrations'][number]) {
  const { dependencies } = config;
  return createFreezingConsentHandlers({ ...dependencies, startRegistration: registration.start,
    continueStart: async (request, consent, intake) => {
      const bridgeIntake = createFinalBridgeIntake({ tenantId: registration.start.tenantId,
        getAuthenticatedSubject: async () => readFreezingConsentSession(request, dependencies.origin, dependencies.env).subject,
        registeredDeployments: [registration.deployment], runTransaction: dependencies.runTransaction });
      return continueStartFreezing({ request, consent, intake, runTransaction: dependencies.runTransaction, bridgeIntake,
        adapter: { registration: registration.start, prepare: async intent => {
          const challenge = await bridgeIntake.issueChallenge({ migrationJobId: intent.display.migrationJobId,
            sourceId: intent.display.sourceId, expectedStateVersion: intent.display.expectedStateVersion });
          return { challenge, ...registration.client.prepare({ ceremonyId: intent.ceremonyId, challenge }) };
        } } });
    } });
}
export function getProductionStartFreezingHandlers() {
  try {
    const tenant = getTrustedTenantRequestContext().tenant;
    const config = configuration();
    const matches = config.registrations.filter(r => r.start.tenantId === tenant.id);
    if (matches.length !== 1) refused();
    return compose(config, matches[0]);
  } catch { return refused(); }
}
/** Only authenticated, purpose-separated routing state selects a handler.
 * Selection grants nothing: handler rebinds exact immutable intent, directory,
 * actual session and membership before reservation/exchange and continuation. */
export function getProductionStartFreezingCallbackHandlers(request: Request) {
  try {
    const config = configuration();
    for (const r of config.registrations) {
      const handler = compose(config, r);
      let hint;
      try { hint = handler.readRoutingHint(request); } catch { continue; }
      if (hint.tenantId === r.start.tenantId) return handler;
    }
    return refused();
  } catch { return refused(); }
}
/** Archival availability does not depend on current bridge keys/provisioning.
 * Exact intent digest is a comparison value, never an action capability. */
export function getProductionStartFreezingStatus() {
  const tenantId = getTrustedTenantRequestContext().tenant.id;
  const { origin, env, runTransaction } = getProductionFreezingConsentDependencies();
  return async (request: Request, context: { params: Promise<Record<string, string>> }) => {
    if (request.method !== 'GET' || new URL(request.url).origin !== origin || /[?#]/.test(request.url)) refused();
    const { jobId, attemptId } = await context.params;
    const result = await readStartFreezingStatus({ tenantId, migrationJobId: jobId, ceremonyId: attemptId,
      intentDigest: request.headers.get('x-start-intent-digest') ?? '', request, origin, env, runTransaction });
    return Response.json(result, { headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  };
}
