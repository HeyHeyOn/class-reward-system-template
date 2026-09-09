import 'server-only';
import { createPrivateKey, KeyObject, type KeyLike } from 'node:crypto';
import {
  BRIDGE_RESPONSE_LIMIT, readBridgeBytes, signBridgeRequest, validateBridgeRegistration,
  type BridgeRegistration, type BridgeRequestBody,
} from './registeredBridgeProducer';

export type RegisteredBridgeTransportResult = Readonly<
  { outcome: 'RECEIVED'; manifest: unknown } | { outcome: 'NOT_SENT' | 'UNKNOWN' }
>;
/** SERVER COMPOSITION ONLY. Prepare is not permission: the start orchestrator
 * must persist ceremony/challenge/registration/requestDigest dispatch binding,
 * exact readback and COMMIT ACK BEFORE send(). No transaction during network.
 * RECEIVED is untrusted transport data; finalBridgeIntake.accept must verify it.
 * UNKNOWN never means disable did not occur. No retry/recovery/auto-enable.
 */
export function createRegisteredBridgeClient(dependencies: Readonly<{
  registration: BridgeRegistration; requestPrivateKey: KeyLike; timeoutMs?: number;
}>) {
  const registration = validateBridgeRegistration(dependencies.registration);
  const privateKey = dependencies.requestPrivateKey instanceof KeyObject
    ? dependencies.requestPrivateKey : createPrivateKey(dependencies.requestPrivateKey);
  const timeoutMs = dependencies.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Registered bridge refused.');
  return Object.freeze({
    prepare(input: BridgeRequestBody) {
      const signed = signBridgeRequest(registration, privateKey, input);
      // Read detached signed bytes, never mutable caller input after the first await.
      const expiresAt = (JSON.parse(signed.body) as BridgeRequestBody).challenge.expiresAt;
      let attempted = false;
      return Object.freeze({
        requestDigest: signed.requestDigest,
        async send(signal?: AbortSignal): Promise<RegisteredBridgeTransportResult> {
          if (attempted) return { outcome: 'NOT_SENT' };
          attempted = true;
          if (signal?.aborted || Date.now() >= expiresAt) return { outcome: 'NOT_SENT' };
          const controller = new AbortController(); const abort = () => controller.abort();
          signal?.addEventListener('abort', abort, { once: true });
          const timer = setTimeout(abort, Math.min(timeoutMs, expiresAt - Date.now()));
          let onAbort: () => void = () => {};
          const aborted = new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error('Registered bridge unavailable.'));
            controller.signal.addEventListener('abort', onAbort, { once: true });
          });
          try {
            const response = await Promise.race([globalThis.fetch(registration.endpoint, {
              method: 'POST', headers: signed.headers, body: signed.body, redirect: 'error',
              credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
            }), aborted]);
            if (response.status !== 200 || response.headers.get('content-type') !== 'application/json'
              || response.redirected) {
              void response.body?.cancel().catch(() => {}); throw new Error('Invalid response.');
            }
            const bytes = await readBridgeBytes(response.body, BRIDGE_RESPONSE_LIMIT, controller.signal);
            if (Date.now() >= expiresAt || signal?.aborted) throw new Error('Expired response.');
            return { outcome: 'RECEIVED', manifest: JSON.parse(bytes) as unknown };
          } catch { controller.abort(); return { outcome: 'UNKNOWN' }; }
          finally {
            clearTimeout(timer); signal?.removeEventListener('abort', abort);
            controller.signal.removeEventListener('abort', onAbort);
          }
        },
      });
    },
  });
}
