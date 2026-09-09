import 'server-only';
import { Pool } from 'pg';
import { Readable } from 'node:stream';
import type { GaxiosOptions } from 'gaxios';
import { attachDatabasePool } from '@vercel/functions';
import { createDeploymentSheetsAuth } from '@/server/googleOAuth';
import { createBridgeProducerReservations } from './bridgeProducerReservations';
import { createGoogleWorkbookSnapshotReader } from './googleWorkbookSnapshotReader';
import { createRegisteredBridgeProducer, validateBridgeRegistration, type BridgeRegistration } from './registeredBridgeProducer';

let replayPool: { url: string; pool: Pool } | undefined;
function pool(url: string): Pool {
  // Dedicated companion credentials. Never fall back to the tenant database pool.
  // A deployment/credential change needs a process restart, not pooled authority mixing.
  if (replayPool && replayPool.url !== url) throw Error('Bridge configuration refused.');
  if (!replayPool) {
    const created = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 4000,
      idleTimeoutMillis: 10_000, statement_timeout: 4000, query_timeout: 4500 });
    try { attachDatabasePool(created); } catch { void created.end().catch(() => {}); throw Error('Bridge configuration refused.'); }
    replayPool = { url, pool: created };
  }
  return replayPool.pool;
}

/** Fixed companion SERVER root. No request parameter, OAuth consent handle,
 * browser credentials, arbitrary source reader or control callback is accepted.
 * Uses this existing legacy deployment's durable GOOGLE_* refresh credential.
 * Missing registration/explicit disable scope/dedicated DB is terminal refusal. */
export function getProductionBridgeProducer() {
  try {
    const env = Object.freeze({ ...process.env });
    const raw = env.CLASS_STORE_BRIDGE_PRODUCER_REGISTRATION;
    if (env.CLASS_STORE_STORAGE !== 'sheets' || !raw || Buffer.byteLength(raw) > 16_384) throw Error();
    const parsed: unknown = JSON.parse(raw);
    const keys = ['endpoint', 'deploymentId', 'registrationVersion', 'registrationDigest', 'approvedScope',
      'tenantId', 'sourceId', 'spreadsheetId', 'requestKeyId', 'requestPublicKey', 'manifestPublicKey', 'writerPublicKey'];
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(',') !== keys.sort().join(',')) throw Error();
    const registration = validateBridgeRegistration(parsed as BridgeRegistration);
    const url = env.CLASS_STORE_BRIDGE_PRODUCER_DATABASE_URL;
    if (!url || Buffer.byteLength(url) > 8192) throw Error();
    const database = new URL(url);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname
      || decodeURIComponent(database.username) !== registration.deploymentId
      || Buffer.byteLength(registration.deploymentId) > 63
      || env.GOOGLE_SHEET_ID !== registration.spreadsheetId) throw Error();
    const keyId = env.CLASS_STORE_BRIDGE_MANIFEST_KEY_ID;
    const signingPrivateKey = env.CLASS_STORE_BRIDGE_MANIFEST_PRIVATE_KEY;
    const encryption = env.CLASS_STORE_BRIDGE_MANIFEST_ENCRYPTION_KEY;
    if (!keyId || !signingPrivateKey || !encryption || !/^[A-Za-z0-9+/]{43}=$/.test(encryption)) throw Error();
    const encryptionKey = Buffer.from(encryption, 'base64');
    if (encryptionKey.length !== 32 || encryptionKey.toString('base64') !== encryption) throw Error();
    const auth = createDeploymentSheetsAuth(env);
    if (!auth) throw Error();
    // Durable refresh is not consent exchange. Bound the SDK token response too:
    // the workbook adapter cannot bound a refresh that happens below auth.request.
    const transport = auth.transporter.request.bind(auth.transporter);
    auth.transporter.request = (async (options: GaxiosOptions = {}) => {
      const bounded = { ...options, retry: false, retryConfig: { retry: 0, noResponseRetries: 0 },
        maxRedirects: 0, timeout: 10_000, validateStatus: () => true };
      if (options.responseType === 'stream') return transport(bounded);
      const controller = new AbortController(); let stream: Readable | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); stream?.destroy(); reject(Error('Bridge credential unavailable.')); }, 10_000);
        });
        const read = async () => {
          const response = await transport({ ...bounded, responseType: 'stream', signal: controller.signal });
          if (!(response.data instanceof Readable)) throw Error();
          stream = response.data;
          if (controller.signal.aborted || response.status !== 200) throw Error();
          const coding = response.headers.get('content-encoding') ?? 'identity';
          const declared = response.headers.get('content-length');
          if (!['identity', 'gzip', 'deflate', 'br'].includes(coding)
            || (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || BigInt(declared) > BigInt(128_000)))) throw Error();
          let bytes = 0; const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            const part = Buffer.from(chunk); bytes += part.length;
            if (controller.signal.aborted || bytes > 128_000) throw Error();
            chunks.push(part);
          }
          if (coding === 'identity' && declared !== null && BigInt(declared) !== BigInt(bytes)) throw Error();
          return { ...response, data: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) };
        };
        return await Promise.race([read(), timeout]);
      } catch { throw Error('Bridge credential unavailable.'); }
      finally { if (timer) clearTimeout(timer); controller.abort(); stream?.destroy(); }
    }) as typeof auth.transporter.request;
    const reservations = createBridgeProducerReservations({ connect: () => pool(url).connect() }, registration.deploymentId);
    return createRegisteredBridgeProducer({ registration, reservations,
      sheets: createGoogleWorkbookSnapshotReader({ auth, expiresAt: Date.now() + 60_000 }, registration.spreadsheetId),
      manifest: { keyId, signingPrivateKey, encryptionKey } });
  } catch { throw Error('Bridge configuration refused.'); }
}
