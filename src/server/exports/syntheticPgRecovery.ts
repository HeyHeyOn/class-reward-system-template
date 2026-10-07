import 'server-only';

import { constants } from 'node:fs';
import { open, realpath, readdir, link, unlink, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  parseRetainedExportManifest, serializeRetainedExportManifest, checkRetainedExportArtifactBytes,
  RETAINED_EXPORT_MANIFEST_LIMITS, type RetainedExportManifest,
} from './retainedExportManifest.ts';

/** Private Linux synthetic PG17 transport ONLY. No API, ambient DB/storage URL,
 * credentials, runtime grants, tenant lookup, importer or production activation.
 * Caller supplies independently retained expected context + manifest digest and
 * an approved synthetic key; neither may be recovered from the artifact itself.
 * A matching key/pin authenticates these fixture bytes, NOT source completeness.
 * Caller/supervisor and same-UID filesystem are trusted. Not a KMS/WORM system.
 * JSON label describes the encrypted envelope, never CSV/XLSX nor a raw PG dump.
 */
const SCHEMA = 'synthetic-pg17-custom-aesgcm-v1';
const PRODUCER = 'crs-recovery-v1';
const MAX_DUMP = 5 * 1024 * 1024;
const LIMITS = RETAINED_EXPORT_MANIFEST_LIMITS;
const MESSAGE = 'Synthetic recovery refused.';
export type SyntheticRecoveryBinding = Readonly<{
  tenantId: string; jobId: string; generation: number; exportId: string;
}>;
export type SyntheticRecoveryExpected = SyntheticRecoveryBinding & Readonly<{ manifestSha256: string }>;
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function refuse(): never { throw new Error(MESSAGE); }
function keyCopy(key: Buffer): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== 32) return refuse();
  return Buffer.from(key);
}
function detachedBinding(value: SyntheticRecoveryBinding): SyntheticRecoveryBinding {
  // Reuse the existing exact UUID/integer/profile validation; no I/O yet.
  const binding = { tenantId: value.tenantId, jobId: value.jobId, generation: value.generation, exportId: value.exportId };
  serializeRetainedExportManifest(manifestFor(binding, '2000-01-01T00:00:00.000Z',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', Buffer.alloc(0)));
  return Object.freeze(binding);
}
function manifestFor(binding: SyntheticRecoveryBinding, at: string, artifactId: string, bytes: Buffer): RetainedExportManifest {
  return { manifestVersion: 1, purpose: 'RETAINED_EXPORT_DESCRIPTOR', ...binding,
    exportSchemaVersion: SCHEMA, producerCodeVersion: PRODUCER,
    artifacts: [{ artifactId, format: 'JSON', digest: { algorithm: 'SHA-256', hex: sha256(bytes) },
      byteLength: bytes.length, window: { kind: 'SNAPSHOT', at } }] };
}
function aad(binding: SyntheticRecoveryBinding): Buffer {
  return Buffer.from(JSON.stringify({ profile: SCHEMA, ...binding }));
}
function dumpCheck(dump: Buffer): void {
  if (!Buffer.isBuffer(dump) || dump.length < 5 || dump.length > MAX_DUMP
    || !dump.subarray(0, 5).equals(Buffer.from('PGDMP'))) refuse();
  // Magic is only a transport guard. pg_restore must validate the actual format.
}
async function privateDirectory(directory: string): Promise<FileHandle> {
  const path = resolve(directory);
  if (await realpath(path) !== path || process.platform !== 'linux') return refuse();
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) refuse();
    return handle;
  } catch { await handle.close(); return refuse(); }
}
// Root FD pins directory identity (no pathname re-resolution after initial open).
const member = (root: FileHandle, name: string) => `/proc/self/fd/${root.fd}/${name}`;
async function storedRead(root: FileHandle, name: string, max: number): Promise<Buffer> {
  const file = await open(member(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()
      || (info.mode & 0o777) !== 0o600 || info.size > max) refuse();
    const output = Buffer.alloc(max + 1);
    let size = 0;
    while (size <= max) {
      const result = await file.read(output, size, output.length - size, size);
      if (!result.bytesRead) return output.subarray(0, size);
      size += result.bytesRead;
    }
    return refuse();
  } finally { await file.close(); }
}
async function storedWrite(root: FileHandle, name: string, bytes: Buffer): Promise<void> {
  const file = await open(member(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

export async function retainSyntheticPgDump(input: Readonly<{
  directory: string; binding: SyntheticRecoveryBinding; key: Buffer; dump: Buffer; at: string;
}>): Promise<Readonly<{ kind: 'SYNTHETIC_ARTIFACT_STORED'; manifestSha256: string; dumpSha256: string; restoreAllowed: false }>> {
  let key: Buffer | undefined;
  let root: FileHandle | undefined;
  try {
    key = keyCopy(input.key);
    const binding = detachedBinding(input.binding);
    dumpCheck(input.dump);
    const dump = Buffer.from(input.dump);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(binding));
    const encrypted = Buffer.concat([cipher.update(dump), cipher.final()]);
    const envelope = Buffer.from(JSON.stringify({ profile: SCHEMA, nonce: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') }));
    const artifactId = randomUUID();
    const manifestWire = serializeRetainedExportManifest(manifestFor(binding, input.at, artifactId, envelope));
    root = await privateDirectory(input.directory);
    if ((await readdir(member(root, '.'))).length) refuse();
    // Exclusive persistent marker prevents overwriting/retrying an interrupted
    // publication. Incomplete roots require an operator to use a NEW directory.
    await storedWrite(root, '.publication', Buffer.from('SYNTHETIC_ONLY\n'));
    await storedWrite(root, `${artifactId}.json`, envelope);
    await storedWrite(root, '.manifest.pending', Buffer.from(manifestWire));
    await link(member(root, '.manifest.pending'), member(root, 'manifest.json'));
    await unlink(member(root, '.manifest.pending'));
    await root.sync();
    // Read back the exact persisted bytes before returning a receipt.
    const persisted = await storedRead(root, `${artifactId}.json`, LIMITS.maxArtifactBytes);
    checkRetainedExportArtifactBytes(parseRetainedExportManifest(manifestWire).manifest, artifactId, persisted);
    const wire = await storedRead(root, 'manifest.json', LIMITS.maxManifestBytes);
    if (!wire.equals(Buffer.from(manifestWire))) refuse();
    return Object.freeze({ kind: 'SYNTHETIC_ARTIFACT_STORED', manifestSha256: sha256(wire),
      dumpSha256: sha256(dump), restoreAllowed: false });
  } catch { return refuse(); }
  finally { key?.fill(0); await root?.close(); }
}

export async function retrieveSyntheticPgDump(input: Readonly<{
  directory: string; expected: SyntheticRecoveryExpected; key: Buffer;
}>): Promise<Readonly<{ kind: 'SYNTHETIC_DUMP_RETRIEVED'; dump: Buffer; dumpSha256: string; restoreAllowed: false }>> {
  let key: Buffer | undefined;
  let root: FileHandle | undefined;
  try {
    key = keyCopy(input.key);
    const binding = detachedBinding(input.expected);
    const pin = input.expected.manifestSha256;
    if (typeof pin !== 'string' || !/^[0-9a-f]{64}$/.test(pin) || pin.length !== 64) refuse();
    root = await privateDirectory(input.directory);
    const wire = await storedRead(root, 'manifest.json', LIMITS.maxManifestBytes);
    if (sha256(wire) !== pin) refuse();
    const manifest = parseRetainedExportManifest(wire.toString('utf8')).manifest;
    if (manifest.tenantId !== binding.tenantId || manifest.jobId !== binding.jobId
      || manifest.generation !== binding.generation || manifest.exportId !== binding.exportId
      || manifest.exportSchemaVersion !== SCHEMA || manifest.producerCodeVersion !== PRODUCER
      || manifest.artifacts.length !== 1) refuse();
    const part = manifest.artifacts[0];
    if (part.format !== 'JSON' || part.window.kind !== 'SNAPSHOT') refuse();
    const stored = await storedRead(root, `${part.artifactId}.json`, LIMITS.maxArtifactBytes);
    checkRetainedExportArtifactBytes(manifest, part.artifactId, stored);
    const value = JSON.parse(stored.toString('utf8')) as Record<string, unknown>;
    if (JSON.stringify(value) !== stored.toString('utf8') || Object.keys(value).join(',') !== 'profile,nonce,tag,ciphertext'
      || value.profile !== SCHEMA) refuse();
    const decode = (text: unknown, size?: number) => {
      if (typeof text !== 'string') return refuse();
      const result = Buffer.from(text, 'base64');
      if (result.toString('base64') !== text || (size !== undefined && result.length !== size)) return refuse();
      return result;
    };
    const decipher = createDecipheriv('aes-256-gcm', key, decode(value.nonce, 12));
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(decode(value.tag, 16));
    const dump = Buffer.concat([decipher.update(decode(value.ciphertext)), decipher.final()]);
    dumpCheck(dump);
    return Object.freeze({ kind: 'SYNTHETIC_DUMP_RETRIEVED', dump, dumpSha256: sha256(dump), restoreAllowed: false });
  } catch { return refuse(); }
  finally { key?.fill(0); await root?.close(); }
}
