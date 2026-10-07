/**
 * SYNTHETIC_FILE_RECOVERY_ONLY — deliberately not original Task21 acceptance.
 *
 * Linux/POSIX, Node builtins only; no production imports, DB, network or env input.
 * Create a NEW private /tmp/task21-synthetic-retained-* scratch directory first.
 *   node scripts/task21-synthetic-retained-backup.mjs produce <scratch>/bundle-<name>
 * After that process exits, run a new process with just these two stored paths:
 *   node scripts/task21-synthetic-retained-backup.mjs consume \
 *     <scratch>/bundle-<name>/artifact.envelope.json \
 *     <scratch>/bundle-<name>/synthetic-test-key.json
 *
 * The only backup input is this program's public synthetic fixture. The random
 * test key is a separate file, not a real secret or evidence of KMS/key custody.
 * Success means file sync/close and recovery across process exit, NOT power-loss
 * safety, off-site/durable retention, authorized export, PG restoration, RPO/RTO,
 * post-cutover delta, writer exclusion, authority, or permission to replace Sheets.
 * Same-UID adversarial namespace races are outside this private-scratch contract.
 * Failure can leave owned partial files: never overwrite/retry in the same bundle.
 * No automatic deletion, expiry or secure erasure guarantee (including JS copies).
 */
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const LABEL = 'SYNTHETIC_FILE_RECOVERY_ONLY';
const FORMAT = 'task21-synthetic-retained-backup';
const ALGORITHM = 'aes-256-gcm';
const ARTIFACT = 'artifact.envelope.json';
const KEY_FILE = 'synthetic-test-key.json';
const MAX_ARTIFACT = 4096;
const MAX_KEY = 512;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;

function requireCondition(condition) {
  if (!condition) throw new Error(`${LABEL}: REJECTED`);
}

function checkDirectory(dir) {
  const stat = fs.lstatSync(dir);
  requireCondition(stat.isDirectory() && !stat.isSymbolicLink());
  requireCondition(stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o700);
}

function checkBundlePath(bundle, existing) {
  requireCondition(typeof process.getuid === 'function' && typeof O_NOFOLLOW === 'number');
  requireCondition(typeof bundle === 'string' && path.resolve(bundle) === bundle);
  requireCondition(/^bundle-[a-z0-9-]{1,80}$/.test(path.basename(bundle)));
  const scratch = path.dirname(bundle);
  requireCondition(path.dirname(scratch) === '/tmp');
  requireCondition(/^task21-synthetic-retained-[A-Za-z0-9-]{1,100}$/.test(path.basename(scratch)));
  requireCondition(fs.realpathSync('/tmp') === '/tmp');
  checkDirectory(scratch);
  if (existing) checkDirectory(bundle);
  return scratch;
}

function checkFile(stat) {
  requireCondition(stat.isFile() && stat.nlink === 1);
  requireCondition(stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o600);
}

function writeExclusive(file, bytes) {
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    checkFile(fs.fstatSync(fd));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
      requireCondition(Number.isInteger(count) && count > 0 && count <= bytes.length - offset);
      offset += count;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncDirectory(dir) {
  const fd = fs.openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function readBounded(file, maximum) {
  // NONBLOCK avoids blocking on a substituted FIFO; fstat rejects all non-files.
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    checkFile(before);
    requireCondition(before.size > 0 && before.size <= maximum);
    const bytes = Buffer.alloc(maximum + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    const after = fs.fstatSync(fd);
    requireCondition(used === before.size && used <= maximum);
    requireCondition(after.size === before.size && after.mtimeMs === before.mtimeMs
      && after.ctimeMs === before.ctimeMs);
    return bytes.subarray(0, used);
  } finally {
    fs.closeSync(fd);
  }
}

function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'); }

function readJson(file, maximum) {
  const bytes = readBounded(file, maximum);
  const value = JSON.parse(bytes.toString('utf8'));
  requireCondition(jsonBytes(value).equals(bytes)); // Reject duplicates, BOM and invalid UTF-8.
  return value;
}

function hex(value, byteLength) {
  requireCondition(typeof value === 'string' && value.length === byteLength * 2
    && /^[0-9a-f]+$/.test(value));
  return Buffer.from(value, 'hex');
}

function syntheticFixture() {
  return jsonBytes({
    fixture: 'task21-retained-fixture-v1',
    tenant: 'synthetic-tenant',
    products: [{ id: 'SYNTH-P1', stock: 7 }, { id: 'SYNTH-P2', stock: 0 }],
  });
}

export function produce(bundle) {
  const scratch = checkBundlePath(bundle, false);
  fs.mkdirSync(bundle, { mode: 0o700 }); // Exclusive directory; no recursive creation.
  checkDirectory(bundle);
  const key = randomBytes(32);
  const plaintext = syntheticFixture();
  try {
    const keyRef = randomBytes(16).toString('hex');
    const header = {
      format: FORMAT,
      version: 1,
      algorithm: ALGORITHM,
      keyRef,
      binding: {
        purpose: LABEL,
        fixture: 'task21-retained-fixture-v1',
        tenant: 'synthetic-tenant',
        generation: 'synthetic-generation-v1',
      },
    };
    const nonce = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(JSON.stringify(header)));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = jsonBytes({ header, nonce: nonce.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') });
    const keyRecord = jsonBytes({ format: 'task21-synthetic-test-key', version: 1,
      purpose: LABEL, keyRef, key: key.toString('hex') });
    requireCondition(envelope.length <= MAX_ARTIFACT && keyRecord.length <= MAX_KEY);
    writeExclusive(path.join(bundle, KEY_FILE), keyRecord);
    writeExclusive(path.join(bundle, ARTIFACT), envelope);
    syncDirectory(bundle);
    syncDirectory(scratch);
    return { label: LABEL, status: 'STORED' };
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

function exactKeys(value, keys) {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireCondition(Object.keys(value).join(',') === keys.join(','));
}

function validateContract(envelope, keyRecord) {
  exactKeys(envelope, ['header', 'nonce', 'tag', 'ciphertext']);
  exactKeys(keyRecord, ['format', 'version', 'purpose', 'keyRef', 'key']);
  requireCondition(keyRecord.format === 'task21-synthetic-test-key' && keyRecord.version === 1
    && keyRecord.purpose === LABEL);
  hex(keyRecord.keyRef, 16);
  // Independent fixed binding, NOT trusted merely because it was authenticated.
  requireCondition(JSON.stringify(envelope.header) === JSON.stringify({
    format: FORMAT,
    version: 1,
    algorithm: ALGORITHM,
    keyRef: keyRecord.keyRef,
    binding: {
      purpose: LABEL,
      fixture: 'task21-retained-fixture-v1',
      tenant: 'synthetic-tenant',
      generation: 'synthetic-generation-v1',
    },
  }));
}

export function consume(artifact, keyFile) {
  requireCondition(typeof artifact === 'string' && typeof keyFile === 'string');
  const bundle = path.dirname(artifact);
  checkBundlePath(bundle, true);
  requireCondition(artifact === path.join(bundle, ARTIFACT) && keyFile === path.join(bundle, KEY_FILE));
  const envelope = readJson(artifact, MAX_ARTIFACT);
  const keyRecord = readJson(keyFile, MAX_KEY);
  validateContract(envelope, keyRecord);
  const key = hex(keyRecord.key, 32);
  let plaintext;
  try {
    const nonce = hex(envelope.nonce, 12);
    const tag = hex(envelope.tag, 16);
    requireCondition(typeof envelope.ciphertext === 'string' && envelope.ciphertext.length > 0
      && envelope.ciphertext.length <= 2048 && envelope.ciphertext.length % 2 === 0);
    const ciphertext = hex(envelope.ciphertext, envelope.ciphertext.length / 2);
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(JSON.stringify(envelope.header)));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    // Literal consumer oracle, not envelope-supplied hash or producer state/input.
    const oracle = Buffer.from('{"fixture":"task21-retained-fixture-v1","tenant":"synthetic-tenant","products":[{"id":"SYNTH-P1","stock":7},{"id":"SYNTH-P2","stock":0}]}\n');
    requireCondition(plaintext.equals(oracle));
    return { label: LABEL, status: 'RECOVERED', bytes: plaintext.length,
      sha256: createHash('sha256').update(plaintext).digest('hex') };
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}

function main(args) {
  if (args.length === 2 && args[0] === 'produce') return produce(args[1]);
  if (args.length === 3 && args[0] === 'consume') return consume(args[1], args[2]);
  throw new Error(`${LABEL}: REJECTED`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch {
    // Never emit the original error, offending values, paths or parser/crypto details.
    process.stderr.write(`${LABEL}: REJECTED\n`);
    process.exitCode = 1;
  }
}
