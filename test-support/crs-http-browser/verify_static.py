"""Credential-free static checks only; no shared test/build/app execution."""
import ast
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
TEST = 'src/app/c/[slug]/admin/migrations/history/download.acceptance.test.tsx'
REFERENCE = {
    'src/app/c/[slug]/admin/migrations/history/download.browser-boundary.test.tsx': 'd68a560a143385c9b6a98c34e6f5776e79e9154d7497069f2f6a29fb78df76e6',
    'src/app/c/[slug]/admin/migrations/history/page.tsx': 'ea7f49a2a8a3b564a76894f52673b9e53cab9a2d3ec888529bd46813c42c3a1e',
    'src/app/api/migrations/status/[slug]/preflight/download/route.ts': 'ed811d433d12262f49a63efdb055e90fb47f3b51722ee8c0ef925afa0ef4f60c',
    'src/app/api/migrations/status/readPreflightReport.ts': '330a7c7f104dc1ade7c7814d6fca0c7c711942703f937981a553df71837d0acf',
    'src/app/api/migrations/status/readHistoricalReportDownload.ts': 'f4dc0735be5db0e1ac06cb1e4031f2acecd9f36d0bf5f6f354634af8cd2a1a99',
}
CLEAN = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/nonexistent'}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    os.umask(0o077)
    run = HERE / 'evidence' / ('static-' + uuid.uuid4().hex)
    run.mkdir(parents=True, exist_ok=False)
    commands = []

    def invoke(label, argv):
        start = datetime.datetime.now(datetime.timezone.utc).isoformat()
        clock = time.monotonic_ns()
        completed = subprocess.run(argv, cwd=REPO, env=CLEAN, stdin=subprocess.DEVNULL,
                                   capture_output=True, timeout=30)
        log = run / (label + '.log')
        log.write_bytes(completed.stdout + b'\nSTDERR:\n' + completed.stderr)
        commands.append({'label': label, 'exact_argv': argv, 'started_at': start,
                         'ended_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                         'duration_ms': (time.monotonic_ns() - clock) // 1_000_000,
                         'exit_code': completed.returncode, 'log_path': str(log),
                         'log_sha256': sha(log), 'counts': {'pass': 0, 'fail': 0, 'skip': 0}})
        return completed

    changed = sorted([str(path.relative_to(REPO)) for path in HERE.iterdir() if path.is_file()] + [TEST])
    originals = sorted(set(REFERENCE) | set(re.findall(r"'(src/[^']+)'", (HERE / 'boundary.ts').read_text())) |
                       {'package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'vitest.config.mts', 'AGENTS.md'})
    before = {path: sha(REPO / path) for path in originals}
    for name in ('probe.py', 'verify_static.py'):
        ast.parse((HERE / name).read_text(), filename=name)
    for path in changed:
        text = (REPO / path).read_text()
        assert text.endswith('\n') and not any(line.rstrip() != line for line in text.splitlines()), path
    reference_match = {path: before[path] == expected for path, expected in REFERENCE.items()}
    assert all(reference_match.values()), 'Inspected route/reader/marker differs from prior audited snapshot; STOP'
    marker = (REPO / next(iter(REFERENCE))).read_text()
    assert 'skip(' in marker and 'RUN_TASK20_BROWSER_BOUNDARY' in marker
    node = shutil.which('node')
    assert node is not None
    node_version = invoke('node-version', [node, '--version'])
    bwrap_version = invoke('bwrap-version', ['/usr/bin/bwrap', '--version'])
    syntax = invoke('syntax', [node, str(HERE / 'check-syntax.mjs')])
    diff = invoke('diff-check', ['/usr/bin/git', 'diff', '--check', '--', 'test-support/crs-http-browser', TEST])
    head = invoke('head', ['/usr/bin/git', 'rev-parse', 'HEAD'])
    after = {path: sha(REPO / path) for path in originals}
    assert before == after, 'Read-only inputs changed during static inspection; not a fixed snapshot'
    manifest = {'full_integrated_snapshot': False,
                'changed_paths_and_sha256': {path: sha(REPO / path) for path in changed},
                'read_only_inputs_sha256': after}
    manifest_path = run / 'snapshot.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    result = {'evidence_id': run.name, 'task_id': 'Task20', 'packet_id': 'P1',
              'snapshot_manifest_sha256': sha(manifest_path), 'git_head': head.stdout.decode().strip(),
              'environment_id': 'host-clean-env-syntax-only-no-application-execution',
              'tool_version': {'node': node_version.stdout.decode().strip(),
                               'bwrap': bwrap_version.stdout.decode().strip(),
                               'next': json.loads((REPO / 'node_modules/next/package.json').read_text())['version']},
              'source_owner': 'default', 'independent_verifier': None,
              'characterization_flag': False, 'security_outcome': 'NOT_PROVEN',
              'acceptance_stage': None, 'test_scope': 'syntax/hash/whitespace only',
              'python_ast': 'parsed, no bytecode emitted', 'read_only_reference_match': reference_match,
              'checks': commands, 'http': 'NOT_RUN', 'browser': 'NOT_RUN', 'pg': 'NOT_RUN',
              'vitest': 'NOT_RUN', 'tsc': 'NOT_RUN', 'lint': 'NOT_RUN', 'build': 'NOT_RUN', 'docker': 'NOT_RUN',
              'task20_acceptance': '0/6', 'cleanup_result': 'short-lived parser/git processes exited; no services started'}
    (run / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'result': str(run / 'result.json'), 'syntax_stdout': syntax.stdout.decode(),
                      'exit_codes': {item['label']: item['exit_code'] for item in commands},
                      'reference_match': reference_match, 'changed_file_count': len(changed)}, indent=2))
    return 0 if all(item['exit_code'] == 0 for item in commands) else 1


if __name__ == '__main__':
    raise SystemExit(main())
