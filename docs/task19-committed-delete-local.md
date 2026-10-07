# Task19 committed synthetic DELETE and capture-order refusal

> **과거 실험 기록:** Task1–24 계획에 속한 당시의 합성 검증·복구 실험이다. 현행 A–F의 실행 순서나 현재 운영 완료율을 나타내지 않는다. 현재 상태는 [README](../README.md)를 따른다.

NONOPERATIONAL only. No operational DB, Sheets, Redis, credentials, real student data, writer fence, activation, deployment, account changes, commit or push.

## Current-source characterization and functional change

A fresh owned native PostgreSQL source stores synthetic workbook rows keyed by tenant/tab/ordinal. The existing reader contract captures those actual SQL rows. After initial candidate capture/staging, an explicit transaction DELETEs the unreferenced Products PX row, inserts a local tombstone log, increments that tenant's checkpoint and commits. P1 remains byte-identical; another tenant's PX remains. The immutable original importer mirror is not edited.

Current code already carries this committed deletion into a REMOVED entry with exact before-image/provenance, excludes PX from the final candidate, and restores only P1 in a separately launched process after all original source/destination containers are removed. This is characterization, not a new operational propagation feature.

Executable RED also showed that the local pipeline accepted the same deletion when the candidate's validated capturedAt was earlier than the original capturedAt. The minimal implementation adds a removal-specific chronology refusal in inspectLocalPointerPreparationEnvelopes. Its existing callers include local stage, candidate readback/retry and both retained provenance verifiers. Rejection occurs inside the existing transaction and rolls back audit/candidate appends. Existing stale retained envelopes are refused, not rewritten. Direct legacy preparation remains untrusted and unchanged.

Equal instants remain admitted: timestamps have finite precision and are not commit sequences. This is only a necessary local consistency check. Caller timestamps and opaque sourceRevision values do NOT prove live freshness, commit order, writer exclusion, authenticity against a fully resealed malicious acquisition, or operational deletion permission. An older valid pre-delete generation can still be selected explicitly: no latest-generation authority is minted. No deletion is applied to the original importer mirror or inherited destination rows.

## New executable coverage

- Committed DELETE after initial capture: exact local rows, tenant checkpoints, sequence, transaction log, source capture digests, REMOVED before/after, source original PX, final P1 and separately reopened restore P1.
- Equal-time unchanged initial control and later valid removal; final candidate retry is byte/xmin/ctid unchanged.
- Earlier deletion capture: atomic refusal; independently read stored untrusted envelopes also refused; retry cannot repair/adopt them.
- Rolled-back source deletion: no row/checkpoint/log changes, with the deliberately nontransactional sequence witness retained.
- Foreign source/tenant, forged capture bytes, stale job version, tampered tombstone; same/other-tenant inherited PX destination sentinel rows remain untouched.
- Actual candidate INSERT followed by precommit interruption rolls back all rows/receipt. Injected application acknowledgement loss after a real commit is not called rollback; exact retry is read-only, wrong live bytes/resurrected PX are refused without repair.
- Cold restoration with injected postcommit acknowledgement loss is QUARANTINED and no-dispatch retry is refused. This is not a real wire disconnect, SIGKILL, host-loss or power-failure test.

Tests: src/server/migration/localCommittedDelete.postgres.test.ts and new test-support/task19DeleteFixture.ts. Existing fixture/evidence files are not rewritten. New immutable receipts and SQL witnesses reside under the runner's unique task19-delete-* freezes. Initial cold-test harness failures (missing disposable-only restore SELECT grants, then an incomplete expected Products column set) are retained separately from the clean RED receipt.

Use secondbot-stage-runner-v2.py run-pg (not `test`) with the required localFullGenerationStage.test.ts command prefix; default+JSON reports and 30s runner heartbeats are automatic. All stages sharing a fixture are serial. Final snapshot/source hashes, exact exits, bounded intake diff and cleanup are recorded in the dispatch FINAL-HANDOFF.md and final-manifest.json.

Full browser, whole Vitest including historical exit130, real-data compatibility, independent reviewer and Task19–24 acceptance remain separate gates. Scoped passes are not whole-suite acceptance. Gateways are not implementation workers and are never stopped or made intake prerequisites.
