import 'server-only';
import { randomUUID } from 'node:crypto';
import { constants as C } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import type { DisposablePostgres } from './disposablePostgres';
import { inspectArchiveDatabase } from './ownedPgArchive';
import { createTenantTransactionRunner } from '../transaction';
import { captureLocalMixedRetentionV2, verifyLocalMixedRetentionV2 } from '@/server/migration/localMixedRetentionV2';
import type { MixedRetentionBinding } from '@/server/migration/localMixedRetentionV2';
import { canonicalJson, sha256 } from '@/server/migration/validators';

/** A launcher-owned expectation, held outside the artifact. Never derive this
 * pin/digest from an archive being verified. Same-UID trusted exclusive lease;
 * not a signature or defense against an owner rewriting both archive and pin. */
export type MixedRetentionPin = Readonly<{
  directory: string; device: number; inode: number; artifactId: string; ownerId: string;
  sourceDatabaseId: string; sourceOwnerId: string; sha256: string;
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BYTES = 32_000_000;
const busy = new WeakSet<DisposablePostgres>();
function refused(): never { throw new Error('Local mixed V2 retention archive refused.'); }
const dirFlags = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;

/** Explicit V2 file admission; never sniff/fallback to V1.
 * Source-independent read ONLY. No restore, fallback, database URL, catalog,
 * Task21 helper, grant, writer fence, authority or lifecycle mutation. */
export async function readOwnedMixedRetentionV2(pin: MixedRetentionPin, expected: MixedRetentionBinding) {
  try {
    if (!UUID.test(pin.artifactId) || !UUID.test(pin.ownerId) || !UUID.test(pin.sourceDatabaseId)
      || !UUID.test(pin.sourceOwnerId) || pin.ownerId === pin.sourceOwnerId || !/^[0-9a-f]{64}$/.test(pin.sha256)
      || basename(pin.directory) !== `task19-mixed-v2-retention-${pin.artifactId}`
      || resolve(pin.directory) !== pin.directory || await realpath(pin.directory) !== pin.directory) refused();
    const directory = await open(pin.directory, dirFlags);
    try {
      const stat = await directory.stat();
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700
        || stat.dev !== pin.device || stat.ino !== pin.inode) refused();
      // Anchor the leaf to the opened directory inode, not a second path lookup.
      const file = await open(`/proc/self/fd/${directory.fd}/artifact.json`, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      let bytes: string;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
          || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > MAX_BYTES) refused();
        bytes = await file.readFile('utf8');
      } finally { await file.close(); }
      if (Buffer.byteLength(bytes) > MAX_BYTES || sha256(bytes) !== pin.sha256) refused();
      const wrapper = JSON.parse(bytes);
      const { evidence, ...identity } = wrapper;
      if (canonicalJson(identity) !== canonicalJson({ format: 'TASK19_OWNED_MIXED_ARCHIVE_V2', artifactId: pin.artifactId,
        ownerId: pin.ownerId, sourceDatabaseId: pin.sourceDatabaseId, sourceOwnerId: pin.sourceOwnerId })) refused();
      return verifyLocalMixedRetentionV2(canonicalJson(evidence), expected);
    } finally { await directory.close(); }
  } catch { refused(); }
}

/** Linux disposable-test storage. Fsync file, newly owned directory and parent;
 * receipt is returned only after exact readback. Bytes survive application/source
 * PG closure while this local filesystem and the external pin remain. No host,
 * disk, container/filesystem-loss durability or production backup claim. */
export async function retainOwnedMixedProvenanceV2(source: DisposablePostgres, sourceOwnerId: string,
  binding: MixedRetentionBinding, parent: string): Promise<MixedRetentionPin> {
  if (busy.has(source)) refused();
  busy.add(source);
  try {
    if (process.env.RUN_REAL_POSTGRES !== '1' || !UUID.test(sourceOwnerId)) refused();
    await inspectArchiveDatabase(source); // real owned no-network/no-volume PG, not a branded DTO
    const run = createTenantTransactionRunner({ pool: source.runtime }, { isolationLevel: 'REPEATABLE READ', maxAttempts: 1 });
    const evidence = await run(binding.tenantId, async tx => {
      // Marker is immutable and held by the exclusive allocator lease. FOR SHARE
      // would incorrectly require UPDATE privilege; runtime remains SELECT-only.
      const marker = (await tx.execute(sql`SELECT database_id,owner_id,role,tenant_id,job_id FROM migration_local_disposable_database`)).rows;
      if (canonicalJson(marker) !== canonicalJson([{ database_id: source.runId, owner_id: sourceOwnerId,
        role: 'SOURCE', tenant_id: binding.tenantId, job_id: binding.migrationJobId }])) refused();
      const tenant = (await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${binding.tenantId} FOR SHARE`)).rows;
      if (tenant.length !== 1 || tenant[0].lifecycle !== 'IMPORTING') refused();
      return captureLocalMixedRetentionV2(binding, tx);
    });
    const root = resolve(parent);
    if (await realpath(root) !== root) refused();
    const rootHandle = await open(root, dirFlags);
    try {
      const rootStat = await rootHandle.stat();
      if (rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o777) !== 0o700) refused();
      const artifactId = randomUUID(), ownerId = randomUUID();
      const directory = join(root, `task19-mixed-v2-retention-${artifactId}`);
      const bytes = canonicalJson({ format: 'TASK19_OWNED_MIXED_ARCHIVE_V2', artifactId, ownerId,
        sourceDatabaseId: source.runId, sourceOwnerId, evidence });
      if (Buffer.byteLength(bytes) > MAX_BYTES) refused();
      await mkdir(directory, { mode: 0o700 }); // unique, exclusively owned; never overwrite
      const handle = await open(directory, dirFlags);
      let stat;
      try {
        stat = await handle.stat();
        const file = await open(`/proc/self/fd/${handle.fd}/artifact.json`, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await handle.sync();
        await rootHandle.sync();
      } finally { await handle.close(); }
      const pin = Object.freeze({ directory, device: stat.dev, inode: stat.ino, artifactId, ownerId,
        sourceDatabaseId: source.runId, sourceOwnerId, sha256: sha256(bytes) });
      await readOwnedMixedRetentionV2(pin, binding);
      return pin;
    } finally { await rootHandle.close(); }
  } catch { refused(); }
  finally { busy.delete(source); }
}
