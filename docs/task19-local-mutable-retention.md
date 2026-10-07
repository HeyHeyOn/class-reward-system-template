# Task19 local synthetic mutable provenance retention

> **과거 실험 기록:** Task1–24 계획에 속한 당시의 합성 검증·복구 실험이다. 현행 A–F의 실행 순서나 현재 운영 완료율을 나타내지 않는다. 현재 상태는 [README](../README.md)를 따른다.

This opt-in capability is not a production backup, restore, cutover, or authority path. It accepts only the mixed Products ADDED/MUTATED/REMOVED snapshot, while retaining and checking the complete original/candidate capture graph and mandatory category coverage. It does not extend Task20 or Task21.

## Owned capture and artifact

`retainOwnedMutableProvenance(source, sourceOwnerId, binding, parent)` requires the existing disposable PostgreSQL harness and `RUN_REAL_POSTGRES=1`. It verifies the actual owned, networkless, no-volume PG container, exact SOURCE marker, tenant IMPORTING lifecycle, and the persisted READY candidate. It reads under a locked repeatable-read transaction. The caller keeps the exclusive synthetic lease; no default URL or external credentials are used.

The binding includes tenant, migration job, state version, full mutable generation ID, source fingerprint and manifest digest. The artifact retains all three preparation envelopes (including both synthetic acquisitions and manifests), the exact full-stage sources/targets/mappings/contributors, before/after delta images and removal tombstones, empty recapture evidence, exact reconciliation rows and the full mandatory normalized-category coverage report. Missing stored evidence is refused rather than repaired.

The owned artifact is a separate private local directory with a distinct logical owner and artifact UUID. `artifact.json` is created exclusively, file-fsynced, then the directory and parent are fsynced. A pin containing its directory inode/device, IDs and SHA-256 is returned only after readback. The caller must preserve this trusted pin separately from the artifact; accepting a digest supplied by the artifact itself is not verification.

## Cold verification

`readOwnedMutableRetention(pin, expectedBinding)` reads only that pinned file. It rejects missing files, unexpected ownership/modes/inode, symlinks, digest substitution, different identity or binding, omitted evidence, altered images and coverage, and authority promotion. The retained acquisitions are independently re-normalized to validate their envelopes and graph. Recalculation is verification only: no missing retained rows are manufactured, and no original database is queried or reconstructed.

The return remains `NONAUTHORITY`, `activationAllowed=false`, `complete=false`, `exclusion=NOT_PROVEN`. It does not insert/restore domain data or publish anything.

## Persistence boundary

The fsynced local file survives the source connection closing, deletion of the disposable source/destination PG containers and their tmpfs, and application/verification-process exit while that local filesystem and the separate pin remain. Tests place the archive in the runner fixture's host-backed directory (not the PG tmpfs) and preserve it with the test receipts.

This does not certify power-loss, host/disk/filesystem failure, container failure of an artifact stored inside that container, off-host replication, independent administrative ownership, same-UID malicious writers, signed provenance, or disaster recovery. The directory/pin is a trusted same-OS-user exclusive lease; an owner able to rewrite both is outside the threat model. A partial failed publication has no valid returned pin and is not an accepted artifact. Destruction of the local fixture loses the artifact.

## Failed attempt lifecycle (trusted pin boundary)

Capture must succeed before a new directory is created. File write/sync/close, directory and parent sync, semantic readback, and handle closure must all succeed before the promise returns a pin. Same-source attempts in the process are serialized; a failed attempt releases that lease so a fresh attempt may proceed. The caller still owns the cross-process exclusive lease.

A failed or cancelled write may leave an empty, truncated, or even complete-looking private JSON file. These leftovers are preserved, not promoted or automatically rediscovered. There is no archive cleanup scanner and no recovery API that derives a pin from these bytes. A file's existence is not successful publication: only the separately retained pin returned by a successful call is accepted infrastructure input. Do not fabricate a pin for an orphan, reuse another archive's pin, or describe its digest as signed provenance. This deliberately avoids deleting another owner's or a prior attempt's archive.

The acceptance suite exercises real Node AbortSignal cancellation after a written prefix and injected I/O failures; it does not claim SIGKILL, machine-crash, or power-loss recovery. A late failure may leave all bytes on disk but still issues no pin. A fresh successful retry and previously completed pins remain independently readable without either PG source.

## Executable acceptance

- `src/server/migration/localMutableRetention.postgres.test.ts`: mixed snapshot materialization, SQL write tripwires, source and destination removal before fresh child readback; exact image/digest comparison; cold wrong-binding, missing/substituted/modified/omitted evidence negatives; semantic negatives with a recomputed whole-file digest; sealing negatives.
- `test-support/task19RetentionChild.test.ts`: new application PID, only pin plus expected binding, no source capture/connection in the request; default DB and Pool construction tripwires.
- `test-support/task19RetentionReopen.test.ts`: run in a subsequent non-PG runner sandbox after the PG runner exits, using only the persisted external pin. Docker socket is absent and PG opt-in is unset. A skipped reopen test is not acceptance.
- `src/server/migration/localMutableRetention.atomicity.postgres.test.ts`: real disposable capture, partial/cancelled writes, file/directory/parent sync and readback failures, same-source contention/retry, source/tenant/job/generation/version binding negatives, and byte-exact preservation of prior/other-owner archives. This is acceptance of existing behavior, not a manufactured behavioral RED.
- `test-support/task19RetentionAtomicityReopen.test.ts`: subsequent no-PG/no-Docker process verifies all queued positives/negatives, mandatory categories, retained failed artifacts, wrong-physical-source substitution and zero attempted DB connections.

Use `secondbot-stage-runner-v2.py` with one final source freeze, unique run names, serial same-fixture commands, default+JSON reporting and final receipts. `run-pg` requires the existing reviewed `localFullGenerationStage.test.ts` scope alongside the new suite. Preserve the earlier behavioral RED and failed invocation receipts; never treat a launcher rejection, skip, timeout or incomplete JSON report as PASS.
