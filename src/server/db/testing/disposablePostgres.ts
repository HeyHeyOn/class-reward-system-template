import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rmSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { createTenantTransactionRunner } from '@/server/db/transaction';

const exec = promisify(execFile);
const LABEL = 'io.class-store.synthetic-pg-owner';
const DOCKER_SOCKET = 'unix:///var/run/docker.sock';
const IMAGE = 'postgres:17-alpine';
const SOCKET_PATH = '/var/run/postgresql/.s.PGSQL.5432';
const RELAY_PATH = '/test-bin/pg-stdio-relay';

type Inspection = {
  Id: string;
  Config: { Labels: Record<string, string>; User: string };
  HostConfig: {
    NetworkMode: string; PortBindings: Record<string, unknown> | null; PublishAllPorts: boolean;
    Binds: string[] | null; VolumesFrom: string[] | null; ReadonlyRootfs: boolean; Privileged: boolean;
    Tmpfs: Record<string, string>; CapDrop: string[]; SecurityOpt: string[];
  };
  Mounts: { Type: string; Destination: string }[];
};

/** PostgreSQL wire-protocol stream over docker-exec stdio, not a query adapter.
 * pg still handles parameter binding, parsing, transactions, errors and row types.
 * The only destination is the exact owned container's fixed local Unix socket.
 */
export class ExecSocket extends Duplex {
  private child?: ChildProcessWithoutNullStreams;
  constructor(private readonly container: string, private readonly environment: NodeJS.ProcessEnv) { super(); }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { this.child?.ref(); return this; }
  unref() { this.child?.unref(); return this; }
  connect(path: string) {
    if (path !== SOCKET_PATH || this.child) throw new Error('Unexpected PostgreSQL socket');
    const child = spawn('docker', ['--host', DOCKER_SOCKET, 'exec', '-i', '--user', 'postgres',
      this.container, RELAY_PATH], { env: this.environment, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', (data: Buffer) => { if (!this.push(data)) child.stdout.pause(); });
    child.stdout.on('end', () => this.push(null));
    // Relay output contains protocol bytes, never log them (even on failure).
    child.stderr.resume();
    child.on('error', (error) => this.destroy(error));
    child.stdin.on('error', (error) => { if (!this.destroyed) this.destroy(error); });
    child.once('spawn', () => this.emit('connect'));
    child.once('close', (code) => {
      if (!this.destroyed) this.destroy(code === 0 ? undefined : new Error(`Owned PostgreSQL relay exited ${code}`));
    });
    return this;
  }
  _read() { this.child?.stdout.resume(); }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (!this.child) return callback(new Error('PostgreSQL relay is not connected'));
    this.child.stdin.write(chunk, callback);
  }
  _final(callback: (error?: Error | null) => void) { this.child?.stdin.end(callback); }
  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.child?.stdin.destroy();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
    if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM');
    callback(error);
  }
}

export type DisposablePostgres = {
  runId: string;
  owner: Pool;
  runtime: Pool;
  runTenantTransaction: ReturnType<typeof createTenantTransactionRunner>;
  evidence: Record<string, unknown>;
  close(): Promise<{ containerRemoved: true; scratchRemoved: true; id: string }>;
};

export type DisposableColdRegistration = {
  packetId: string; attemptId: string;
  beforeCreate: (planned: {runId:string; imageId:string}) => Promise<void>;
  afterCreate: (created: {containerId:string}) => Promise<void>;
  beforeStart: () => Promise<void>;
};

/** Explicit test opt-in only. Never uses DATABASE_URL, host PG env, ports, mounts,
 * existing containers/volumes, registry pulls, production roles or TLS bypass.
 * Prerequisites: local Docker socket, cached PG17 Alpine image, static C compiler.
 */
export async function createDisposablePostgres(registration?: DisposableColdRegistration): Promise<DisposablePostgres> {
  if (process.env.RUN_REAL_POSTGRES !== '1') throw new Error('RUN_REAL_POSTGRES=1 is required');
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (registration && (!uuid.test(registration.packetId) || !uuid.test(registration.attemptId))) throw new Error('Invalid cold registration');
  registration=registration ? {...registration} : undefined;
  const runId = randomUUID();
  const name = `crs-app-pg-${runId}`;
  const scratch = await mkdtemp(join(tmpdir(), 'crs-app-pg-build-'));
  // Isolate Docker config too: never consult host login credentials/contexts.
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: scratch, DOCKER_CONFIG: scratch, LANG: 'C', NODE_ENV: 'test' };
  const docker = async (...args: string[]) => (await exec('docker', ['--host', DOCKER_SOCKET, ...args],
    { env: environment, timeout: 30_000, maxBuffer: 4_000_000 })).stdout.trim();
  let id: string | undefined;
  let owner: Pool | undefined;
  let runtime: Pool | undefined;
  let closed = false;
  const streams = new Set<ExecSocket>();
  // Last-resort worker-exit cleanup (e.g. a test framework hook timeout).
  // Normal teardown below is awaited and independently verifies disappearance.
  // SIGKILL/host crashes cannot be cleaned up by an in-process handler.
  const onExit = () => {
    if (closed) return;
    try {
      if (id && /^[a-f0-9]{64}$/.test(id)) {
        const options = { env: environment, timeout: 10_000, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
        const [owned] = JSON.parse(execFileSync('docker', ['--host', DOCKER_SOCKET, 'inspect', id], options)) as Inspection[];
        if (owned.Id === id && owned.Config.Labels?.[LABEL] === runId) {
          execFileSync('docker', ['--host', DOCKER_SOCKET, 'rm', '--force', id], options);
        }
      }
    } catch { /* Never broaden cleanup to a name pattern or unowned resource. */ }
    rmSync(scratch, { recursive: true, force: true });
  };
  process.once('exit', onExit);
  const inspectOwned = async (): Promise<Inspection> => {
    if (!id || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Missing exact owned container ID');
    const [inspection] = JSON.parse(await docker('inspect', id)) as Inspection[];
    if (inspection.Id !== id || inspection.Config.Labels?.[LABEL] !== runId) throw new Error('Container ownership mismatch');
    return inspection;
  };
  const close = async () => {
    if (closed) return { containerRemoved: true as const, scratchRemoved: true as const, id: id ?? '' };
    const failures: unknown[] = [];
    try {
      const results = await Promise.allSettled([owner?.end(), runtime?.end()]);
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
    } finally {
      for (const stream of streams) stream.destroy();
      try {
        if (id) {
          // Both exact ID and unpredictable ownership label must match; no prune,
          // broad name deletion, volume removal, or touching existing containers.
          const present = await docker('ps', '-aq', '--no-trunc', '--filter', `id=${id}`);
          if (present) {
            await inspectOwned();
            await docker('rm', '--force', id);
          }
          if (await docker('ps', '-aq', '--no-trunc', '--filter', `id=${id}`)) throw new Error('Owned container survived cleanup');
        }
      } catch (error) { failures.push(error); }
      await rm(scratch, { recursive: true, force: false });
      closed = failures.length === 0;
      if (closed) process.removeListener('exit', onExit);
    }
    if (failures.length) throw new AggregateError(failures, 'Disposable PostgreSQL cleanup failed');
    return { containerRemoved: true as const, scratchRemoved: true as const, id: id ?? '' };
  };
  try {
    await chmod(scratch, 0o700);
    const binary = join(scratch, 'pg-stdio-relay');
    await exec('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-static',
      resolve('src/server/db/testing/pgStdioRelay.c'), '-o', binary], { env: environment, timeout: 30_000 });
    const imageId = await docker('image', 'inspect', IMAGE, '--format', '{{.Id}}');
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Cached PostgreSQL image not found');
    // Durable creation intent precedes Docker. A kill between creation and the
    // returned handle remains identifiable but is not enough to allow deletion.
    await registration?.beforeCreate({runId,imageId});
    id = await docker('create', '--pull', 'never', '--name', name, '--label', `${LABEL}=${runId}`,
      ...(registration ? ['--label',`io.class-store.cold-packet=${registration.packetId}`,
        '--label',`io.class-store.cold-attempt=${registration.attemptId}`] : []),
      '--network', 'none', '--read-only', '--user', 'postgres', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '2',
      '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=256m,mode=1777',
      '--tmpfs', '/var/run/postgresql:rw,nosuid,nodev,noexec,size=8m,mode=1777',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
      '--tmpfs', '/test-bin:rw,nosuid,nodev,exec,size=4m,mode=1777',
      '-e', 'PGDATA=/var/lib/postgresql/data/pgdata', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e', 'POSTGRES_INITDB_ARGS=--auth-local=trust --auth-host=reject', imageId,
      'postgres', '-c', 'listen_addresses=', '-c', 'unix_socket_permissions=0700', '-c', 'log_statement=none');
    const inspection = await inspectOwned();
    const config = inspection.HostConfig;
    const expectedMounts = ['/test-bin', '/tmp', '/var/lib/postgresql/data', '/var/run/postgresql'];
    if (config.NetworkMode !== 'none' || Object.keys(config.PortBindings ?? {}).length || config.PublishAllPorts
      || config.Binds?.length || config.VolumesFrom?.length || !config.ReadonlyRootfs || config.Privileged
      || inspection.Config.User !== 'postgres' || !config.CapDrop.includes('ALL')
      || !config.SecurityOpt.includes('no-new-privileges')
      || JSON.stringify(Object.keys(config.Tmpfs).sort()) !== JSON.stringify(expectedMounts)
      || inspection.Mounts.some((mount) => mount.Type !== 'tmpfs' || !expectedMounts.includes(mount.Destination))) {
      throw new Error('Disposable PostgreSQL isolation check failed');
    }
    // Publish the exact ID only after physical isolation is checked. A separate
    // durable start intent closes the pending Docker-start/worker-death race:
    // CREATED alone must mean no start command was ever dispatched.
    await registration?.afterCreate({containerId:id});
    await registration?.beforeStart();
    await docker('start', id);
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { await docker('exec', '--user', 'postgres', id, 'pg_isready', '-h', '/var/run/postgresql', '-U', 'postgres'); break; }
      catch (error) { if (Date.now() >= deadline) throw new Error('Disposable PostgreSQL readiness failed', { cause: error }); }
      await new Promise((done) => setTimeout(done, 100));
    }
    // Docker cp rejects a read-only rootfs even for this writable tmpfs.
    // Keep rootfs protection: stream only our compiled relay into the owned
    // tmpfs, as the unprivileged container user, without a host bind mount.
    const relayBytes = await readFile(binary);
    await new Promise<void>((done, fail) => {
      const install = spawn('docker', ['--host', DOCKER_SOCKET, 'exec', '-i', '--user', 'postgres', id!,
        'dd', `of=${RELAY_PATH}`, 'bs=65536'], { env: environment, stdio: ['pipe', 'ignore', 'ignore'] });
      install.on('error', fail);
      install.stdin.on('error', fail);
      install.once('close', (code) => code === 0 ? done() : fail(new Error(`Owned tmpfs relay install failed: ${code}`)));
      install.stdin.end(relayBytes);
    });
    await docker('exec', '--user', 'postgres', id, 'chmod', '0500', RELAY_PATH);
    const relayMode = await docker('exec', '--user', 'postgres', id, 'stat', '-c', '%a %U %G', RELAY_PATH);
    const relayMount = (await docker('exec', '--user', 'postgres', id, 'dd', 'if=/proc/self/mountinfo', 'status=none'))
      .split('\n').find((line) => line.split(' ')[4] === '/test-bin');
    if (!relayMount || relayMount.includes('noexec') || relayMode !== '500 postgres postgres') {
      throw new Error(`Relay tmpfs/permissions differ from the test specification: ${relayMode}; ${relayMount}`);
    }
    // Exercise the executable before handing protocol bytes to pg, so an OCI /
    // mount failure is reported as a setup failure, not a misleading DB error.
    try {
      await docker('exec', '--user', 'postgres', id, '/bin/sh', '-c', `${RELAY_PATH} </dev/null >/dev/null`);
    } catch (error) {
      throw new Error(`Relay preflight failed without relaxing permissions: mode=${relayMode}; mount=${relayMount ?? 'unreported'}`, { cause: error });
    }
    const makePool = (user: string) => new Pool({
      user, database: 'postgres', host: '/var/run/postgresql', port: 5432,
      password: () => '', ssl: false, sslnegotiation: 'postgres',
      options: '-c timezone=UTC', client_encoding: 'UTF8', application_name: 'class-store-synthetic-app-test',
      connectionTimeoutMillis: 15_000, statement_timeout: 15_000, query_timeout: 20_000,
      idle_in_transaction_session_timeout: 30_000, max: 2, idleTimeoutMillis: 5_000,
      stream: () => {
        const stream = new ExecSocket(id!, environment);
        streams.add(stream);
        stream.once('close', () => streams.delete(stream));
        return stream;
      },
    });
    owner = makePool('postgres');
    owner.on('error', () => { /* Operation assertions expose connection failures; do not dump pool config. */ });
    const version = await owner.query<{ version: string }>("SELECT current_setting('server_version') AS version");
    if (!version.rows[0].version.startsWith('17.')) throw new Error('Real PostgreSQL 17 is required');
    const directory = resolve('src/server/db/migrations');
    const migrations: { name: string; sha256: string }[] = [];
    for (const file of (await readdir(directory)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort()) {
      const bytes = await readFile(join(directory, file));
      await owner.query(bytes.toString('utf8'));
      migrations.push({ name: file, sha256: createHash('sha256').update(bytes).digest('hex') });
      // Match the existing PGlite harness's baseline grants, but connect as the
      // role itself so real PG enforces its non-superuser / RLS boundary.
      if (file.startsWith('0008_')) await owner.query(`CREATE ROLE app_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
        GRANT USAGE ON SCHEMA public TO app_runtime;
        GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
        GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime`);
    }
    await owner.query('GRANT SELECT ON legacy_task_origins TO app_runtime');
    // Test-cluster-only privileges already used by localMultiAddedProductStage.test.ts.
    await owner.query(`GRANT SELECT,INSERT ON migration_final_generations,migration_final_source_records,migration_final_targets TO app_runtime;
      GRANT UPDATE (generation_id) ON migration_final_generations TO app_runtime`);
    runtime = makePool('app_runtime');
    runtime.on('error', () => { /* No credentials or protocol bytes in logs. */ });
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    if (role.rows.length !== 1 || role.rows[0].rolsuper || role.rows[0].rolbypassrls) throw new Error('Runtime role is privileged');
    return { runId, owner, runtime, runTenantTransaction: createTenantTransactionRunner({ pool: runtime }),
      evidence: { runId, containerId: id, ownerLabel: LABEL, imageId, version: version.rows[0].version,
        networkMode: config.NetworkMode, publishedPorts: 0, hostBinds: 0, existingVolumes: 0,
        tmpfs: Object.keys(config.Tmpfs).sort(), readOnlyRoot: true, droppedCapabilities: config.CapDrop,
        noNewPrivileges: true, connection: 'node-postgres wire protocol over docker exec to owned Unix socket',
        migrations }, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'PostgreSQL setup and cleanup failed'); }
    throw error;
  }
}
