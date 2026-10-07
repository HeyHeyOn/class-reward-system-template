"""Bounded prerequisite reproduction, never an application acceptance test.

Run once from the approved host context. No retry, namespace-entry sidecar,
policy change, browser/server launch, credential read or external connection.
The inner payload is /usr/bin/true: failure precedes Chrome/Next startup.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent
CLEAN = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
INSIDE = {**CLEAN, "HOME": "/scratch", "PWD": "/scratch"}


def sandbox(payload, *, inner=False):
    argv = ["/usr/bin/bwrap", "--unshare-user", "--unshare-pid", "--unshare-ipc",
            "--unshare-uts", "--die-with-parent", "--new-session"]
    if not inner:
        argv += ["--unshare-net"]
    argv += ["--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
             "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
             "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/scratch",
             "--clearenv"]
    if not inner:
        argv += ["--ro-bind", str(Path(__file__).resolve()), "/probe.py"]
    for key, value in INSIDE.items():
        argv += ["--setenv", key, value]
    return argv + ["--chdir", "/scratch", "--", *payload]


def capture(argv, env, timeout=15):
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    clock = time.monotonic_ns()
    proc = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            start_new_session=True, close_fds=True)
    timed_out = False
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(proc.pid, signal.SIGKILL)
        stdout, stderr = proc.communicate(timeout=5)
    return {"exact_argv": argv, "started_at": started,
            "ended_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "duration_ms": (time.monotonic_ns() - clock) // 1_000_000,
            "exit_code": proc.returncode, "timed_out": timed_out,
            "stdout": stdout.decode(errors="replace"),
            "stderr": stderr.decode(errors="replace"), "pid": proc.pid,
            "cleanup_result": "owned process reaped; --die-with-parent namespaces"}


def inside():
    assert dict(os.environ) == INSIDE, "unexpected environment"
    assert [name for _, name in socket.if_nameindex()] == ["lo"]
    routes4 = Path("/proc/net/route").read_text()
    routes6 = Path("/proc/net/ipv6_route").read_text()
    assert len(routes4.splitlines()) == 1, "IPv4 route present"
    for line in routes6.splitlines():
        row = line.split()
        assert row[-1] == "lo" and row[0] in ("0" * 32, "0" * 31 + "1")
        if row[0] == "0" * 32:
            assert int(row[8], 16) & 0x200, "usable IPv6 default route"
    absent = ["/home", "/root", "/run", "/var/run", "/repo", "/etc/resolv.conf"]
    assert not any(Path(path).exists() for path in absent), "host resource visible"
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        bound_port = listener.getsockname()[1]
    boundary = {"uid": os.getuid(), "environment_names": sorted(os.environ),
                "net_namespace": os.readlink("/proc/self/ns/net"),
                "label": Path("/proc/self/attr/current").read_text().strip(),
                "ipv4_routes": routes4, "ipv6_routes": routes6,
                "absent_paths": absent, "reserved_then_closed_port": bound_port}
    # One reproduction only, with no application/browser payload or listener.
    result = capture(sandbox(["/usr/bin/true"], inner=True), INSIDE)
    print(json.dumps({"boundary": boundary, "nested_probe": result}), flush=True)
    return result["exit_code"] if result["exit_code"] >= 0 else 1


def main():
    os.umask(0o077)
    run = ROOT / "evidence" / ("probe-" + uuid.uuid4().hex)
    run.mkdir(parents=True, exist_ok=False)
    result = capture(sandbox(["/usr/bin/python3", "-I", "-B", "/probe.py", "inside"]), CLEAN, 25)
    for stream in ("stdout", "stderr"):
        (run / (stream + ".log")).write_text(result[stream])
    result.update({"evidence_id": run.name, "task_id": "Task20", "packet_id": "P1",
                   "environment_id": "fresh-unprivileged-bwrap-admission-probe",
                   "source_owner": "default", "independent_verifier": None,
                   "test_scope": "namespace prerequisite only",
                   "characterization_flag": True, "security_outcome": "NOT_PROVEN",
                   "acceptance_stage": None, "counts": {"pass": 0, "fail": 0, "skip": 0},
                   "http": "NOT_RUN", "browser": "NOT_RUN", "pg": "NOT_RUN",
                   "task20_acceptance": "0/6", "external_connect_attempts": 0,
                   "probe_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                   "log_path": str(run),
                   "log_sha256": {s: hashlib.sha256((run / (s + ".log")).read_bytes()).hexdigest()
                                  for s in ("stdout", "stderr")}})
    (run / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"result": str(run / "result.json"), "outer_exit_code": result["exit_code"],
                      "stdout": result["stdout"], "stderr": result["stderr"]}, indent=2))
    # Even successful namespace admission does not authorize application startup.
    return result["exit_code"] if result["exit_code"] > 0 else (1 if result["exit_code"] < 0 else 0)


if __name__ == "__main__":
    if sys.argv[1:] == ["inside"]:
        raise SystemExit(inside())
    if sys.argv[1:]:
        raise SystemExit("Unexpected arguments")
    raise SystemExit(main())
