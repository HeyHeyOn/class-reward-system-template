import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  acquireDeploymentLocalRedisReader,
  createRedisNeverConfiguredProof,
  createRedisWriterDisableEvidence,
  runLegacyMigrationBridge,
} from './legacyMigrationBridge';
import { openLegacyBridgeManifest } from './migration/legacyBridgeManifest';
import type { LegacyRedisSnapshotReader } from './migration/redisClaimSnapshot';

const NOW = Date.parse('2026-09-05T00:00:00.000Z');
const signing = generateKeyPairSync('ed25519');
const neverConfiguredTrust = generateKeyPairSync('ed25519');
const untrustedAttestations = generateKeyPairSync('ed25519');
const writerDisableTrust = generateKeyPairSync('ed25519');
const cryptoOptions = { keyId: 'bridge-1', encryptionKey: randomBytes(32), signingPrivateKey: signing.privateKey };
const CONTROL_EVIDENCE = `sha256:${'a'.repeat(64)}`;
const sheetReader = {
  listSheetNames: async () => ['Students', 'Products', 'Transactions', 'Adjustments', 'Settings', 'Tasks'],
  getRows: async (name: string) => name === 'Settings'
    ? [['key', 'value'], ['schemaVersion', '1'], ['adminPasswordHash', 'a'.repeat(64)]]
    : [['id'], ['one']],
  getRevision: async () => 'sheet-r1',
};

describe('deployment-local legacy migration bridge', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const emptyRedisReader: LegacyRedisSnapshotReader = {
    getRevision: async () => 'redis-r1',
    hscan: async () => ({ cursor: '0', entries: [] }),
    scan: async () => ({ cursor: '0', keys: [] }),
    get: async () => null,
  };
  const baseInput = (mode: 'preflight' | 'final-delta' = 'preflight') => ({
    deploymentId: 'legacy-1', mode, capturedAt: new Date(NOW).toISOString(),
    sheets: { spreadsheetId: 'sheet-1', reader: sheetReader }, crypto: cryptoOptions,
  });
  const stubRedis = () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://local-upstash.example');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'local-secret');
  };
  const pem = (key: Parameters<typeof Buffer.from>[0] | { export(options: object): string | Buffer }) =>
    'export' in Object(key) ? String((key as { export(options: object): string | Buffer }).export({ type: 'spki', format: 'pem' })) : String(key);
  const stubNeverConfiguredTrust = () => {
    vi.stubEnv('CLASS_STORE_REDIS_NEVER_CONFIGURED_KEY_ID', 'never-configured-1');
    vi.stubEnv('CLASS_STORE_REDIS_NEVER_CONFIGURED_PUBLIC_KEY', pem(neverConfiguredTrust.publicKey));
  };
  const stubWriterDisableTrust = () => {
    vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_KEY_ID', 'writer-disable-1');
    vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PUBLIC_KEY', pem(writerDisableTrust.publicKey));
    vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PRIVATE_KEY', String(writerDisableTrust.privateKey.export({ type: 'pkcs8', format: 'pem' })));
  };
  const stubWriterControl = () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_URL', 'http://127.0.0.1:8787/legacy-redis-writer');
    vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_TOKEN', 'writer-control-secret');
  };
  const controlState = (generation = 41) => ({
    version: 1,
    deploymentId: 'legacy-1',
    source: 'UPSTASH_REDIS_REST',
    status: 'DISABLED',
    disabled: true,
    generation,
    evidence: generation === 41 ? CONTROL_EVIDENCE : `sha256:${'b'.repeat(64)}`,
    disabledAt: new Date(NOW).toISOString(),
  });
  const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

  it('rejects caller-injected Redis readers, verification keys, and disable callbacks', async () => {
    expectTypeOf<Parameters<typeof runLegacyMigrationBridge>[0]>().not.toHaveProperty('redisReader');
    expectTypeOf<Parameters<typeof runLegacyMigrationBridge>[0]>().not.toHaveProperty('redisNeverConfigured');
    expectTypeOf<Parameters<typeof runLegacyMigrationBridge>[0]>().not.toHaveProperty('writerDisableSigningPublicKey');
    expectTypeOf<Parameters<typeof runLegacyMigrationBridge>[0]>().not.toHaveProperty('disableRedisWriter');
    stubRedis();
    const injectedDisable = vi.fn(async () => createRedisWriterDisableEvidence({
      deploymentId: 'legacy-1', disabledAt: new Date(NOW).toISOString(), keyId: 'attacker',
      controlGeneration: 1, controlEvidence: `sha256:${'c'.repeat(64)}`,
      signingPrivateKey: untrustedAttestations.privateKey,
    }));
    const injections: readonly Record<string, unknown>[] = [
      { redisReader: emptyRedisReader },
      {
        redisNeverConfigured: {
          proof: createRedisNeverConfiguredProof({
            deploymentId: 'legacy-1', issuedAt: new Date(NOW).toISOString(), keyId: 'attacker',
            signingPrivateKey: untrustedAttestations.privateKey,
          }),
          signingPublicKey: untrustedAttestations.publicKey,
        },
      },
      { writerDisableSigningPublicKey: untrustedAttestations.publicKey },
      { disableRedisWriter: injectedDisable },
      { writerControlUrl: 'https://attacker.invalid/control' },
      { writerControlToken: 'attacker-token' },
      { writerControlFetch: vi.fn() },
      { redisConfigured: false },
    ];
    for (const injectedOptions of injections) {
      const injected = { ...baseInput(), ...injectedOptions } as unknown as Parameters<typeof runLegacyMigrationBridge>[0];
      await expect(runLegacyMigrationBridge(injected)).rejects.toThrow(/unexpected|caller|injected|blocked/i);
    }
    expect(injectedDisable).not.toHaveBeenCalled();
  });

  it('acquires Redis internally from deployment-local configuration', async () => {
    stubRedis();
    const commands: unknown[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body)) as unknown[];
      commands.push(command);
      const result = command[0] === 'HSCAN' ? ['0', []] : command[0] === 'SCAN' ? ['0', []] : null;
      expect(init).toMatchObject({
        method: 'POST', cache: 'no-store', redirect: 'error', credentials: 'omit',
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ result });
    }));

    const result = await runLegacyMigrationBridge(baseInput());

    expect(result.redisAcquisition).toBe('CAPTURED');
    expect(commands).toEqual([
      ['HSCAN', 'padlet:evidence-bindings:v2', '0', 'COUNT', 500],
      ['SCAN', '0', 'MATCH', 'padlet:evidence-claim:v1:*', 'COUNT', 500],
      ['HSCAN', 'padlet:evidence-bindings:v2', '0', 'COUNT', 500],
      ['SCAN', '0', 'MATCH', 'padlet:evidence-claim:v1:*', 'COUNT', 500],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/local-secret|local-upstash/i);
  });

  it('does not let a caller-owned self-signed proof establish never-configured trust', async () => {
    stubNeverConfiguredTrust();
    const proof = createRedisNeverConfiguredProof({
      deploymentId: 'legacy-1', issuedAt: new Date(NOW).toISOString(), keyId: 'attacker',
      signingPrivateKey: untrustedAttestations.privateKey,
    });

    await expect(runLegacyMigrationBridge({ ...baseInput(), redisNeverConfiguredProof: proof }))
      .rejects.toThrow(/never-configured|proof|key|invalid/i);
  });

  it('accepts a never-configured proof only under the deployment trust anchor', async () => {
    stubNeverConfiguredTrust();
    const proof = createRedisNeverConfiguredProof({
      deploymentId: 'legacy-1', issuedAt: new Date(NOW).toISOString(), keyId: 'never-configured-1',
      signingPrivateKey: neverConfiguredTrust.privateKey,
    });

    const result = await runLegacyMigrationBridge({ ...baseInput(), redisNeverConfiguredProof: proof });

    expect(result.redisAcquisition).toBe('PROVEN_NEVER_CONFIGURED');
    expect(result.writerDisabled).toBe(false);
  });

  it('blocks missing Redis configuration without deployment-rooted proof', async () => {
    await expect(runLegacyMigrationBridge(baseInput())).rejects.toThrow(/never-configured|redis|blocked/i);
  });

  it('acquires complete bounded HSCAN and SCAN plus GET data using only local Upstash env', async () => {
    stubRedis();
    const commands: unknown[][] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body)) as unknown[];
      commands.push(command);
      const name = command[0];
      const result = name === 'HSCAN'
        ? (command[2] === '0' ? ['7', ['field-1', 'value-1']] : ['0', ['field-2', 'value-2']])
        : name === 'SCAN'
          ? ['0', [`padlet:evidence-claim:v1:${'d'.repeat(64)}`]]
          : name === 'GET' ? 'legacy-owner' : null;
      return jsonResponse({ result });
    });
    const reader = await acquireDeploymentLocalRedisReader({ fetch, pageSize: 2, maxPages: 3, maxRecords: 4 });

    expect(reader).not.toBeNull();
    expect(commands).toEqual([
      ['HSCAN', 'padlet:evidence-bindings:v2', '0', 'COUNT', 2],
      ['HSCAN', 'padlet:evidence-bindings:v2', '7', 'COUNT', 2],
      ['SCAN', '0', 'MATCH', 'padlet:evidence-claim:v1:*', 'COUNT', 2],
      ['GET', `padlet:evidence-claim:v1:${'d'.repeat(64)}`],
      ['HSCAN', 'padlet:evidence-bindings:v2', '0', 'COUNT', 2],
      ['HSCAN', 'padlet:evidence-bindings:v2', '7', 'COUNT', 2],
      ['SCAN', '0', 'MATCH', 'padlet:evidence-claim:v1:*', 'COUNT', 2],
      ['GET', `padlet:evidence-claim:v1:${'d'.repeat(64)}`],
    ]);
    expect(JSON.stringify(reader)).not.toMatch(/local-secret|local-upstash/i);
  });

  it('fails closed on malformed Upstash responses and cursor cycles', async () => {
    stubRedis();
    const malformed = vi.fn(async () => jsonResponse({ result: ['0', ['odd']] }));
    await expect(acquireDeploymentLocalRedisReader({ fetch: malformed })).rejects.toThrow(/malformed|upstash/i);

    const cycling = vi.fn(async () => jsonResponse({ result: ['1', []] }));
    await expect(acquireDeploymentLocalRedisReader({ fetch: cycling, maxPages: 3 })).rejects.toThrow(/cycle|pagination/i);
  });

  it('aborts a stalled Upstash response within the request timeout', async () => {
    vi.useFakeTimers();
    stubRedis();
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      requestSignal = init.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(stream, { headers: { 'content-type': 'application/json' } });
    });

    const pending = acquireDeploymentLocalRedisReader({ fetch });
    const rejected = expect(pending).rejects.toThrow(/Upstash (request failed|response is malformed)/i);
    await vi.advanceTimersByTimeAsync(5_001);
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
  });

  it.each([
    ['absent', undefined],
    ['deceptively small', '1'],
  ])('cancels and aborts an oversized streamed Upstash response with %s Content-Length', async (_label, contentLength) => {
    stubRedis();
    let cancelled = false;
    let suppliedChunks = 0;
    let requestSignal: AbortSignal | undefined;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        suppliedChunks += 1;
        if (suppliedChunks <= 5) controller.enqueue(new Uint8Array(300_000));
        else controller.close();
      },
      cancel() { cancelled = true; },
    });
    const response = new Response(stream, {
      headers: {
        'content-type': 'application/json',
        ...(contentLength === undefined ? {} : { 'content-length': contentLength }),
      },
    });
    const json = vi.spyOn(response, 'json');
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      requestSignal = init.signal ?? undefined;
      return response;
    });

    await expect(acquireDeploymentLocalRedisReader({ fetch })).rejects.toThrow(/Upstash response is malformed/i);
    expect(cancelled).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(suppliedChunks).toBeLessThanOrEqual(5);
  });

  it('rejects malformed streamed Upstash JSON without using response.json()', async () => {
    stubRedis();
    const response = new Response('{', { headers: { 'content-type': 'application/json' } });
    const json = vi.spyOn(response, 'json');

    await expect(acquireDeploymentLocalRedisReader({ fetch: async () => response }))
      .rejects.toThrow(/Upstash response is malformed/i);
    expect(json).not.toHaveBeenCalled();
  });

  it('blocks the production bridge before Sheets capture when two complete Redis acquisitions differ', async () => {
    stubRedis();
    const key = `padlet:evidence-claim:v1:${'e'.repeat(64)}`;
    let scanPass = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body)) as unknown[];
      if (command[0] === 'HSCAN') return jsonResponse({ result: ['0', []] });
      if (command[0] === 'SCAN') {
        scanPass += 1;
        return jsonResponse({ result: ['0', scanPass === 1 ? [] : [key]] });
      }
      return jsonResponse({ result: 'owner' });
    }));
    const listSheetNames = vi.fn(sheetReader.listSheetNames);

    await expect(runLegacyMigrationBridge({
      ...baseInput(), sheets: { spreadsheetId: 'sheet-1', reader: { ...sheetReader, listSheetNames } },
    })).rejects.toThrow(/Redis source changed|mutation/i);
    expect(listSheetNames).not.toHaveBeenCalled();
  });

  it('accepts different scan orders and produces the same canonical source revision', async () => {
    stubRedis();
    const keys = [
      `padlet:evidence-claim:v1:${'1'.repeat(64)}`,
      `padlet:evidence-claim:v1:${'2'.repeat(64)}`,
    ];
    const hashEntries = [
      [`claim:${'3'.repeat(64)}`, 'operation-a'] as const,
      [`claim:${'4'.repeat(64)}`, 'operation-b'] as const,
    ];
    const flatten = (entries: readonly (readonly [string, string])[]) => entries.flatMap(([field, value]) => [field, value]);
    const runWithOrders = async (
      hashOrders: readonly (readonly (readonly [string, string])[])[],
      keyOrders: readonly (readonly string[])[],
    ) => {
      let hscan = 0;
      let scan = 0;
      vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const command = JSON.parse(String(init?.body)) as unknown[];
        if (command[0] === 'HSCAN') return jsonResponse({ result: ['0', flatten(hashOrders[hscan++]!)] });
        if (command[0] === 'SCAN') return jsonResponse({ result: ['0', keyOrders[scan++]] });
        return jsonResponse({ result: command[1] === keys[0] ? 'owner-a' : 'owner-b' });
      }));
      const result = await runLegacyMigrationBridge(baseInput());
      return openLegacyBridgeManifest<{ redisSnapshot: { sourceRevision: string } }>(result.manifest, {
        encryptionKey: cryptoOptions.encryptionKey,
        signingPublicKey: signing.publicKey,
        nonceConsumer: { consumeOnce: async () => true },
        now: () => NOW,
      });
    };

    const reversedHashEntries = [...hashEntries].reverse();
    const reversedKeys = [...keys].reverse();
    const first = await runWithOrders([hashEntries, reversedHashEntries], [keys, reversedKeys]);
    const second = await runWithOrders([reversedHashEntries, hashEntries], [reversedKeys, keys]);
    expect(first.redisSnapshot.sourceRevision).toBe(second.redisSnapshot.sourceRevision);
  });

  it('disables the actual writer and verifies it before capture, then re-verifies the same generation immediately after Sheets capture', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stubRedis();
    stubWriterDisableTrust();
    stubWriterControl();
    const events: string[] = [];
    const instrumentedSheetReader = {
      getRevision: async () => {
        events.push('sheets-revision');
        return sheetReader.getRevision();
      },
      listSheetNames: async () => {
        events.push('sheets-list');
        return sheetReader.listSheetNames();
      },
      getRows: async (name: string) => {
        events.push(`sheets-rows-${name}`);
        return sheetReader.getRows(name);
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('127.0.0.1')) {
        events.push(`control-${init?.method}`);
        expect(init).toMatchObject({
          cache: 'no-store', redirect: 'error', credentials: 'omit',
          headers: {
            authorization: 'Bearer writer-control-secret',
            accept: 'application/json',
          },
        });
        if (init?.method === 'POST') {
          expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
          expect(JSON.parse(String(init.body))).toEqual({
            action: 'disable', deploymentId: 'legacy-1', source: 'UPSTASH_REDIS_REST',
          });
        } else {
          expect(init?.method).toBe('GET');
          expect(init?.body).toBeUndefined();
        }
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return jsonResponse(controlState());
      }
      const command = JSON.parse(String(init?.body)) as unknown[];
      events.push(`redis-${String(command[0])}`);
      const result = command[0] === 'HSCAN' || command[0] === 'SCAN' ? ['0', []] : null;
      return jsonResponse({ result });
    }));

    const result = await runLegacyMigrationBridge({
      ...baseInput('final-delta'),
      sheets: { spreadsheetId: 'sheet-1', reader: instrumentedSheetReader },
    });

    expect(events).toEqual([
      'control-POST', 'control-GET',
      'redis-HSCAN', 'redis-SCAN', 'redis-HSCAN', 'redis-SCAN',
      'sheets-revision', 'sheets-list',
      'sheets-rows-Students', 'sheets-rows-Products', 'sheets-rows-Transactions',
      'sheets-rows-Adjustments', 'sheets-rows-Settings', 'sheets-rows-Tasks',
      'sheets-revision',
      'control-GET',
    ]);
    expect(result.writerDisabled).toBe(true);
    expect(result.writerDisableEvidence).toMatchObject({
      status: 'DISABLED', deploymentId: 'legacy-1', keyId: 'writer-disable-1',
      controlGeneration: 41, controlEvidence: CONTROL_EVIDENCE,
    });
    expect(JSON.stringify(result)).not.toMatch(/local-secret|local-upstash|writer-control-secret|127\.0\.0\.1|BEGIN PRIVATE KEY/i);
    const opened = await openLegacyBridgeManifest<{ writerDisableEvidence: unknown }>(result.manifest, {
      encryptionKey: cryptoOptions.encryptionKey,
      signingPublicKey: signing.publicKey,
      nonceConsumer: { consumeOnce: async () => true },
      now: () => NOW,
    });
    expect(opened.writerDisableEvidence).toEqual(result.writerDisableEvidence);
  });

  it('blocks final delta before Redis acquisition when local writer-control configuration is missing', async () => {
    stubRedis();
    stubWriterDisableTrust();
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return jsonResponse({ result: ['0', []] });
    }));

    await expect(runLegacyMigrationBridge(baseInput('final-delta'))).rejects.toThrow(/writer control|configuration|blocked/i);
    expect(calls).toEqual([]);
  });

  it('rejects an over-byte deployment-local writer control URL before making a request', async () => {
    stubRedis();
    stubWriterDisableTrust();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_URL', `https://writer-control.example/${'é'.repeat(1_020)}`);
    vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_TOKEN', 'writer-control-secret');
    const fetch = vi.fn(async () => jsonResponse(controlState()));
    vi.stubGlobal('fetch', fetch);

    await expect(runLegacyMigrationBridge(baseInput('final-delta'))).rejects.toThrow(/writer control URL|invalid|blocked/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not disable the writer for a non-final snapshot', async () => {
    stubRedis();
    stubWriterControl();
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      const command = JSON.parse(String(init?.body)) as unknown[];
      return jsonResponse({ result: command[0] === 'HSCAN' || command[0] === 'SCAN' ? ['0', []] : null });
    }));

    await runLegacyMigrationBridge(baseInput('preflight'));

    expect(urls).toHaveLength(4);
    expect(urls.every((url) => url === 'https://local-upstash.example')).toBe(true);
  });

  it('blocks malformed authoritative status before Redis acquisition and sealing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stubRedis();
    stubWriterDisableTrust();
    stubWriterControl();
    const events: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes('127.0.0.1')) {
        events.push('redis-acquired');
        return jsonResponse({ result: ['0', []] });
      }
      events.push(`control-${init?.method}`);
      return init?.method === 'POST'
        ? jsonResponse(controlState())
        : jsonResponse({ ...controlState(), unexpected: true });
    }));

    await expect(runLegacyMigrationBridge(baseInput('final-delta'))).rejects.toThrow(/writer control|status|malformed|blocked/i);
    expect(events).toEqual(['control-POST', 'control-GET']);
  });

  it.each([
    ['absent', undefined],
    ['deceptively small', '1'],
  ])('cancels and aborts an oversized streamed control response with %s Content-Length without using text()', async (_label, contentLength) => {
    stubRedis();
    stubWriterDisableTrust();
    stubWriterControl();
    let cancelled = false;
    let suppliedChunks = 0;
    let requestSignal: AbortSignal | undefined;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        suppliedChunks += 1;
        if (suppliedChunks <= 10) controller.enqueue(new Uint8Array(4_097));
        else controller.close();
      },
      cancel() { cancelled = true; },
    });
    const response = new Response(stream, {
      headers: {
        'content-type': 'application/json',
        ...(contentLength === undefined ? {} : { 'content-length': contentLength }),
      },
    });
    const text = vi.spyOn(response, 'text');
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return response;
    }));

    await expect(runLegacyMigrationBridge(baseInput('final-delta'))).rejects.toThrow(/writer control request failed/i);
    expect(cancelled).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
    expect(text).not.toHaveBeenCalled();
    expect(suppliedChunks).toBeLessThanOrEqual(3);
  });

  it.each(['8193', '-1', 'not-a-number', '8192, 1'])('rejects invalid Content-Length %s before reading the control response body', async (contentLength) => {
    stubRedis();
    stubWriterDisableTrust();
    stubWriterControl();
    let requestSignal: AbortSignal | undefined;
    const response = new Response(JSON.stringify(controlState()), {
      headers: { 'content-type': 'application/json', 'content-length': contentLength },
    });
    const getReader = vi.spyOn(response.body!, 'getReader');
    const text = vi.spyOn(response, 'text');
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return response;
    }));

    await expect(runLegacyMigrationBridge(baseInput('final-delta'))).rejects.toThrow(/writer control request failed/i);
    expect(getReader).not.toHaveBeenCalled();
    expect(requestSignal?.aborted).toBe(true);
    expect(text).not.toHaveBeenCalled();
  });

  it('fails closed when a successful control response has no readable body', async () => {
    stubRedis();
    stubWriterDisableTrust();
    stubWriterControl();
    let requestSignal: AbortSignal | undefined;
    const response = new Response(null, {
      headers: { 'content-type': 'application/json', 'content-length': '0' },
    });
    const text = vi.spyOn(response, 'text');
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return response;
    }));

    await expect(runLegacyMigrationBridge(baseInput('final-delta'))).rejects.toThrow(/writer control request failed/i);
    expect(requestSignal?.aborted).toBe(true);
    expect(text).not.toHaveBeenCalled();
  });

  it.each([
    ['local token exactly', CONTROL_EVIDENCE, CONTROL_EVIDENCE],
    ['local token embedded', 'aaaa', CONTROL_EVIDENCE],
    ['arbitrary plaintext', 'writer-control-secret', 'writer-control-generation-41'],
    ['malformed digest', 'writer-control-secret', `sha256:${'A'.repeat(64)}`],
    ['oversized digest', 'writer-control-secret', `sha256:${'a'.repeat(65)}`],
  ])('rejects %s as control evidence before Redis acquisition or sealing', async (_label, token, evidence) => {
    stubRedis();
    stubWriterDisableTrust();
    stubWriterControl();
    vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_TOKEN', token);
    const events: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      events.push(String(url).includes('127.0.0.1') ? `control-${init?.method}` : 'redis-acquired');
      return jsonResponse(String(url).includes('127.0.0.1')
        ? { ...controlState(), evidence }
        : { result: ['0', []] });
    }));

    await expect(runLegacyMigrationBridge(baseInput('final-delta'))).rejects.toThrow(/writer control|evidence|request failed/i);
    expect(events).toEqual(['control-POST']);
  });

  it('blocks sealing when the writer control generation changes during Sheets capture', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stubRedis();
    stubWriterDisableTrust();
    stubWriterControl();
    const events: string[] = [];
    let sheetsCaptured = false;
    const mutatingSheetReader = {
      ...sheetReader,
      getRevision: async () => {
        events.push('sheets-revision');
        if (events.filter((event) => event === 'sheets-revision').length === 2) sheetsCaptured = true;
        return sheetReader.getRevision();
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('127.0.0.1')) {
        events.push(`control-${init?.method}`);
        return jsonResponse(controlState(init?.method === 'GET' && sheetsCaptured ? 42 : 41));
      }
      const command = JSON.parse(String(init?.body)) as unknown[];
      events.push(`redis-${String(command[0])}`);
      return jsonResponse({ result: ['0', []] });
    }));

    await expect(runLegacyMigrationBridge({
      ...baseInput('final-delta'),
      sheets: { spreadsheetId: 'sheet-1', reader: mutatingSheetReader },
    })).rejects.toThrow(/generation|changed|writer control|blocked/i);
    expect(events).toEqual([
      'control-POST', 'control-GET',
      'redis-HSCAN', 'redis-SCAN', 'redis-HSCAN', 'redis-SCAN',
      'sheets-revision', 'sheets-revision',
      'control-GET',
    ]);
  });
});
