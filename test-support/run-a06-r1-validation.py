#!/usr/bin/env python3
"""A06-R1 only: one frozen tree, no network/credentials; bounded local receipts."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import resource
import shutil
import sys
from typing import Any

BASE = Path('/home/haeon/workhub-tasks/live/class-store-supervision')
ROOT = Path('/home/haeon/workspace/projects/class-store')
OUT = Path('/tmp/crs-a06-r1-validation')
MANIFEST = BASE / 'pilot-transition-20260929/LATEST-TEST-SOURCE-CAPTURE.json'
EXPECTED = 'a3317f315c60124f77af6a42813bdc012700debc9fc715ea8e20a0865df93961'
A05 = BASE / 'dispatches/pilot-a05-admin-history-bridge-20260929/A-05-result.json'
FILES = ['src/server/migration/schema4CancellationHistory.ts',
         'src/server/migration/schema4CancellationHistory.test.ts',
         'test-support/schema4CancellationHistory.fixture.ts',
         'test-support/schema4CancellationHistory.private.test.ts']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def disk_guard():
    free = {name: shutil.disk_usage(name).free for name in ['/', '/tmp']}
    if free['/'] < 128 * 1024**2 or free['/tmp'] < 512 * 1024**2:
        raise RuntimeError('A06_R1_DISK_INADEQUATE_STOP')
    return free


def main():
    os.umask(0o077)
    phase = sys.argv[1]
    commands = {
        'contract': ['node', 'node_modules/vitest/vitest.mjs', 'run', FILES[1], '--maxWorkers=1', '--no-file-parallelism'],
        'private': ['node', 'node_modules/vitest/vitest.mjs', 'run', FILES[3], '--maxWorkers=1', '--no-file-parallelism'],
        'impact': ['node', 'node_modules/vitest/vitest.mjs', 'run',
                   'src/server/repositories/configuredTransactionCancellation.test.ts',
                   'src/server/migration/normalize.transaction.cancellation.budget.test.ts',
                   '-t', '^configured transaction cancellation composition root|^frozen Git cancellation semantics accepted budget=',
                   '--maxWorkers=1', '--no-file-parallelism'],
        'types': ['node', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.a06-r1.json', '--noEmit', '--incremental', 'false'],
        'lint': ['node', 'node_modules/eslint/bin/eslint.js', *FILES, '--max-warnings=0'],
    }
    command = commands[phase]
    disk_before = disk_guard()
    assert sha(MANIFEST) == EXPECTED
    manifest = json.loads(MANIFEST.read_bytes())
    capture = Path(manifest['captureDirectory'])
    assert len(manifest['gridReadHashes']) == 2 and len(set(manifest['gridReadHashes'])) == 1
    pinned = {MANIFEST: EXPECTED, A05: sha(A05)}
    for name, expected in zip(['sheets-grid-1.json', 'sheets-grid-2.json'], manifest['gridReadHashes'], strict=True):
        p = capture / name
        assert sha(p) == expected
        pinned[p] = expected
    spec = importlib.util.spec_from_file_location('runner', BASE / 'secondbot-stage-runner-v2.py')
    assert spec is not None and spec.loader is not None
    runner: Any = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.OUT = OUT
    OUT.mkdir(exist_ok=True, mode=0o700)
    os.environ['SECOND_STAGE_TIMEOUT_SECONDS'] = '180'
    source_files = runner.inputs()
    size = sum((ROOT / name).stat().st_size for name in source_files)
    if size > 96 * 1024**2:
        raise RuntimeError('A06_R1_SOURCE_COPY_BUDGET_STOP')
    label = 'focused'
    target = OUT / label
    with contextlib.redirect_stdout(io.StringIO()):
        if not target.exists():
            runner.freeze(label)
            config = {'extends': './tsconfig.json', 'compilerOptions': {'incremental': False},
                      'include': FILES, 'exclude': ['node_modules']}
            (target / 'fixture/tsconfig.a06-r1.json').write_text(json.dumps(config))
    # Serialize this one packet with runner's lock; never overwrite a prior receipt.
    if phase == 'private':
        build_argv = runner.build_argv
        def private_argv(fixture, cmd, pg=False):
            assert not pg
            argv = build_argv(fixture, cmd, pg=False)
            insert = argv.index('--chdir')
            argv[insert:insert] = ['--ro-bind', str(MANIFEST), '/private/manifest.json',
                                  '--ro-bind', str(capture / 'sheets-grid-1.json'), '/private/grid.json',
                                  '--ro-bind', str(A05), '/private/a05.json', '--setenv', 'A06_PRIVATE', '1']
            return argv
        runner.build_argv = private_argv
    frozen = json.loads((target / 'snapshot.json').read_bytes())
    assert all(sha(ROOT / name) == expected for name, expected in frozen['files'].items())
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024**2, 8 * 1024**2))
    with contextlib.redirect_stdout(io.StringIO()):
        code = runner.run(label, phase, command)
    assert all(sha(path) == expected for path, expected in pinned.items())
    assert all(sha(ROOT / name) == expected for name, expected in frozen['files'].items())
    receipt = target / (phase + '.json')
    data = json.loads(receipt.read_bytes())
    print(json.dumps({'receipt': str(receipt), 'receiptSha256': sha(receipt),
                      'status': data['status'], 'counts': data['counts'], 'exitCode': code,
                      'sourceDrift': data['source_drift'], 'diskBefore': disk_before,
                      'diskAfter': disk_guard(), 'sourceCopyBytes': size}))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
