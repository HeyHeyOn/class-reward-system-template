# Task21: original-execution binding / fail-closed successor boundary

> **과거 실험 기록:** Task1–24 계획에 속한 당시의 합성 검증·복구 실험이다. 현행 A–F의 실행 순서나 현재 운영 완료율을 나타내지 않는다. 현재 상태는 [README](../README.md)를 따른다.

Scope: approved NONPRODUCTION, controlled source-owned synthetic sealed product export -> fresh owned disposable PostgreSQL. Not a durable successor implementation, automatic suffix resume, operational writer fence, ACTIVE transition, or product acceptance.

## Proved gap and delivered feature

The old sealed-export wrapper retained an original cold lease in process memory. However, the lower-level sealed and unsealed segment replay functions admitted an independently borrowed destination using owner/base/chain/terminal metadata alone. A different application process after original SIGKILL could append another segment without a successor capability. Quarantining the original archive alone did not close this lower-level execution boundary.

New exported restores atomically install an immutable `local_restore_control.sealed_export_execution` record and the same pin inside the installed chain terminal. The pin binds original anchor, attempt, lease digest, export digest, exact owned destination/owner/native system identifier. It is provenance, NOT permission to reconstruct a lease. Installation requires the real process-local ColdLease, exact live worker identity, DISPATCHED inventory, original lock and no recovery gate. The destination handle retains the original capability only in a WeakMap.

Both sealed and unsealed replay entry points validate that original execution capability under the destination transaction lock, before a checkpoint can be accepted as ALREADY_APPLIED or suffix DML can begin. Reinstalling the terminal cannot grant authority to a new process. Copied JSON/leases, borrowed SQL handles and valid checkpoints do not populate this map. Removing just one of the SQL provenance pins fails closed. The existing quarantine and worker lock are never relaxed.

Terminal verification and preparation of exported restores require either the live original (terminal verification only), or explicit durable SUCCEEDED settlement by the original, authenticated original attempt/inventory and released original/recovery locks. Complete SQL after process death is not settlement. Export preparation additionally requires the independently supplied exact export digest and the execution pin; legacy targets lacking it cannot be silently upgraded by that API. Normal successfully settled cold preparation and clean idempotent retries remain supported.

Standalone non-export chain/terminal fixtures retain their existing internal contracts. These trusted internal primitives are not an untrusted archive/HTTP route. A malicious independently authorized database owner/OS UID removing or rewriting all provenance and every independent pin remains outside the established trust boundary. No claim of safety against a SQL superuser is made.

## Why no accepted successor is provided

The original durable archive records have DISPATCHED allocation provenance and SQL has committed checkpoints. Neither is a pre-enrolled, independently retained successor execution grant. The new pin deliberately records original provenance without pretending to be such a grant. Deriving a successor permission from the same candidate target/JSON under examination, reconstructing the in-memory archive lease, resetting READY, or treating a gate as an ownership transfer would violate those contracts.

The precise missing capability is a separately authorized durable successor enrollment plus an atomic reconcile/consume protocol: independently pinned original terminal/chain/coordinator; certified original death and ownership; exact destination rows, sequences, guards, checkpoints and private provenance; successor process/attempt provenance; and an immutable consumption/checkpoint record committed with resumed suffix effects and separately verified preparation. Recovery from the successor's own interrupted commit/publication also needs native SQL reconciliation, not PID absence or a timeout. None of this is inferred or advertised by the original-execution pin.

This packet chooses the explicitly permitted executable fail-closed improvement: prevent metadata-only cold suffix replay and unsettled terminal/preparation acceptance. It issues no accepted recovery receipt. It does not establish that a future pre-enrolled successor design is impossible, only that the existing contracts and original records do not contain that authority.

## Executable evidence

`src/server/exports/syntheticSealedSuccessor.postgres.test.ts` and `test-support/sealedSuccessorChild.test.ts` use real owned PostgreSQL, actual SIGKILL and different application processes:

- Committed segment 1, then original death: new processes cannot append segment 2 through either replay entry, reinstall/verify terminal, prepare, acquire a new archive lease or restart full restore. Quarantine/retries stay nonaccepted.
- Original death during segment 2: inside-transaction rows/checkpoint and native idle-in-transaction are observed before kill; native backend disappearance and fresh SQL prove only committed segment 1 survived. No rollback is inferred from application death alone.
- Successor death at transaction admission: pause after reading the terminal inside its locked SQL transaction, before DML; native activity observed, actual SIGKILL, backend disappearance and exact before/after public/private SQL witnesses; later cold attempts still reject. This is a rejection/admission boundary, NOT a successfully consumed successor transaction.
- All three segments committed, death before original settlement: complete SQL still cannot become an accepted terminal or preparation proof in another process.
- Tampered segment, owner/independent pin mismatch, copied lease, deliberately partial SQL, sequence/RLS/private guard mutation, original coordinator files unavailable, missing private execution pin and retained SQL coordinator unavailable all reject without mutation by the rejected call.

Exact witnesses contain public PostgreSQL row/sequence/guard wire values and private rows/objects/triggers/functions/ACLs including row xmin/ctid. Intentional mutation/restoration occurs outside each measured rejection interval and is not confused with unchanged physical row identity. Clean retries are compared exactly. Forced-death receipts contain actual process exit/close and SQL backend observations.

Final counts, hashes, immutable snapshots, historical failures, systemd exits and explicit teardown are in the dispatch FINAL-HANDOFF.md, not fabricated here. Full Vitest historical exit130, browser/real restore, real data/session compatibility, coordinator/host/key-loss authority recovery and Task19–24 whole acceptance remain distinct and unproven.
