"""Record only isolated local Node/Python checks. Never imports/runs a DB path."""
import ast
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = HERE / 'evidence'
OUT.mkdir(mode=0o700, exist_ok=True)
FILES = [ROOT / 'src/server/exports/syntheticPgRecovery.ts',
         ROOT / 'src/server/exports/retainedExportManifest.ts',
         ROOT / 'scripts/crs-recovery-pg.py', HERE / 'seed.sql', HERE / 'store-worker.mjs',
         HERE / 'retained-store.test.mjs', HERE / 'test_runner_guards.py', Path(__file__).resolve(),
         ROOT / 'node_modules/server-only/package.json', ROOT / 'node_modules/server-only/empty.js']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def hashes():
    return {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in FILES}


def text_command(argv):
    return subprocess.check_output(argv, cwd=ROOT, text=True).strip()


def save(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


initial = hashes()
manifest_sha = sha(json.dumps(initial, sort_keys=True, separators=(',', ':')).encode())
commands = [
    ['node', '--conditions=react-server', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--test', '--test-reporter=tap', 'test-support/crs-recovery/retained-store.test.mjs'],
    [sys.executable, '-B', 'test-support/crs-recovery/test_runner_guards.py'],
    [sys.executable, '-B', '-O', 'test-support/crs-recovery/test_runner_guards.py'],
    [sys.executable, '-B', 'scripts/crs-recovery-pg.py', '--help'],
    ['node', '--check', 'test-support/crs-recovery/store-worker.mjs'],
    ['node', '--check', 'test-support/crs-recovery/retained-store.test.mjs'],
    ['git', 'diff', '--check', '--', 'src/server/exports', 'test-support/crs-recovery', 'scripts/crs-recovery-pg.py'],
]
for path in [ROOT / 'scripts/crs-recovery-pg.py', HERE / 'test_runner_guards.py', Path(__file__).resolve()]:
    ast.parse(path.read_text(), filename=str(path))
results = []
for index, argv in enumerate(commands):
    start = datetime.now(timezone.utc).isoformat()
    clock = time.monotonic()
    result = subprocess.run(argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=45,
                            env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
    end = datetime.now(timezone.utc).isoformat()
    log = OUT / f'local-{index + 1}.log'
    save(log, result.stdout)
    counts = None
    output = result.stdout.decode(errors='replace')
    if index == 0:
        counts = {key: int(re.search(r'^# ' + label + r' (\d+)$', output, re.M).group(1))
                  for key, label in [('pass', 'pass'), ('fail', 'fail'), ('skip', 'skipped')]}
    elif index in (1, 2):
        match = re.search(r'Ran (\d+) tests', output)
        if match and result.returncode == 0:
            counts = {'pass': int(match.group(1)), 'fail': 0, 'skip': 0}
    results.append({'evidence_id': f'crs-task21-local-{index + 1}', 'task_id': 'Task21',
                    'packet_id': 'crs-recovery', 'snapshot_manifest_sha256': manifest_sha,
                    'environment_id': platform.platform(), 'tool_version': text_command(['node', '--version']) if argv[0] == 'node' else platform.python_version() if argv[0] == sys.executable else text_command(['git', '--version']),
                    'exact_argv': argv, 'test_scope': 'LOCAL_SYNTHETIC_NO_DATABASE',
                    'started_at': start, 'ended_at': end, 'duration_ms': round((time.monotonic() - clock) * 1000),
                    'exit_code': result.returncode, 'counts': counts, 'log_path': str(log), 'log_sha256': sha(result.stdout),
                    'source_owner': 'edu1_bot', 'independent_verifier': 'NOT_RUN',
                    'characterization_flag': False, 'security_outcome': 'NOT_PROVEN', 'acceptance_stage': 'SYNTHETIC'})
    print(json.dumps({'argv': argv, 'exit_code': result.returncode, 'counts': counts}))
final = hashes()
scratch = [p.name for p in HERE.glob('scratch-*')]
report = {'git_head': text_command(['git', 'rev-parse', 'HEAD']), 'changed_paths_and_sha256': initial,
          'snapshot_manifest_sha256': manifest_sha, 'snapshot_unchanged_during_run': initial == final,
          'results': results, 'python_ast': 'PASS',
          'cleanup_result': {'test_scratch_remaining': scratch, 'docker': 'NOT_STARTED'},
          'not_run': ['Vitest', 'tsc', 'lint', 'build', 'Docker', 'PG_restore', 'HTTP', 'production_delta'],
          'Task21': '0/4'}
save(OUT / 'local-evidence.json', json.dumps(report, indent=2, ensure_ascii=False).encode() + b'\n')
if initial != final or scratch or any(row['exit_code'] for row in results):
    raise SystemExit(1)
print('Local evidence saved; PG NOT_RUN; Task21 0/4.')
