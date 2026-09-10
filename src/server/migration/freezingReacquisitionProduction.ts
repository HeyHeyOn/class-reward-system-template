import 'server-only';
import { Pool } from 'pg';
import { Readable } from 'node:stream';
import type { GaxiosOptions } from 'gaxios';
import { attachDatabasePool } from '@vercel/functions';
import { createDeploymentSheetsAuth } from '@/server/googleOAuth';
import { createFreezingProducerReservations } from './freezingProducerReservations';
import { createGoogleWorkbookSnapshotReader } from './googleWorkbookSnapshotReader';
import { createRegisteredFreezingReacquisition, validateFreezingReacquisitionRegistration, type FreezingReacquisitionRegistration } from './registeredFreezingReacquisition';

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
 * Missing phase registration/explicit read scope/dedicated DB is terminal refusal. */
export function getProductionFreezingReacquisitionProducer() {
  try {
    const env = Object.freeze({ ...process.env });
    const raw = env.CLASS_STORE_FREEZING_PRODUCER_REGISTRATION;
    if (env.CLASS_STORE_STORAGE !== 'sheets' || !raw || Buffer.byteLength(raw) > 16_384) throw Error();
    const parsed: unknown = JSON.parse(raw);
    const keys = ['endpoint', 'deploymentId', 'registrationVersion', 'registrationDigest', 'approvedScope',
      'tenantId', 'sourceId', 'spreadsheetId', 'requestKeyId', 'requestPublicKey', 'manifestPublicKey', 'writerPublicKey'];
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(',') !== keys.sort().join(',')) throw Error();
    const registration = validateFreezingReacquisitionRegistration(parsed as FreezingReacquisitionRegistration);
    const url = env.CLASS_STORE_BRIDGE_PRODUCER_DATABASE_URL;
    if (!url || Buffer.byteLength(url) > 8192) throw Error();
    const database = new URL(url);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname
      || decodeURIComponent(database.username) !== registration.deploymentId
      || Buffer.byteLength(registration.deploymentId) > 63
      || env.GOOGLE_SHEET_ID !== registration.spreadsheetId) throw Error();
    // Fail before even reserving a request when local read provisioning is absent
    // or malformed. These fixed server URLs are the allowlist; HTTP cannot supply them.
    for (const [urlName, tokenName] of [
      ['LEGACY_REDIS_WRITER_CONTROL_URL', 'LEGACY_REDIS_WRITER_CONTROL_TOKEN'],
      ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    ]) {
      const value = env[urlName]; const token = env[tokenName];
      if (!value || Buffer.byteLength(value) > 2048 || value.trim() !== value || value.includes('?') || value.includes('#')
        || !token || Buffer.byteLength(token) > 4096 || /[\x00-\x20\x7f]/.test(token)) throw Error();
      const endpoint = new URL(value);
      const testControl = env.NODE_ENV === 'test' && urlName === 'LEGACY_REDIS_WRITER_CONTROL_URL'
        && endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1';
      if ((!testControl && endpoint.protocol !== 'https:') || !endpoint.hostname || endpoint.username || endpoint.password) throw Error();
    }
    const keyId = env.CLASS_STORE_BRIDGE_MANIFEST_KEY_ID;
    const signingPrivateKey = env.CLASS_STORE_BRIDGE_MANIFEST_PRIVATE_KEY;
    const encryption = env.CLASS_STORE_BRIDGE_MANIFEST_ENCRYPTION_KEY;
    if (!keyId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(keyId) || !signingPrivateKey || !encryption || !/^[A-Za-z0-9+/]{43}=$/.test(encryption)) throw Error();
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
    const reservations = createFreezingProducerReservations({ connect: () => pool(url).connect() }, registration.deploymentId);
    return createRegisteredFreezingReacquisition({ registration, reservations,
      sheets: createGoogleWorkbookSnapshotReader({ auth, expiresAt: Date.now() + 60_000 }, registration.spreadsheetId),
      manifest: { keyId, signingPrivateKey, encryptionKey } });
  } catch { throw Error('Bridge configuration refused.'); }
}
