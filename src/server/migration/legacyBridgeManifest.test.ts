import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalJson, openLegacyBridgeManifest, sealLegacyBridgeManifest, type AtomicNonceConsumer,
} from './legacyBridgeManifest';

const NOW = Date.parse('2026-09-05T00:00:00.000Z');
const keys = generateKeyPairSync('ed25519');
const encryptionKey = randomBytes(32);
const payload = { deploymentId: 'legacy-one', mode: 'preflight', snapshotDigest: 'a'.repeat(64) } as const;

function consumer(): AtomicNonceConsumer {
  const consumed = new Set<string>();
  return {
    consumeOnce: async (nonce) => {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
  };
}

describe('bounded signed and encrypted one-time legacy bridge manifests', () => {
  it('uses UTF-16 code-unit key order without consulting localeCompare when sealing and opening', async () => {
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('locale-dependent comparison must not be used');
    });

    try {
      const localeSensitivePayload = { '\uE000': 'private-use', '😀': 'supplementary' };
      const envelope = sealLegacyBridgeManifest(localeSensitivePayload, {
        keyId: 'bridge-key-1', encryptionKey, signingPrivateKey: keys.privateKey,
        now: () => NOW, nonce: () => Buffer.alloc(24, 6), ttlMs: 60_000,
      });

      expect(canonicalJson(localeSensitivePayload)).toBe('{"😀":"supplementary","":"private-use"}');
      await expect(openLegacyBridgeManifest(envelope, {
        encryptionKey, signingPublicKey: keys.publicKey, nonceConsumer: consumer(), now: () => NOW + 1,
      })).resolves.toEqual(localeSensitivePayload);
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('round trips without serializing keys or plaintext and consumes each nonce exactly once', async () => {
    const envelope = sealLegacyBridgeManifest(payload, {
      keyId: 'bridge-key-1', encryptionKey, signingPrivateKey: keys.privateKey,
      now: () => NOW, nonce: () => Buffer.alloc(24, 7), ttlMs: 60_000,
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('legacy-one');
    expect(serialized).not.toContain(encryptionKey.toString('base64'));

    const nonces = consumer();
    await expect(openLegacyBridgeManifest(envelope, {
      encryptionKey, signingPublicKey: keys.publicKey, nonceConsumer: nonces, now: () => NOW + 1,
    })).resolves.toEqual(payload);
    await expect(openLegacyBridgeManifest(envelope, {
      encryptionKey, signingPublicKey: keys.publicKey, nonceConsumer: nonces, now: () => NOW + 2,
    })).rejects.toThrow(/replay/i);
  });

  it('detects exact-envelope tampering before consuming the nonce', async () => {
    const envelope = sealLegacyBridgeManifest(payload, {
      keyId: 'bridge-key-1', encryptionKey, signingPrivateKey: keys.privateKey,
      now: () => NOW, nonce: () => Buffer.alloc(24, 8), ttlMs: 60_000,
    });
    let consumeCalls = 0;
    const nonceConsumer: AtomicNonceConsumer = { consumeOnce: async () => { consumeCalls += 1; return true; } };
    const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -1) + (envelope.ciphertext.endsWith('A') ? 'B' : 'A') };

    await expect(openLegacyBridgeManifest(tampered, {
      encryptionKey, signingPublicKey: keys.publicKey, nonceConsumer, now: () => NOW + 1,
    })).rejects.toThrow(/invalid/i);
    expect(consumeCalls).toBe(0);
  });

  it('domain-separates signatures from bare canonical manifest bytes', async () => {
    const envelope = sealLegacyBridgeManifest(payload, {
      keyId: 'bridge-key-1', encryptionKey, signingPrivateKey: keys.privateKey,
      now: () => NOW, nonce: () => Buffer.alloc(24, 9), ttlMs: 60_000,
    });
    const unsigned = { ...envelope } as Record<string, unknown>;
    delete unsigned.signature;
    const bareCanonicalSignature = sign(
      null, Buffer.from(canonicalJson(unsigned), 'utf8'), keys.privateKey,
    ).toString('base64url');
    let consumeCalls = 0;

    await expect(openLegacyBridgeManifest({ ...envelope, signature: bareCanonicalSignature }, {
      encryptionKey,
      signingPublicKey: keys.publicKey,
      nonceConsumer: { consumeOnce: async () => { consumeCalls += 1; return true; } },
      now: () => NOW + 1,
    })).rejects.toThrow(/invalid/i);
    expect(consumeCalls).toBe(0);
  });

  it('rejects non-finite, negative, and unsafe receiver clocks before nonce consumption', async () => {
    const envelope = sealLegacyBridgeManifest(payload, {
      keyId: 'bridge-key-1', encryptionKey, signingPrivateKey: keys.privateKey,
      now: () => NOW, nonce: () => Buffer.alloc(24, 10), ttlMs: 60_000,
    });
    for (const invalidNow of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1]) {
      let consumeCalls = 0;
      await expect(openLegacyBridgeManifest(envelope, {
        encryptionKey,
        signingPublicKey: keys.publicKey,
        nonceConsumer: { consumeOnce: async () => { consumeCalls += 1; return true; } },
        now: () => invalidNow,
      })).rejects.toThrow(/time|invalid/i);
      expect(consumeCalls).toBe(0);
    }
  });

  it.each([['expiry', NOW + 60_000], ['future', NOW - 1]] as const)('rejects the exact %s boundary before consumption', async (_label, now) => {
    const envelope = sealLegacyBridgeManifest(payload, {
      keyId: 'bridge-key-1', encryptionKey, signingPrivateKey: keys.privateKey, now: () => NOW,
    });
    const consumeOnce = vi.fn(async () => true);
    await expect(openLegacyBridgeManifest(envelope, {
      encryptionKey, signingPublicKey: keys.publicKey, nonceConsumer: { consumeOnce }, now: () => now,
    })).rejects.toThrow(/expired|not yet valid/);
    expect(consumeOnce).not.toHaveBeenCalled();
  });

  it('rejects timestamp addition overflow while sealing', () => {
    expect(() => sealLegacyBridgeManifest(payload, {
      keyId: 'bridge-key-1', encryptionKey, signingPrivateKey: keys.privateKey,
      now: () => Number.MAX_SAFE_INTEGER - 500, ttlMs: 1_000,
    })).toThrow(/time|lifetime/i);
  });

  it('rejects sparse arrays at root and nested payload positions', () => {
    const sparseRoot = new Array(1);
    const sparseNested = { rows: [['present'], new Array(2)] };

    for (const invalidPayload of [sparseRoot, sparseNested]) {
      expect(() => sealLegacyBridgeManifest(invalidPayload, {
        keyId: 'bridge-key-1', encryptionKey, signingPrivateKey: keys.privateKey,
        now: () => NOW,
      })).toThrow(/invalid/i);
      expect(() => canonicalJson(invalidPayload)).toThrow(/invalid/i);
    }
  });

  it('rejects non-data objects, accessors, symbol keys, cycles, and non-JSON values', () => {
    class ManifestPayload { value = 'class-instance'; }
    const accessor = {} as Record<string, unknown>;
    const getter = vi.fn(() => 'computed');
    Object.defineProperty(accessor, 'value', { enumerable: true, get: getter });
    const symbolKeyed = { value: 'visible', [Symbol('hidden')]: 'hidden' };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidPayloads: unknown[] = [
      new Date(0), new Map([['key', 'value']]), new Set(['value']), new ManifestPayload(),
      accessor, symbolKeyed, cyclic, undefined, BigInt(1), () => undefined, Symbol('value'),
      { nested: undefined }, [undefined], Number.NaN, Number.POSITIVE_INFINITY,
    ];

    for (const invalidPayload of invalidPayloads) {
      expect(() => sealLegacyBridgeManifest(invalidPayload, {
        keyId: 'bridge-key-1', encryptionKey, signingPrivateKey: keys.privateKey,
        now: () => NOW,
      })).toThrow(/invalid/i);
      expect(() => canonicalJson(invalidPayload)).toThrow(/invalid/i);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('round trips null-prototype data records used for workbook tab dictionaries', async () => {
    const tabs = Object.create(null) as Record<string, string[][]>;
    tabs.Students = [['name', 'balance'], ['Ada', '100']];
    const nullPrototypePayload = { tabs };
    const envelope = sealLegacyBridgeManifest(nullPrototypePayload, {
      keyId: 'bridge-key-1', encryptionKey, signingPrivateKey: keys.privateKey,
      now: () => NOW, nonce: () => Buffer.alloc(24, 11), ttlMs: 60_000,
    });

    await expect(openLegacyBridgeManifest(envelope, {
      encryptionKey, signingPublicKey: keys.publicKey, nonceConsumer: consumer(), now: () => NOW + 1,
    })).resolves.toEqual({ tabs: { Students: [['name', 'balance'], ['Ada', '100']] } });
  });

  it('keeps the per-string payload limit independent from encrypted envelope strings', async () => {
    const largeValidPayload = { chunks: ['x'.repeat(90_000), 'y'.repeat(90_000)] };
    const envelope = sealLegacyBridgeManifest(largeValidPayload, {
      keyId: 'bridge-key-1', encryptionKey, signingPrivateKey: keys.privateKey,
      now: () => NOW, nonce: () => Buffer.alloc(24, 12), ttlMs: 60_000,
    });

    await expect(openLegacyBridgeManifest(envelope, {
      encryptionKey, signingPublicKey: keys.publicKey, nonceConsumer: consumer(), now: () => NOW + 1,
    })).resolves.toEqual(largeValidPayload);
  });

  it('rejects unsupported algorithms, excessive lifetime, expired, oversized, and sensitive payloads', async () => {
    expect(() => sealLegacyBridgeManifest({ password: 'secret' }, {
      keyId: 'bridge-key-1', encryptionKey, signingPrivateKey: keys.privateKey, now: () => NOW,
    })).toThrow(/sensitive/i);
    expect(() => sealLegacyBridgeManifest({ data: 'x'.repeat(1_100_000) }, {
      keyId: 'bridge-key-1', encryptionKey, signingPrivateKey: keys.privateKey, now: () => NOW,
    })).toThrow(/size/i);

    const envelope = sealLegacyBridgeManifest(payload, {
      keyId: 'bridge-key-1', encryptionKey, signingPrivateKey: keys.privateKey, now: () => NOW,
      ttlMs: 60_000,
    });
    await expect(openLegacyBridgeManifest({ ...envelope, algorithm: 'none' }, {
      encryptionKey, signingPublicKey: keys.publicKey, nonceConsumer: consumer(), now: () => NOW,
    })).rejects.toThrow(/invalid/i);
    await expect(openLegacyBridgeManifest(envelope, {
      encryptionKey, signingPublicKey: keys.publicKey, nonceConsumer: consumer(), now: () => NOW + 60_001,
    })).rejects.toThrow(/expired/i);
  });
});
