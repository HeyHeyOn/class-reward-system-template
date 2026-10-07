#!/usr/bin/env python3
"""A08 bounded, credential-free, offline frozen-source execution. No full suites."""
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
OUT = Path('/tmp/crs-a08-validation')
DISPATCH = BASE / 'dispatches/pilot-a08-completion-provenance-20260929'
MANIFEST = BASE / 'pilot-transition-20260929/LATEST-TEST-SOURCE-CAPTURE.json'
A07 = BASE / 'dispatches/pilot-a07-adjustment-provenance-20260929/A-07-result.json'
RUNNER = DISPATCH / 'evidence/runner/secondbot-stage-runner-v2.py'
RUNNER_SHA = '9ec7620767fb1e588903689e5e42fadbabc81ab4458a43c999349965cb1ed71c'
FILES = ['src/server/migration/schema4CompletionHistory.ts', 'src/server/migration/schema4CompletionHistory.test.ts',
         'test-support/schema4CompletionHistory.fixture.ts', 'test-support/schema4CompletionHistory.private.test.ts']
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def guard():
    free = {s: shutil.disk_usage(s).free for s in ['/', '/tmp']}
    if min(free.values()) < 2*1024**3: raise RuntimeError('A08_DISK_INADEQUATE_STOP')
    return free

def main():
    os.umask(0o077)
    phase, label = sys.argv[1:3]
    commands = {
        'red': ['node','node_modules/vitest/vitest.mjs','run',FILES[1],'--maxWorkers=1','--no-file-parallelism'],
        'contract': ['node','node_modules/vitest/vitest.mjs','run',FILES[1],'--maxWorkers=1','--no-file-parallelism'],
        'private': ['node','node_modules/vitest/vitest.mjs','run',FILES[3],'--maxWorkers=1','--no-file-parallelism'],
        'impact': ['node','node_modules/vitest/vitest.mjs','run',
                   'src/app/api/tasks/assignments/batch/route.test.ts',
                   'src/app/api/tasks/[taskId]/assignments/route.test.ts',
                   'src/server/repositories/sheets/taskAssignmentCommands.test.ts',
                   '-t', 'authorizes before parsing|sends completion desired state|returns the optional physical assignment source|mixed two-task four-student|canonical no-op|multi-row completion batch response loss|resets completion',
                   '--maxWorkers=1','--no-file-parallelism'],
        'types': ['node','node_modules/typescript/bin/tsc','-p','tsconfig.a08.json','--noEmit','--incremental','false'],
        'lint': ['node','node_modules/eslint/bin/eslint.js',*FILES,'--max-warnings=0'],
    }
    command = commands[phase]
    disk = guard()
    intake = json.loads((DISPATCH/'A-08-intake.json').read_bytes())
    pinned = {Path(path): digest for path, digest in intake['inputPins'].items()}
    assert all(sha(p)==v for p,v in pinned.items())
    if not RUNNER.exists():
        shared=BASE/'secondbot-stage-runner-v2.py'
        assert sha(shared)==RUNNER_SHA
        shutil.copyfile(shared,RUNNER)
    assert sha(RUNNER)==RUNNER_SHA
    spec=importlib.util.spec_from_file_location('runner',RUNNER)
    assert spec is not None and spec.loader is not None
    runner: Any=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.OUT=OUT
    OUT.mkdir(exist_ok=True,mode=0o700)
    os.environ['SECOND_STAGE_TIMEOUT_SECONDS']='180'
    size=sum((ROOT/n).stat().st_size for n in runner.inputs())
    if size>96*1024**2: raise RuntimeError('A08_SOURCE_COPY_BUDGET_STOP')
    runner.valid_component(label)
    target=OUT/label
    with contextlib.redirect_stdout(io.StringIO()):
        if not target.exists():
            runner.freeze(label)
            (target/'fixture/tsconfig.a08.json').write_text(json.dumps({'extends':'./tsconfig.json',
                'compilerOptions':{'incremental':False},'include':FILES,'exclude':['node_modules']}))
    manifest=json.loads(MANIFEST.read_bytes())
    if phase=='private':
        build=runner.build_argv
        def private_argv(fixture,cmd,pg=False):
            assert not pg
            argv=build(fixture,cmd,pg=False)
            i=argv.index('--chdir')
            argv[i:i]=['--ro-bind',str(MANIFEST),'/private/manifest.json',
                       '--ro-bind',str(Path(manifest['captureDirectory'])/'sheets-grid-1.json'),'/private/grid.json',
                       '--ro-bind',str(A07),'/private/a07.json','--setenv','A08_PRIVATE','1']
            return argv
        runner.build_argv=private_argv
    frozen=json.loads((target/'snapshot.json').read_bytes())
    assert all(sha(ROOT/n)==v for n,v in frozen['files'].items())
    preflight={'runner':str(RUNNER),'runnerSha256':sha(RUNNER),'driver':str(Path(__file__).resolve()),'driverSha256':sha(Path(__file__)),
               'phase':phase,'label':label,'argv':command,'snapshotSha256':sha(target/'snapshot.json'),'diskBefore':disk}
    pre=DISPATCH/(label+'-'+phase+'-pre-execution.json')
    assert not pre.exists()
    pre.write_text(json.dumps(preflight,indent=2)+'\n')
    resource.setrlimit(resource.RLIMIT_FSIZE,(8*1024**2,8*1024**2))
    with contextlib.redirect_stdout(io.StringIO()): code=runner.run(label,phase,command)
    assert sha(RUNNER)==RUNNER_SHA and all(sha(p)==v for p,v in pinned.items())
    assert all(sha(ROOT/n)==v for n,v in frozen['files'].items())
    receipt=target/(phase+'.json'); data=json.loads(receipt.read_bytes())
    result={'receipt':str(receipt),'receiptSha256':sha(receipt),'status':data['status'],'counts':data['counts'],
            'exitCode':code,'sourceDrift':data['source_drift'],'diskAfter':guard(),'sourceCopyBytes':size}
    dest=DISPATCH/(label+'-'+phase+'-summary.json'); assert not dest.exists()
    dest.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result)); return code
if __name__=='__main__': raise SystemExit(main())
