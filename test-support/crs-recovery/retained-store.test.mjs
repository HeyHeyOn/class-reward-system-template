import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { retainSyntheticPgDump, retrieveSyntheticPgDump } from '../../src/server/exports/syntheticPgRecovery.ts';

const binding = Object.freeze({ tenantId: '11111111-1111-4111-8111-111111111111',
  jobId: '22222222-2222-4222-8222-222222222222', generation: 7,
  exportId: '33333333-3333-4333-8333-333333333333' });
const at = '2026-09-26T00:00:00.000Z';
// Deliberately NOT a valid database. File tests MUST NOT claim PG recovery.
const bytes = Buffer.from('PGDMP\u0000synthetic byte transport only');
const sha = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(new URL('./scratch-', import.meta.url).pathname);
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = randomBytes(32);
  const receipt = await retainSyntheticPgDump({ directory: root, binding, key, dump: bytes, at });
  const expected = { ...binding, manifestSha256: receipt.manifestSha256 };
  return { root, key, receipt, expected, get: (extra = {}) => retrieveSyntheticPgDump({ directory: root, expected, key, ...extra }) };
}

test('stored ciphertext + pinned descriptor recovers bytes; no authorization flag promoted', async t => {
  const f = await fixture(t);
  const result = await f.get();
  assert.deepEqual(result.dump, bytes);
  assert.equal(result.kind, 'SYNTHETIC_DUMP_RETRIEVED');
  assert.equal(result.restoreAllowed, false);
  const manifest = JSON.parse(await readFile(join(f.root, 'manifest.json'), 'utf8'));
  const stored = await readFile(join(f.root, `${manifest.artifacts[0].artifactId}.json`));
  assert.equal(stored.includes(bytes), false);
  assert.equal(stored.includes(f.key), false);
});
for (const field of ['tenantId', 'jobId', 'generation', 'exportId', 'manifestSha256']) {
  test(`reject wrong independently supplied ${field}`, async t => {
    const f = await fixture(t);
    const bad = field === 'generation' ? 8 : field === 'manifestSha256' ? '0'.repeat(64) : '44444444-4444-4444-8444-444444444444';
    await assert.rejects(f.get({ expected: { ...f.expected, [field]: bad } }), /Synthetic recovery refused/);
  });
}
test('lost/wrong key fails closed', async t => {
  const f = await fixture(t);
  for (const key of [undefined, Buffer.alloc(31), randomBytes(32)]) await assert.rejects(f.get({ key }), /Synthetic recovery refused/);
});
test('replacement bytes + repaired untrusted manifest still fail the external pin', async t => {
  const f = await fixture(t);
  const manifest = JSON.parse(await readFile(join(f.root, 'manifest.json'), 'utf8'));
  const part = manifest.artifacts[0];
  const path = join(f.root, `${part.artifactId}.json`);
  const data = await readFile(path);
  data[data.length - 4] ^= 1;
  await writeFile(path, data);
  part.digest.hex = sha(data);
  await writeFile(join(f.root, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(f.get(), /Synthetic recovery refused/);
});
for (const fault of ['missing', 'truncate', 'symlink', 'permissions']) {
  test(`reject stored artifact ${fault}`, async t => {
    const f = await fixture(t);
    const manifest = JSON.parse(await readFile(join(f.root, 'manifest.json'), 'utf8'));
    const path = join(f.root, `${manifest.artifacts[0].artifactId}.json`);
    if (fault === 'missing') await rm(path);
    if (fault === 'truncate') await writeFile(path, '{}');
    if (fault === 'permissions') await chmod(path, 0o644);
    if (fault === 'symlink') { await rm(path); await symlink('manifest.json', path); }
    await assert.rejects(f.get(), /Synthetic recovery refused/);
  });
}
test('GCM rejects a modified tag even when the supplied digest pin is refreshed', async t => {
  const f = await fixture(t);
  const manifest = JSON.parse(await readFile(join(f.root, 'manifest.json'), 'utf8'));
  const part = manifest.artifacts[0];
  const path = join(f.root, `${part.artifactId}.json`);
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  const tag = Buffer.from(envelope.tag, 'base64');
  tag[0] ^= 1;
  envelope.tag = tag.toString('base64');
  const stored = JSON.stringify(envelope);
  await writeFile(path, stored);
  part.digest.hex = sha(stored);
  const wire = JSON.stringify(manifest);
  await writeFile(join(f.root, 'manifest.json'), wire);
  await assert.rejects(f.get({ expected: { ...f.expected, manifestSha256: sha(wire) } }), /Synthetic recovery refused/);
});
test('AAD forbids transplant to another context with a replaced manifest/pin', async t => {
  const f = await fixture(t);
  const manifest = JSON.parse(await readFile(join(f.root, 'manifest.json'), 'utf8'));
  manifest.generation = 8;
  const wire = JSON.stringify(manifest);
  await writeFile(join(f.root, 'manifest.json'), wire);
  await assert.rejects(f.get({ expected: { ...f.expected, generation: 8, manifestSha256: sha(wire) } }), /Synthetic recovery refused/);
});
test('incomplete publication and overly broad directory permissions refuse retrieval', async t => {
  const f = await fixture(t);
  await rm(join(f.root, 'manifest.json'));
  await assert.rejects(f.get(), /Synthetic recovery refused/);
  await chmod(f.root, 0o755);
  await assert.rejects(f.get(), /Synthetic recovery refused/);
});
test('non-PG transport and oversized dump refuse publication without files', async t => {
  const root = await mkdtemp(new URL('./scratch-', import.meta.url).pathname);
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dump of [Buffer.from('not-a-dump'), Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(5 * 1024 * 1024)])]) {
    await assert.rejects(retainSyntheticPgDump({ directory: root, binding, key: randomBytes(32), dump, at }), /Synthetic recovery refused/);
  }
});
test('publication is exclusive; cannot silently replace an existing export', async t => {
  const f = await fixture(t);
  await assert.rejects(retainSyntheticPgDump({ directory: f.root, binding, key: f.key, dump: bytes, at }), /Synthetic recovery refused/);
  assert.deepEqual((await f.get()).dump, bytes);
});
test('producer exits before independent consumer reads only stored bytes and external pin/key', async t => {
  const root = await mkdtemp(new URL('./scratch-', import.meta.url).pathname);
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = randomBytes(32);
  const run = input => spawnSync(process.execPath, ['--conditions=react-server', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    new URL('./store-worker.mjs', import.meta.url).pathname], { input: JSON.stringify(input),
    env: { PATH: process.env.PATH, LANG: 'C' }, timeout: 10000, maxBuffer: 12000000 });
  const producer = run({ mode: 'retain', directory: root, binding, key: key.toString('base64'), dump: bytes.toString('base64'), at });
  assert.equal(producer.status, 0, producer.stderr.toString());
  const receipt = JSON.parse(producer.stdout);
  const consumer = run({ mode: 'retrieve', directory: root, expected: { ...binding, manifestSha256: receipt.manifestSha256 }, key: key.toString('base64') });
  assert.equal(consumer.status, 0, consumer.stderr.toString());
  const recovered = JSON.parse(consumer.stdout);
  assert.notEqual(receipt.pid, recovered.pid);
  assert.deepEqual(Buffer.from(recovered.dump, 'base64'), bytes);
  assert.equal(recovered.dumpSha256, sha(bytes));
  // stdout dump is captured IPC, never a console/log output.
  for (const output of [producer.stdout, producer.stderr, consumer.stderr]) assert.equal(output.includes(Buffer.from(key.toString('base64'))), false);
  t.diagnostic(JSON.stringify({ stage: 'SYNTHETIC_BYTES_ONLY', producerPid: receipt.pid, consumerPid: recovered.pid,
    producerExit: producer.status, consumerExit: consumer.status, database: 'NOT_RUN' }));
});
