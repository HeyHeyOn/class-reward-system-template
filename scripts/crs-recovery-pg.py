#!/usr/bin/env python3
"""Opt-in synthetic PG17 rehearsal. Never accepts a DSN or an existing container.
Shared Docker execution is Sol-only after the worktree is frozen. --help is inert.
Key arrives on an already-open FD; caller owns separate durable synthetic custody.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
SUPPORT = ROOT / 'test-support/crs-recovery'
LABEL = 'io.class-store.crs-recovery'
UUID_RE = r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
CATEGORIES = {
    'STUDENTS': ('students',), 'BALANCES': ('accounts',),
    'PRODUCTS': ('products',), 'STOCK': ('inventory_ledger',),
    'TRANSACTIONS': ('transactions', 'transaction_items', 'adjustments'),
    'CANCELLATIONS': ('transactions',), 'TASKS': ('tasks', 'task_allowed_students'),
    'ASSIGNMENTS': ('task_assignments',), 'COMPLETIONS': ('task_completions',),
    'PROMOTIONS': ('promotions', 'promotion_products'), 'RECURRENCE': ('tasks',),
    'PADLET_CLAIMS': ('padlet_evidence_claims', 'padlet_claim_digest_registry', 'padlet_claim_digest_tombstones'),
    'OPERATION_BINDINGS': ('operations',),
}


class Refused(RuntimeError):
    """Only fixed, nonsecret diagnostic labels are emitted."""


def require(ok, label):
    if not ok:
        raise Refused(label)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_binding(binding):
    require(set(binding) == {'tenantId', 'jobId', 'generation', 'exportId'}, 'binding-shape')
    for field in ('tenantId', 'jobId', 'exportId'):
        require(isinstance(binding[field], str) and re.fullmatch(UUID_RE, binding[field]), 'binding-id')
    require(type(binding['generation']) is int and 1 <= binding['generation'] <= 9007199254740991, 'binding-generation')


def compare(source, restored):
    """DB observations, NOT comparisons to a reserialized seed/fixture oracle."""
    require(source['rows'] == restored['rows'], 'full-row-mismatch')
    require(source['schemaSha256'] == restored['schemaSha256'], 'schema-mismatch')
    require(source['sequences'] == restored['sequences'], 'sequence-mismatch')
    require(source['catalog'] == restored['catalog'], 'privilege-catalog-mismatch')
    require(source['probes'] == restored['probes'], 'denial-probe-mismatch')
    check_source_coverage(source)
    require(source['invariants'] == restored['invariants'] == [True] * 5, 'business-invariant')
    require(source['binding'] == restored['binding'] and source['binding']['matched'], 'db-binding')
    return {name: 'MATCH_SYNTHETIC' for name in CATEGORIES}


def check_source_coverage(source):
    for tables in CATEGORIES.values():
        require(all(source['rows'].get(t, {}).get('count', 0) > 0 for t in tables), 'empty-required-category')
    require(source['invariants'] == [True] * 5, 'business-invariant')
    require(source['binding']['matched'], 'db-binding')


def clean_environment(home):
    # No host PG*, DATABASE_URL, credentials, dotenv, Docker contexts or config.
    return {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(home),
            'DOCKER_CONFIG': str(home), 'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC'}


def run(argv, *, data=None, env, timeout=40, stage='subprocess', check=True):
    try:
        result = subprocess.run(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=env, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Refused(stage + '-unavailable-or-timeout') from None
    if check:
        require(result.returncode == 0, stage + '-failed')
    return result


class OwnedPg:
    def __init__(self, image, env, journal=None):
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', image), 'image-id-required')
        self.image, self.env, self.id = image, env, None
        self.owner = str(uuid.uuid4())
        self.evidence = {}
        self.journal = journal

    def record(self, phase, data):
        if self.journal:
            atomic_json(self.journal / f'{self.owner}-{phase}.json', data)

    def docker(self, *args, data=None, check=True, timeout=40):
        return run(['docker', '--host', 'unix:///var/run/docker.sock', *args], data=data,
                   env=self.env, timeout=timeout, stage='owned-docker', check=check)

    def inspect(self):
        require(self.id is not None and re.fullmatch(r'[0-9a-f]{64}', self.id), 'owned-id')
        info = json.loads(self.docker('inspect', self.id).stdout)[0]
        require(info['Id'] == self.id and info['Config']['Labels'].get(LABEL) == self.owner, 'ownership')
        return info

    def start(self):
        image = self.docker('image', 'inspect', self.image, '--format', '{{.Id}}').stdout.decode().strip()
        require(image == self.image, 'cached-image-id')
        self.id = self.docker('create', '--pull', 'never', '--name', 'crs-recovery-' + self.owner,
            '--label', LABEL + '=' + self.owner, '--network', 'none', '--read-only', '--user', 'postgres',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128',
            '--memory', '512m', '--cpus', '1',
            '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=256m,mode=1777',
            '--tmpfs', '/var/run/postgresql:rw,nosuid,nodev,noexec,size=8m,mode=1777',
            '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
            '-e', 'PGDATA=/var/lib/postgresql/data/pgdata',
            '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
            '-e', 'POSTGRES_INITDB_ARGS=--auth-local=trust --auth-host=reject',
            self.image, 'postgres', '-c', 'listen_addresses=', '-c', 'unix_socket_permissions=0700',
            '-c', 'log_statement=none').stdout.decode().strip()
        self.record('created', {'containerId': self.id, 'owner': self.owner, 'pythonPid': os.getpid(), 'cleanup': 'PENDING'})
        info = self.inspect()
        conf = info['HostConfig']
        allowed = {'/var/lib/postgresql/data', '/var/run/postgresql', '/tmp'}
        require(conf['NetworkMode'] == 'none' and not conf['PortBindings'] and not conf['PublishAllPorts']
                and not conf['Binds'] and not conf['VolumesFrom'] and conf['ReadonlyRootfs']
                and not conf['Privileged'] and info['Config']['User'] == 'postgres'
                and 'ALL' in conf['CapDrop'] and 'no-new-privileges' in conf['SecurityOpt']
                and set(conf['Tmpfs']) == allowed
                and all(m['Type'] == 'tmpfs' and m['Destination'] in allowed for m in info['Mounts']), 'isolation')
        self.docker('start', self.id)
        deadline = time.monotonic() + 30
        while True:
            ready = self.docker('exec', '--user', 'postgres', self.id, 'pg_isready', '-h', '/var/run/postgresql', '-U', 'postgres', check=False)
            if ready.returncode == 0:
                break
            require(time.monotonic() < deadline, 'pg-readiness')
            time.sleep(.1)
        version = self.sql("SELECT current_setting('server_version')").decode().strip()
        require(version.startswith('17.'), 'pg17-required')
        identity = json.loads(self.sql("SELECT json_build_object('systemIdentifier',system_identifier::text,'postmasterStart',pg_postmaster_start_time()::text,'backendPid',pg_backend_pid(),'database',current_database()) FROM pg_control_system()"))
        self.evidence = {'containerId': self.id, 'owner': self.owner, 'imageId': self.image,
                         'version': version, 'databaseIdentity': identity, 'network': 'none',
                         'hostMounts': 0, 'publishedPorts': 0, 'readOnlyRoot': True}
        # No GRANT or role membership changes. Denial-only fixture role.
        self.sql('CREATE ROLE crs_recovery_denied NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT')
        return self

    def sql(self, text, *, binding=None):
        result = self.sql_result(text, binding=binding)
        require(result.returncode == 0, 'owned-sql-failed')
        return result.stdout

    def sql_result(self, text, *, binding=None):
        argv = ['exec', '-i', '--user', 'postgres', self.id, 'psql', '-X', '-qAt',
                '-v', 'ON_ERROR_STOP=1', '-h', '/var/run/postgresql', '-U', 'postgres', '-d', 'postgres']
        if binding:
            argv += ['-v', 'tenant=' + binding['tenantId'], '-v', 'job=' + binding['jobId'],
                     '-v', 'generation=' + str(binding['generation'])]
        return self.docker(*argv, data=text.encode() if isinstance(text, str) else text, check=False)

    def dump(self, schema=False):
        return self.docker('exec', '--user', 'postgres', self.id, 'pg_dump', '-h', '/var/run/postgresql',
                           '-U', 'postgres', '-d', 'postgres', *(('--schema-only',) if schema else ('-Fc',))).stdout

    def observation(self, binding):
        tables = json.loads(self.sql("SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]') FROM pg_tables WHERE schemaname='public'"))
        require(tables and all(re.fullmatch('[a-z_][a-z0-9_]*', t) for t in tables), 'table-discovery')
        rows, probes = {}, {}
        for table in tables:
            # to_jsonb escapes embedded newlines, sorts object keys in PG, retains
            # all fields incl synthetic hashes. Duplicate rows retain multiplicity.
            observed = self.sql(f'SELECT to_jsonb(t)::text FROM public."{table}" t').splitlines()
            rows[table] = {'count': len(observed), 'sha256': digest(b'\n'.join(sorted(observed)))}
            denied = self.sql_result(f'SET ROLE crs_recovery_denied; SELECT * FROM public."{table}" LIMIT 1;')
            require(denied.returncode != 0 and b'permission denied' in denied.stderr and not denied.stdout, 'unprivileged-select-denial')
            probes[table] = 'DENIED_NO_GRANTS'
        catalog = json.loads(self.sql("""SELECT json_build_object(
          'tables',(SELECT json_agg(json_build_array(relname,relrowsecurity,relforcerowsecurity,relacl::text,pg_get_userbyid(relowner)) ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','S')),
          'roles',(SELECT json_agg(json_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) ORDER BY rolname) FROM pg_roles),
          'memberships',(SELECT coalesce(json_agg(json_build_array(pg_get_userbyid(roleid),pg_get_userbyid(member),admin_option) ORDER BY roleid,member),'[]') FROM pg_auth_members))"""))
        sequences = {}
        names = json.loads(self.sql("SELECT coalesce(json_agg(sequencename ORDER BY sequencename),'[]') FROM pg_sequences WHERE schemaname='public'"))
        for name in names:
            require(re.fullmatch('[a-z_][a-z0-9_]*', name), 'sequence-name')
            sequences[name] = self.sql(f'SELECT last_value,is_called FROM public."{name}"').decode().strip()
        # PG17.6+ emits a random psql restrict key; it is not schema content.
        schema = b'\n'.join(line for line in self.dump(schema=True).splitlines()
                            if not re.fullmatch(rb'\\(?:un)?restrict [A-Za-z0-9]+', line))
        invariant_sql = """SELECT json_build_array(
          (SELECT balance=23 FROM accounts WHERE student_id='s'),
          (SELECT stock=5 FROM products WHERE product_id='p'),
          (SELECT sum(balance_delta)=23 AND count(*)=4 FROM transactions),
          (SELECT count(*)=1 FROM transactions WHERE kind='CANCELLATION' AND reverses_transaction_id='buy'),
          (SELECT count(*)=1 FROM task_completions WHERE transaction_id='reward' AND operation_id='op' AND reward_snapshot=3))"""
        context = json.loads(self.sql("""SELECT json_build_object('matched', EXISTS(
          SELECT 1 FROM migration_final_generations g JOIN migration_jobs j USING(tenant_id,job_id)
          WHERE g.tenant_id=:'tenant'::uuid AND g.job_id=:'job' AND g.generation_id='synthetic:' || :'generation'
          AND g.phase='LOCAL_CANDIDATE' AND g.exclusion='NOT_PROVEN'),
          'tenantCount',(SELECT count(*) FROM tenants))""", binding=binding))
        require(context['tenantCount'] == 1, 'single-synthetic-tenant')
        return {'rows': rows, 'schemaSha256': digest(schema), 'sequences': sequences, 'catalog': catalog,
                'probes': probes, 'invariants': json.loads(self.sql(invariant_sql)), 'binding': context}

    def close(self):
        if self.id:
            self.inspect()
            self.docker('rm', '--force', '--volumes', self.id)
            remaining = self.docker('ps', '-aq', '--no-trunc', '--filter', 'id=' + self.id).stdout.strip()
            require(not remaining, 'cleanup-container-survived')
        result = {'containerRemoved': True, 'containerId': self.id, 'volumes': 'TMPFS_ONLY'}
        self.record('cleanup', result)
        return result


def store_worker(payload, env):
    result = run(['node', '--conditions=react-server', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
                  str(SUPPORT / 'store-worker.mjs')], data=json.dumps(payload).encode(), env=env,
                 timeout=30, stage='retained-store')
    return json.loads(result.stdout)


def worker(payload):
    validate_binding(payload['binding'])
    with tempfile.TemporaryDirectory(prefix='owned-pg-', dir=SUPPORT) as scratch:
        env = clean_environment(scratch)
        journal = Path(payload['evidenceRoot'])
        require(journal.parent.resolve() == SUPPORT.resolve() and journal.is_dir() and not journal.is_symlink(), 'journal-root')
        pg = OwnedPg(payload['image'], env, journal)
        result = {'pythonPid': os.getpid(), 'mode': payload['mode']}
        try:
            pg.start()
            if payload['mode'] == 'producer':
                for migration in payload['migrations']:
                    content = base64.b64decode(migration['bytes'], validate=True)
                    require(digest(content) == migration['sha256'], 'migration-fingerprint')
                    pg.sql(content)
                seed = base64.b64decode(payload['seed'], validate=True)
                pg.sql(seed, binding=payload['binding'])
                observed = pg.observation(payload['binding'])
                # Fail before publication if any required synthetic category empty.
                check_source_coverage(observed)  # readiness only; no restore comparison
                dump = pg.dump()
                # There are no other writers; independently read source AGAIN to
                # catch dump-time mutation. This is not production writer fencing.
                require(pg.observation(payload['binding']) == observed, 'source-changed-during-dump')
                receipt = store_worker({'mode': 'retain', 'directory': payload['artifactRoot'],
                    'binding': payload['binding'], 'key': payload['key'], 'dump': base64.b64encode(dump).decode(),
                    'at': payload['at']}, env)
                result.update(observation=observed, receipt=receipt)
            elif payload['mode'] == 'consumer':
                recovered = store_worker({'mode': 'retrieve', 'directory': payload['artifactRoot'],
                    'expected': payload['expected'], 'key': payload['key']}, env)
                require(pg.sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'").strip() == b'0', 'restore-target-not-empty')
                pg.docker('exec', '-i', '--user', 'postgres', pg.id, 'pg_restore', '--exit-on-error',
                    '--single-transaction', '-h', '/var/run/postgresql', '-U', 'postgres', '-d', 'postgres',
                    data=base64.b64decode(recovered['dump'], validate=True))
                result.update(observation=pg.observation(payload['binding']),
                              retrievedDumpSha256=recovered['dumpSha256'], retrievalPid=recovered['pid'])
            else:
                raise Refused('worker-mode')
            result['database'] = pg.evidence
        finally:
            result['cleanup'] = pg.close()
        return result


def atomic_json(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(data, stream, indent=2, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-owned-pg', action='store_true')
    parser.add_argument('--image-id')
    parser.add_argument('--tenant')
    parser.add_argument('--job')
    parser.add_argument('--generation', type=int)
    parser.add_argument('--export-id')
    parser.add_argument('--artifact-root', type=Path)
    parser.add_argument('--evidence-root', type=Path)
    parser.add_argument('--key-fd', type=int)
    args = parser.parse_args()
    require(args.run_owned_pg, 'NOT_RUN-explicit-Sol-runner-ownership-required')
    binding = {'tenantId': args.tenant, 'jobId': args.job, 'generation': args.generation, 'exportId': args.export_id}
    validate_binding(binding)
    require(args.image_id and re.fullmatch('sha256:[0-9a-f]{64}', args.image_id), 'pinned-image-required')
    if args.key_fd is None or args.key_fd < 3:
        raise Refused('separate-synthetic-key-fd-required')
    key = os.read(args.key_fd, 33)
    require(len(key) == 32, 'synthetic-key-size')
    if args.artifact_root is None or args.evidence_root is None:
        raise Refused('private-roots-required')
    paths = [args.artifact_root.absolute(), args.evidence_root.absolute()]
    for path in paths:
        require(path.parent.resolve() == SUPPORT.resolve() and not path.exists() and not path.is_symlink(), 'new-private-support-root-required')
    require(paths[0] != paths[1], 'separate-artifact-evidence-roots')
    for path in paths:
        path.mkdir(mode=0o700)
    artifacts, evidence = paths
    migrations = []
    for path in sorted((ROOT / 'src/server/db/migrations').glob('[0-9][0-9][0-9][0-9]_*.sql')):
        content = path.read_bytes()
        migrations.append({'name': path.name, 'sha256': digest(content), 'bytes': base64.b64encode(content).decode()})
    require(migrations, 'migrations-missing')
    payload = {'mode': 'producer', 'binding': binding, 'artifactRoot': str(artifacts),
               'image': args.image_id, 'key': base64.b64encode(key).decode(), 'migrations': migrations,
               'evidenceRoot': str(evidence),
               'seed': base64.b64encode((SUPPORT / 'seed.sql').read_bytes()).decode(),
               'at': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())}
    started = time.monotonic()
    report = {'task': 'Task21', 'acceptance': '0/4', 'stage': 'ISOLATED_PG_SYNTHETIC',
              'independentVerifier': 'NOT_RUN', 'effectiveRuntimeRls': 'NOT_PROVEN_NO_GRANTS',
              'productionDeltaReplay': 'NOT_IMPLEMENTED', 'binding': binding,
              'migrations': [{k: m[k] for k in ('name', 'sha256')} for m in migrations]}
    try:
        env = clean_environment(evidence)
        def invoke(data):
            # Only these internal child processes can construct an owned PG.
            child = subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()), '--internal-worker'],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
            try:
                output, error = child.communicate(json.dumps(data).encode(), timeout=240)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                # Allow the child's finally/ownership checks to clean up. If it
                # cannot, the created-ID journal is an explicit orphan handoff.
                child.terminate()
                try:
                    child.communicate(timeout=60)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.communicate()
                raise Refused('pg-child-timeout-or-interrupted-check-cleanup-journal') from None
            require(child.returncode == 0, 'pg-child-failed-check-cleanup-journal')
            return json.loads(output)
        source = invoke(payload)
        report['producer'] = source
        require(source['cleanup']['containerRemoved'], 'producer-cleanup-before-consumer')
        expected = {**binding, 'manifestSha256': source['receipt']['manifestSha256']}
        # Child consumer gets no source observations, seed SQL or migration bytes.
        consumer = invoke({'mode': 'consumer', 'binding': binding, 'artifactRoot': str(artifacts),
                           'image': args.image_id, 'key': payload['key'], 'expected': expected,
                           'evidenceRoot': str(evidence)})
        report['consumer'] = consumer
        require(source['pythonPid'] != consumer['pythonPid'], 'same-worker-process')
        require(source['database']['containerId'] != consumer['database']['containerId'], 'same-container')
        require(source['database']['databaseIdentity']['systemIdentifier'] != consumer['database']['databaseIdentity']['systemIdentifier'], 'same-cluster')
        require(source['receipt']['dumpSha256'] == consumer['retrievedDumpSha256'], 'dump-transport-mismatch')
        report['categories'] = compare(source['observation'], consumer['observation'])
        report['result'] = 'SYNTHETIC_SNAPSHOT_RESTORED_NOT_TASK21_ACCEPTANCE'
        report['exitCode'] = 0
    except Refused as error:
        report.update(result='BLOCKED_OR_FAILED', blocker=str(error), exitCode=1)
        raise
    except Exception:
        report.update(result='FAILED', blocker='unexpected-error-check-cleanup-journal', exitCode=1)
        raise
    finally:
        report['durationMs'] = round((time.monotonic() - started) * 1000)
        atomic_json(evidence / 'result.json', report)
    print(json.dumps({'result': report['result'], 'evidence': str(evidence / 'result.json'), 'task21': '0/4'}))


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--internal-worker']:
            # The internal protocol is still strictly synthetic and never accepts
            # a DSN/container target. No caller-controlled SQL beyond parent seed.
            def interrupt(_signum, _frame):
                raise Refused('worker-interrupted')
            signal.signal(signal.SIGTERM, interrupt)
            signal.signal(signal.SIGINT, interrupt)
            print(json.dumps(worker(json.load(sys.stdin))))
        else:
            main()
    except Refused as error:
        print('CRS recovery: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Avoid printing subprocess argv/input/dump/key or raw SQL exceptions.
        print('CRS recovery: unexpected failure; no recovery claim', file=sys.stderr)
        sys.exit(1)
