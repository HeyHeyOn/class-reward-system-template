import 'server-only';

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * A class's Padlet API key is stored sealed: AES-256-GCM under a key derived from AUTH_SECRET with
 * its own purpose label (as the bank session cookie does), the class ID as associated data, and a
 * `pk1.iv.tag.ciphertext` wire format. If AUTH_SECRET changes, the teacher simply enters the key again.
 */

const VERSION = 'pk1';
const PURPOSE = 'class-store:padlet-api-key';
const MIN_SECRET_LENGTH = 16;

export class PadletKeyConfigurationError extends Error {
  constructor() {
    super('AUTH_SECRET is required to keep Padlet API keys.');
    this.name = 'PadletKeyConfigurationError';
  }
}

type Env = Readonly<{ [key: string]: string | undefined; AUTH_SECRET?: string }>;

function key(env: Env): Buffer {
  const secret = env.AUTH_SECRET?.trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH || secret.length > 1024) throw new PadletKeyConfigurationError();
  return createHash('sha256').update(`${PURPOSE}:`).update(secret).digest();
}

const aad = (tenantId: string) => Buffer.from(`${PURPOSE}:${VERSION}:${tenantId}`, 'utf8');

/** Padlet keys are printable and short; anything else is a paste mistake. */
export function normalizePadletApiKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[\x21-\x7e]{8,512}$/.test(trimmed) ? trimmed : null;
}

/** The last four characters, shown so the teacher can tell which key is saved. */
export function padletKeyHint(apiKey: string): string {
  return apiKey.slice(-4);
}

export function sealPadletApiKey(apiKey: string, tenantId: string, env: Env = process.env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(env), iv);
  cipher.setAAD(aad(tenantId));
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** The key, or null when it was sealed for another class or under another AUTH_SECRET. */
export function openPadletApiKey(sealed: string, tenantId: string, env: Env = process.env): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(env), Buffer.from(parts[1], 'base64url'));
    decipher.setAAD(aad(tenantId));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof PadletKeyConfigurationError) throw error;
    return null;
  }
}
