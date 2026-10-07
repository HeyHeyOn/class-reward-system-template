#!/usr/bin/env python3
"""A07 bounded offline validation: no network, credentials, remote writers or full suites."""
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
OUT = Path('/tmp/crs-a07-validation')
DISPATCH = BASE / 'dispatches/pilot-a07-adjustment-provenance-20260929'
MANIFEST = BASE / 'pilot-transition-20260929/LATEST-TEST-SOURCE-CAPTURE.json'
EXPECTED = 'a3317f315c60124f77af6a42813bdc012700debc9fc715ea8e20a0865df93961'
A06 = BASE / 'dispatches/pilot-a06-cancellation-provenance-recovery-20260929/A-06-R1-result.json'
A06_SHA = 'd74802a8862cd5a2755518548c837b700f1acff8b8715975f4bee8262a918f25'
FILES = ['src/server/migration/schema4AdjustmentHistory.ts', 'src/server/migration/schema4AdjustmentHistory.test.ts',
         'test-support/schema4AdjustmentHistory.fixture.ts', 'test-support/schema4AdjustmentHistory.private.test.ts']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def disk_guard():
    free = {name: shutil.disk_usage(name).free for name in ['/', '/tmp']}
    if any(value < 2 * 1024**3 for value in free.values()):
        raise RuntimeError('A07_DISK_INADEQUATE_STOP')
    return free


def main():
    os.umask(0o077)
    phase = sys.argv[1]
    commands = {
        'red': ['node', 'node_modules/vitest/vitest.mjs', 'run', FILES[1], '--maxWorkers=1', '--no-file-parallelism'],
        'contract': ['node', 'node_modules/vitest/vitest.mjs', 'run', FILES[1], '--maxWorkers=1', '--no-file-parallelism'],
        'regression': ['node', 'node_modules/vitest/vitest.mjs', 'run', FILES[1], '-t', 'preserves a changed display-name snapshot', '--maxWorkers=1', '--no-file-parallelism'],
        'private': ['node', 'node_modules/vitest/vitest.mjs', 'run', FILES[3], '--maxWorkers=1', '--no-file-parallelism'],
        'impact': ['node', 'node_modules/vitest/vitest.mjs', 'run',
                   'src/server/repositories/configuredAdminAdjustment.test.ts', 'src/server/sheetsRepository.test.ts',
                   '-t', '^configured administrator balance adjustment composition root|canonicalizes student order, captures one timestamp|replays an exact operation with exact prior balances|rejects replay conflict:|rejects raw malformed operation residue',
                   '--maxWorkers=1', '--no-file-parallelism'],
        'types': ['node', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.a07.json', '--noEmit', '--incremental', 'false'],
        'lint': ['node', 'node_modules/eslint/bin/eslint.js', *FILES, '--max-warnings=0'],
    }
    command = commands[phase]
    disk_before = disk_guard()
    assert sha(MANIFEST) == EXPECTED and sha(A06) == A06_SHA
    manifest = json.loads(MANIFEST.read_bytes())
    capture = Path(manifest['captureDirectory'])
    assert len(manifest['gridReadHashes']) == 2 and len(set(manifest['gridReadHashes'])) == 1
    pinned = {MANIFEST: EXPECTED, A06: A06_SHA}
    for name, expected in zip(['sheets-grid-1.json', 'sheets-grid-2.json'], manifest['gridReadHashes'], strict=True):
        path = capture / name
        assert sha(path) == expected
        pinned[path] = expected
    spec = importlib.util.spec_from_file_location('runner', BASE / 'secondbot-stage-runner-v2.py')
    assert spec is not None and spec.loader is not None
    runner: Any = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.OUT = OUT
    OUT.mkdir(exist_ok=True, mode=0o700)
    os.environ['SECOND_STAGE_TIMEOUT_SECONDS'] = '180'
    size = sum((ROOT / name).stat().st_size for name in runner.inputs())
    if size > 96 * 1024**2:
        raise RuntimeError('A07_SOURCE_COPY_BUDGET_STOP')
    label = sys.argv[2] if len(sys.argv) > 2 else ('red' if phase == 'red' else 'green')
    if label not in ['red', 'green', 'regression-red', 'final']:
        raise RuntimeError('A07_UNKNOWN_SNAPSHOT')
    target = OUT / label
    with contextlib.redirect_stdout(io.StringIO()):
        if not target.exists():
            runner.freeze(label)
            (target / 'fixture/tsconfig.a07.json').write_text(json.dumps({
                'extends': './tsconfig.json', 'compilerOptions': {'incremental': False},
                'include': FILES, 'exclude': ['node_modules']}))
    if phase == 'private':
        build_argv = runner.build_argv
        def private_argv(fixture, cmd, pg=False):
            assert not pg
            argv = build_argv(fixture, cmd, pg=False)
            insert = argv.index('--chdir')
            argv[insert:insert] = ['--ro-bind', str(MANIFEST), '/private/manifest.json',
                                  '--ro-bind', str(capture / 'sheets-grid-1.json'), '/private/grid.json',
                                  '--ro-bind', str(A06), '/private/a06.json', '--setenv', 'A07_PRIVATE', '1']
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
    summary = {'receipt': str(receipt), 'receiptSha256': sha(receipt),
               'status': data['status'], 'counts': data['counts'], 'exitCode': code,
               'sourceDrift': data['source_drift'], 'diskBefore': disk_before,
               'diskAfter': disk_guard(), 'sourceCopyBytes': size}
    destination = DISPATCH / (label + '-' + phase + '-summary.json')
    assert not destination.exists()
    destination.write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
