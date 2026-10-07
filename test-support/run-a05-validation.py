#!/usr/bin/env python3
"""Bounded A-05 validation. Private captures are read-only mounts, never fixtures."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
from typing import Any

BASE = Path('/home/haeon/workhub-tasks/live/class-store-supervision')
MANIFEST = BASE / 'pilot-transition-20260929/LATEST-TEST-SOURCE-CAPTURE.json'
EXPECTED = 'a3317f315c60124f77af6a42813bdc012700debc9fc715ea8e20a0865df93961'
A04 = BASE / 'dispatches/pilot-a04-bank-event-provenance-20260929/A-04-result.json'


def main():
    os.umask(0o077)
    spec = importlib.util.spec_from_file_location('runner', BASE / 'secondbot-stage-runner-v2.py')
    assert spec is not None and spec.loader is not None
    runner: Any = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.OUT = Path('/tmp/crs-a05-validation')
    runner.OUT.mkdir(exist_ok=True, mode=0o700)
    label, phase = sys.argv[1:3]
    commands = {
        'contract': ['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/server/migration/schema4AdminHistoryBridge.test.ts', '--maxWorkers=1'],
        'private': ['node', 'node_modules/vitest/vitest.mjs', 'run', 'test-support/schema4AdminHistory.private.test.ts', '--maxWorkers=1'],
        'impact': ['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/server/migration/schema4BankHistory.test.ts', 'src/server/migration/offlineSheetsImport.test.ts', 'src/server/repositories/database/taskCycleQueries.test.ts', '--maxWorkers=1'],
        'types': ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false'],
        'lint': ['node', 'node_modules/eslint/bin/eslint.js', 'src/server/migration/schema4AdminHistoryBridge.ts', 'src/server/migration/schema4AdminHistoryBridge.test.ts', 'test-support/schema4AdminHistory.fixture.ts', 'test-support/schema4AdminHistory.private.test.ts', '--max-warnings=0'],
    }
    pinned = {MANIFEST: EXPECTED}
    assert hashlib.sha256(MANIFEST.read_bytes()).hexdigest() == EXPECTED
    manifest = json.loads(MANIFEST.read_bytes())
    capture = Path(manifest['captureDirectory'])
    assert len(manifest['gridReadHashes']) == 2 and len(set(manifest['gridReadHashes'])) == 1
    for name, expected in zip(['sheets-grid-1.json', 'sheets-grid-2.json'], manifest['gridReadHashes'], strict=True):
        p = capture / name
        assert hashlib.sha256(p.read_bytes()).hexdigest() == expected
        pinned[p] = expected
    if phase == 'private':
        pinned[A04] = hashlib.sha256(A04.read_bytes()).hexdigest()
        build_argv = runner.build_argv
        def private_argv(fixture, cmd, pg=False):
            assert not pg
            argv = build_argv(fixture, cmd, pg=False)
            insert = argv.index('--chdir')
            argv[insert:insert] = ['--ro-bind', str(MANIFEST), '/private/manifest.json',
                                  '--ro-bind', str(capture / 'sheets-grid-1.json'), '/private/grid.json',
                                  '--ro-bind', str(A04), '/private/a04.json', '--setenv', 'A05_PRIVATE', '1']
            return argv
        runner.build_argv = private_argv
    with contextlib.redirect_stdout(io.StringIO()):
        if not (runner.OUT / label).exists():
            runner.freeze(label)
        code = runner.run(label, phase, commands[phase])
    for p, expected in pinned.items():
        assert hashlib.sha256(p.read_bytes()).hexdigest() == expected
    receipt = runner.OUT / label / (phase + '.json')
    data = json.loads(receipt.read_bytes())
    print(json.dumps({'receipt': str(receipt), 'status': data['status'], 'counts': data['counts'],
                      'sourceDrift': data['source_drift'], 'exitCode': code, 'log': data['log_path']}))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
