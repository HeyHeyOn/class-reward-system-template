// SYNTHETIC_FILE_RECOVERY_ONLY. No DB, network, inherited credentials or fixtures.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./task21-synthetic-retained-backup.mjs', import.meta.url));
const LABEL = 'SYNTHETIC_FILE_RECOVERY_ONLY';
// Independent literal oracle: never import the producer's fixture or expected digest.
const ORACLE = Buffer.from('{"fixture":"task21-retained-fixture-v1","tenant":"synthetic-tenant","products":[{"id":"SYNTH-P1","stock":7},{"id":"SYNTH-P2","stock":0}]}\n');
const EXPECTED = {
  label: LABEL,
  status: 'RECOVERED',
  bytes: ORACLE.length,
  sha256: createHash('sha256').update(ORACLE).digest('hex'),
};

function scratch(t) {
  const root = fs.mkdtempSync('/tmp/task21-synthetic-retained-test-');
  const files = new Set();
  const directories = new Set([root]);
  t.after(() => {
    // Never recursively remove a tree or follow a link. Unknown entries stop cleanup.
    for (const file of [...files].reverse()) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const dir of [...directories].reverse()) {
      try { fs.rmdirSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    assert.equal(fs.existsSync(root), false, 'own scratch was removed');
  });
  return {
    root,
    files,
    directories,
    bundle(name = 'main') {
      const dir = path.join(root, `bundle-${name}`);
      const artifact = path.join(dir, 'artifact.envelope.json');
      const key = path.join(dir, 'synthetic-test-key.json');
      directories.add(dir);
      files.add(artifact);
      files.add(key);
      return { dir, artifact, key };
    },
  };
}

function run(s, ...args) {
  // spawnSync returns only after child exit. No shell, timeout, IPC, stdin or env data.
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: s.root,
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 8192,
  });
  assert.equal(Boolean(result.error), false, 'child process could be executed');
  assert.equal(result.signal, null, 'child exited normally');
  return result;
}

function stored(s, b) {
  const result = run(s, 'produce', b.dir);
  assert.equal(result.status, 0, 'producer exits successfully');
  assert.equal(result.stderr === '', true, 'producer stderr is empty');
  assert.equal(result.stdout === `${JSON.stringify({ label: LABEL, status: 'STORED' })}\n`, true,
    'producer emits only the fixed safe receipt');
  return result;
}

function recovered(s, b) {
  const result = run(s, 'consume', b.artifact, b.key);
  assert.equal(result.status, 0, 'consumer exits successfully');
  assert.equal(result.stderr === '', true, 'consumer stderr is empty');
  // Boolean comparison deliberately keeps any unexpected secret output out of TAP.
  assert.equal(result.stdout === `${JSON.stringify(EXPECTED)}\n`, true,
    'consumer independently matches literal fixture length/hash and safe output');
  return result;
}

test('retained files recover in a fresh process only after producer exit', (t) => {
  const s = scratch(t);
  const b = s.bundle();
  const producer = stored(s, b);
  assert.equal(fs.statSync(b.artifact).isFile(), true);
  assert.equal(fs.statSync(b.key).isFile(), true);
  assert.equal(fs.statSync(b.dir).mode & 0o777, 0o700);
  for (const file of [b.artifact, b.key]) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  const before = [fs.readFileSync(b.artifact), fs.readFileSync(b.key)];
  const consumer = recovered(s, b);
  assert.notEqual(consumer.pid, producer.pid, 'distinct processes cross a real exit boundary');
  recovered(s, b); // Retained artifacts remain readable for a later independent consumer.
  assert.equal(fs.readFileSync(b.artifact).equals(before[0]), true, 'consumer does not change artifact');
  assert.equal(fs.readFileSync(b.key).equals(before[1]), true, 'consumer does not change key');
  t.diagnostic(`verified recovery: ${LABEL}; bytes=${EXPECTED.bytes}; sha256=${EXPECTED.sha256}`);
});

function rejected(s, ...args) {
  const result = run(s, ...args);
  assert.equal(result.status, 1, 'invalid input is rejected');
  assert.equal(result.stdout === '', true, 'rejection prints no payload');
  assert.equal(result.stderr === `${LABEL}: REJECTED\n`, true,
    'rejection emits only a fixed safe message, never paths or crypto/parser details');
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function replaceJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value)}\n`); }

// Deliberately independent envelope writer for adversarial, validly authenticated inputs.
function reseal(b, plaintext = ORACLE, changeHeader = () => {}) {
  const envelope = readJson(b.artifact);
  const record = readJson(b.key);
  changeHeader(envelope.header);
  const key = Buffer.from(record.key, 'hex');
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(JSON.stringify(envelope.header)));
    envelope.nonce = nonce.toString('hex');
    envelope.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('hex');
    envelope.tag = cipher.getAuthTag().toString('hex');
    replaceJson(b.artifact, envelope);
  } finally { key.fill(0); }
}

test('valid authentication does not replace the independent fixture oracle', (t) => {
  const s = scratch(t);
  const b = s.bundle();
  stored(s, b);
  const alternate = Buffer.from(ORACLE);
  alternate[alternate.indexOf('7')] = '8'.charCodeAt(0); // Same length, different fixture.
  reseal(b, alternate);
  rejected(s, 'consume', b.artifact, b.key);
});

const badHeaders = [
  ['format', (h) => { h.format = 'other'; }],
  ['version', (h) => { h.version = 2; }],
  ['algorithm', (h) => { h.algorithm = 'other'; }],
  ['key-reference', (h) => { h.keyRef = '00'.repeat(16); }],
  ['purpose', (h) => { h.binding.purpose = 'OTHER'; }],
  ['fixture', (h) => { h.binding.fixture = 'other-fixture'; }],
  ['tenant', (h) => { h.binding.tenant = 'other-tenant'; }],
  ['generation', (h) => { h.binding.generation = 'other-generation'; }],
  ['extra-header', (h) => { h.extra = true; }],
  ['extra-binding', (h) => { h.binding.extra = true; }],
  ['missing-binding', (h) => { delete h.binding; }],
];
for (const [name, mutate] of badHeaders) {
  test(`authenticated envelope contract rejects ${name}`, (t) => {
    const s = scratch(t);
    const b = s.bundle();
    stored(s, b);
    reseal(b, ORACLE, mutate); // Correct key, tag and plaintext: authentication alone passes.
    rejected(s, 'consume', b.artifact, b.key);
  });
}

for (const [name, mutate] of [
  ['format', (k) => { k.format = 'other'; }],
  ['version', (k) => { k.version = 2; }],
  ['purpose', (k) => { k.purpose = 'other'; }],
  ['key-reference', (k) => { k.keyRef = '00'.repeat(16); }],
  ['extra-field', (k) => { k.extra = true; }],
]) {
  test(`separate key contract rejects ${name}`, (t) => {
    const s = scratch(t);
    const b = s.bundle();
    stored(s, b);
    const record = readJson(b.key);
    mutate(record);
    replaceJson(b.key, record);
    rejected(s, 'consume', b.artifact, b.key);
  });
}

test('envelope rejects an extra self-declared digest instead of trusting it', (t) => {
  const s = scratch(t);
  const b = s.bundle();
  stored(s, b);
  const envelope = readJson(b.artifact);
  envelope.sha256 = EXPECTED.sha256;
  replaceJson(b.artifact, envelope);
  rejected(s, 'consume', b.artifact, b.key);
});

function flipHex(value) { return (value[0] === '0' ? '1' : '0') + value.slice(1); }

for (const field of ['ciphertext', 'tag', 'nonce']) {
  test(`authenticated decryption rejects tampered ${field}`, (t) => {
    const s = scratch(t);
    const b = s.bundle();
    stored(s, b);
    const envelope = readJson(b.artifact);
    envelope[field] = flipHex(envelope[field]);
    replaceJson(b.artifact, envelope);
    rejected(s, 'consume', b.artifact, b.key);
  });
}

test('header key reference is authenticated AAD, not just matching metadata', (t) => {
  const s = scratch(t);
  const b = s.bundle();
  stored(s, b);
  const envelope = readJson(b.artifact);
  const key = readJson(b.key);
  key.keyRef = flipHex(key.keyRef);
  envelope.header.keyRef = key.keyRef; // Both match, but the stored auth tag no longer does.
  replaceJson(b.artifact, envelope);
  replaceJson(b.key, key);
  rejected(s, 'consume', b.artifact, b.key);
});

test('wrong key bytes with correct metadata cannot decrypt', (t) => {
  const s = scratch(t);
  const b = s.bundle();
  stored(s, b);
  const key = readJson(b.key);
  key.key = flipHex(key.key);
  replaceJson(b.key, key);
  rejected(s, 'consume', b.artifact, b.key);
});

for (const which of ['artifact', 'key']) {
  for (const problem of ['missing', 'empty', 'truncated', 'oversize', 'invalid-json', 'duplicate-key', 'invalid-utf8']) {
    test(`stored ${which} rejects ${problem}`, (t) => {
      const s = scratch(t);
      const b = s.bundle();
      stored(s, b);
      const file = b[which];
      const bytes = fs.readFileSync(file);
      if (problem === 'missing') fs.unlinkSync(file);
      else if (problem === 'empty') fs.truncateSync(file, 0);
      else if (problem === 'truncated') fs.truncateSync(file, Math.floor(bytes.length / 2));
      else if (problem === 'oversize') fs.truncateSync(file, which === 'artifact' ? 4097 : 513);
      else if (problem === 'invalid-json') fs.writeFileSync(file, '{bad synthetic input');
      else if (problem === 'duplicate-key') {
        const name = which === 'artifact' ? 'header' : 'format';
        fs.writeFileSync(file, `{"${name}":null,${bytes.toString('utf8').slice(1)}`);
      } else fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from([0xff])]));
      rejected(s, 'consume', b.artifact, b.key);
    });
  }
}

for (const [name, mutate] of [
  ['short-nonce', (e) => { e.nonce = e.nonce.slice(2); }],
  ['short-tag', (e) => { e.tag = e.tag.slice(2); }],
  ['nonhex-tag', (e) => { e.tag = 'z'.repeat(32); }],
  ['empty-ciphertext', (e) => { e.ciphertext = ''; }],
  ['odd-ciphertext', (e) => { e.ciphertext += '0'; }],
  ['oversize-ciphertext', (e) => { e.ciphertext = '00'.repeat(1025); }],
]) {
  test(`envelope encoding rejects ${name}`, (t) => {
    const s = scratch(t);
    const b = s.bundle();
    stored(s, b);
    const envelope = readJson(b.artifact);
    mutate(envelope);
    replaceJson(b.artifact, envelope);
    rejected(s, 'consume', b.artifact, b.key);
  });
}

for (const length of [0, 31, 33]) {
  test(`key bytes reject length ${length}`, (t) => {
    const s = scratch(t);
    const b = s.bundle();
    stored(s, b);
    const key = readJson(b.key);
    key.key = '00'.repeat(length);
    replaceJson(b.key, key);
    rejected(s, 'consume', b.artifact, b.key);
  });
}

test('producer cannot overwrite a retained bundle', (t) => {
  const s = scratch(t);
  const b = s.bundle();
  stored(s, b);
  const before = [fs.readFileSync(b.artifact), fs.readFileSync(b.key)];
  rejected(s, 'produce', b.dir);
  assert.equal(fs.readFileSync(b.artifact).equals(before[0]), true, 'artifact unchanged');
  assert.equal(fs.readFileSync(b.key).equals(before[1]), true, 'key unchanged');
  recovered(s, b);
});

for (const which of ['artifact', 'key']) {
  for (const kind of ['symlink', 'dangling-symlink', 'hardlink', 'directory']) {
    test(`consumer rejects ${which} ${kind}`, (t) => {
      const s = scratch(t);
      const b = s.bundle();
      stored(s, b);
      const file = b[which];
      const other = path.join(s.root, `owned-${which}`);
      s.files.add(other);
      const original = fs.readFileSync(file);
      fs.renameSync(file, other);
      if (kind === 'symlink') fs.symlinkSync(other, file);
      else if (kind === 'dangling-symlink') fs.symlinkSync(path.join(s.root, 'never-created'), file);
      else if (kind === 'hardlink') fs.linkSync(other, file);
      else {
        s.files.delete(file);
        s.directories.add(file);
        fs.mkdirSync(file, { mode: 0o700 });
      }
      rejected(s, 'consume', b.artifact, b.key);
      assert.equal(fs.readFileSync(other).equals(original), true, 'own link target unchanged');
    });
  }
}

test('symlinked bundle is rejected by producer and consumer without touching its target', (t) => {
  const s = scratch(t);
  const b = s.bundle();
  const alias = s.bundle('alias');
  stored(s, b);
  s.directories.delete(alias.dir);
  s.files.delete(alias.artifact);
  s.files.delete(alias.key);
  s.files.add(alias.dir);
  fs.symlinkSync(b.dir, alias.dir);
  rejected(s, 'produce', alias.dir);
  rejected(s, 'consume', alias.artifact, alias.key);
  recovered(s, b);
});

test('separate productions use fresh keys, references and nonces with independently decryptable bytes', (t) => {
  const s = scratch(t);
  const first = s.bundle('first');
  const second = s.bundle('second');
  stored(s, first);
  stored(s, second);
  const one = readJson(first.artifact);
  const two = readJson(second.artifact);
  const k1 = readJson(first.key);
  const k2 = readJson(second.key);
  // Boolean checks never dump a key or ciphertext on a failed assertion.
  assert.equal(k1.key !== k2.key, true);
  assert.equal(one.header.keyRef !== two.header.keyRef, true);
  assert.equal(one.nonce !== two.nonce, true);
  assert.equal(one.ciphertext !== two.ciphertext, true);
  for (const b of [first, second]) {
    const envelopeBytes = fs.readFileSync(b.artifact);
    const e = readJson(b.artifact);
    const key = Buffer.from(readJson(b.key).key, 'hex');
    assert.equal(envelopeBytes.includes(ORACLE), false, 'artifact excludes plaintext');
    assert.equal(envelopeBytes.includes(Buffer.from(key.toString('hex'))), false, 'artifact excludes key');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.nonce, 'hex'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(JSON.stringify(e.header)));
    decipher.setAuthTag(Buffer.from(e.tag, 'hex'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(e.ciphertext, 'hex')), decipher.final()]);
    assert.equal(plaintext.equals(ORACLE), true, 'test independently authenticates stored bytes');
    plaintext.fill(0);
    key.fill(0);
  }
  fs.writeFileSync(first.key, fs.readFileSync(second.key));
  rejected(s, 'consume', first.artifact, first.key);
  rejected(s, 'consume', first.artifact, second.key); // No cross-bundle key path selection.
});

test('CLI rejects arbitrary input, path aliases and argument extensions', (t) => {
  const s = scratch(t);
  const b = s.bundle();
  stored(s, b);
  rejected(s);
  rejected(s, 'unknown');
  rejected(s, 'produce', b.dir, 'extra');
  rejected(s, 'consume', b.artifact, b.key, 'extra');
  rejected(s, 'produce', path.join(s.root, 'wrong-prefix'));
  rejected(s, 'produce', `${s.root}/./bundle-alias`);
  rejected(s, 'consume', `${b.dir}/./artifact.envelope.json`, b.key);
  rejected(s, 'consume', b.artifact, `${b.dir}/../bundle-main/synthetic-test-key.json`);
});

function rejectsCall(callback) {
  let failed = false;
  try { callback(); } catch { failed = true; }
  assert.equal(failed, true, 'operation fails closed without returning a receipt');
}

// Real I/O still runs. Local wrappers observe descriptors/order and inject short
// operations or failures impossible to request deterministically from a real disk.
function traceIo(t, b, { partial = false, fault = null, atOpen = null } = {}) {
  const real = Object.fromEntries(['openSync', 'writeSync', 'readSync', 'fsyncSync', 'closeSync']
    .map((name) => [name, fs[name]]));
  const records = [];
  const active = new Map();
  const owned = new Set([b.key, b.artifact, b.dir, path.dirname(b.dir)]);
  let order = 0;
  t.mock.method(fs, 'openSync', (file, flags, mode) => {
    if (owned.has(file)) atOpen?.(file);
    const fd = real.openSync(file, flags, mode);
    if (owned.has(file)) {
      const record = { file, fd, flags, mode, written: 0, read: 0, writes: 0, reads: 0, closed: false };
      records.push(record);
      active.set(fd, record);
    }
    return fd;
  });
  t.mock.method(fs, 'writeSync', (fd, buffer, offset, length, position) => {
    const record = active.get(fd);
    if (record?.file === fault?.file && fault?.operation === 'write-error') throw new Error('synthetic I/O fault');
    if (record?.file === fault?.file && fault?.operation === 'write-zero') return 0;
    const n = real.writeSync(fd, buffer, offset, partial && record ? Math.min(7, length) : length, position);
    if (record) { record.written += n; record.writes += 1; record.lastWrite = ++order; }
    return n;
  });
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    const record = active.get(fd);
    if (record?.file === fault?.file && fault?.operation === 'read-error') throw new Error('synthetic I/O fault');
    const n = real.readSync(fd, buffer, offset, partial && record ? Math.min(7, length) : length, position);
    if (record) { record.read += n; record.reads += 1; }
    return n;
  });
  t.mock.method(fs, 'fsyncSync', (fd) => {
    const record = active.get(fd);
    if (record?.file === fault?.file && fault?.operation === 'sync-error') throw new Error('synthetic I/O fault');
    const result = real.fsyncSync(fd);
    if (record) record.sync = ++order;
    return result;
  });
  t.mock.method(fs, 'closeSync', (fd) => {
    const record = active.get(fd);
    const result = real.closeSync(fd);
    if (record) { record.closed = true; record.close = ++order; active.delete(fd); }
    if (record?.file === fault?.file && fault?.operation === 'close-error') throw new Error('synthetic I/O fault');
    return result;
  });
  return records;
}

test('producer completes short writes, fsyncs files/directories and closes before success', async (t) => {
  const s = scratch(t);
  const b = s.bundle();
  const { produce } = await import('./task21-synthetic-retained-backup.mjs');
  const records = traceIo(t, b, { partial: true });
  const result = produce(b.dir);
  assert.equal(result.status, 'STORED');
  assert.equal(records.length, 4, 'two file handles and two directory handles');
  const c = fs.constants;
  for (const record of records) {
    assert.equal(record.closed, true, 'real descriptor closed before return');
    assert.equal(record.sync < record.close, true, 'sync precedes close');
    assert.throws(() => fs.fstatSync(record.fd), { code: 'EBADF' });
    if (record.file === b.key || record.file === b.artifact) {
      const required = c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW;
      assert.equal(record.flags & required, required, 'exclusive no-follow creation');
      assert.equal(record.mode, 0o600);
      assert.equal(record.written, fs.statSync(record.file).size, 'complete writes');
      assert.equal(record.writes > 1, true, 'real short writes exercised');
      assert.equal(record.lastWrite < record.sync, true, 'all writes precede fsync');
    }
  }
  t.mock.restoreAll();
  recovered(s, b); // Real process still consumes files created under short writes.
});

for (const which of ['key', 'artifact']) {
  for (const operation of ['write-zero', 'write-error', 'sync-error', 'close-error']) {
    test(`producer closes descriptor and fails on ${which} ${operation}`, async (t) => {
      const s = scratch(t);
      const b = s.bundle();
      const { produce } = await import('./task21-synthetic-retained-backup.mjs');
      const records = traceIo(t, b, { fault: { file: b[which], operation } });
      rejectsCall(() => produce(b.dir));
      assert.equal(records.every((r) => r.closed), true, 'no descriptor leaks on failure');
      assert.equal(records.some((r) => r.file === b[which]), true, 'fault reached intended file');
      for (const record of records) assert.throws(() => fs.fstatSync(record.fd), { code: 'EBADF' });
      t.mock.restoreAll();
    });
  }
}

test('directory sync failure prevents a success receipt and still closes the handle', async (t) => {
  const s = scratch(t);
  const b = s.bundle();
  const { produce } = await import('./task21-synthetic-retained-backup.mjs');
  const records = traceIo(t, b, { fault: { file: b.dir, operation: 'sync-error' } });
  rejectsCall(() => produce(b.dir));
  assert.equal(records.length, 3);
  assert.equal(records.every((r) => r.closed), true);
  t.mock.restoreAll();
});

for (const which of ['key', 'artifact']) {
  for (const kind of ['file', 'symlink', 'dangling-symlink']) {
    test(`exclusive producer creation rejects inserted ${which} ${kind}`, async (t) => {
      const s = scratch(t);
      const b = s.bundle();
      const target = path.join(s.root, 'owned-sentinel');
      s.files.add(target);
      const sentinel = Buffer.from('synthetic-preserve-this-file');
      fs.writeFileSync(target, sentinel, { flag: 'wx', mode: 0o600 });
      const { produce } = await import('./task21-synthetic-retained-backup.mjs');
      let inserted = false;
      traceIo(t, b, { atOpen(file) {
        if (file !== b[which] || inserted) return;
        inserted = true;
        if (kind === 'file') fs.writeFileSync(file, sentinel, { flag: 'wx', mode: 0o600 });
        else fs.symlinkSync(kind === 'symlink' ? target : path.join(s.root, 'never-created'), file);
      } });
      rejectsCall(() => produce(b.dir));
      t.mock.restoreAll();
      assert.equal(inserted, true, 'collision was inserted immediately before real exclusive open');
      assert.equal(fs.readFileSync(target).equals(sentinel), true, 'own link target unchanged');
      if (kind === 'file') assert.equal(fs.readFileSync(b[which]).equals(sentinel), true);
      else assert.equal(fs.lstatSync(b[which]).isSymbolicLink(), true, 'link was not replaced');
    });
  }
}

test('consumer completes short reads and closes both read-only no-follow handles', async (t) => {
  const s = scratch(t);
  const b = s.bundle();
  stored(s, b);
  const { consume } = await import('./task21-synthetic-retained-backup.mjs');
  const records = traceIo(t, b, { partial: true });
  const receipt = consume(b.artifact, b.key);
  assert.equal(JSON.stringify(receipt) === JSON.stringify(EXPECTED), true);
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.closed, true);
    assert.equal(record.written, 0);
    assert.equal(record.read, fs.statSync(record.file).size);
    assert.equal(record.reads > 1, true);
    assert.equal(record.flags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
    assert.equal(record.flags & fs.constants.O_NONBLOCK, fs.constants.O_NONBLOCK);
    assert.equal(record.flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR), 0);
    assert.throws(() => fs.fstatSync(record.fd), { code: 'EBADF' });
  }
  t.mock.restoreAll();
});

for (const which of ['artifact', 'key']) {
  test(`oversize ${which} is refused before any payload read and descriptor is closed`, async (t) => {
    const s = scratch(t);
    const b = s.bundle();
    stored(s, b);
    fs.truncateSync(b[which], which === 'artifact' ? 4097 : 513);
    const { consume } = await import('./task21-synthetic-retained-backup.mjs');
    const records = traceIo(t, b);
    rejectsCall(() => consume(b.artifact, b.key));
    const record = records.find((r) => r.file === b[which]);
    assert.equal(record.reads, 0);
    assert.equal(records.every((r) => r.closed), true);
    t.mock.restoreAll();
  });
  test(`consumer closes ${which} on a real-open injected read error`, async (t) => {
    const s = scratch(t);
    const b = s.bundle();
    stored(s, b);
    const { consume } = await import('./task21-synthetic-retained-backup.mjs');
    const records = traceIo(t, b, { fault: { file: b[which], operation: 'read-error' } });
    rejectsCall(() => consume(b.artifact, b.key));
    assert.equal(records.every((r) => r.closed), true);
    t.mock.restoreAll();
  });
}
