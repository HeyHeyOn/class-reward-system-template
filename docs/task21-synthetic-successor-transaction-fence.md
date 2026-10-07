# Task21: exclusive native catalog transaction admission (NONOPERATIONAL)

> **과거 실험 기록:** Task1–24 계획에 속한 당시의 합성 검증·복구 실험이다. 현행 A–F의 실행 순서나 현재 운영 완료율을 나타내지 않는다. 현재 상태는 [README](../README.md)를 따른다.

This packet implements the authorized nearest transaction-lifetime fence alternative, NOT an enrolled cold successor grant. No accepted sealed cold restart/resume, recovery, preparation, ACTIVE, operational writer fence, SQL account/permission grant, or production authority is added.

## Exact remaining contract boundary

`coldRestoreStore.requireColdExportReplay` accepts the original live `exportExecutions` WeakMap capability only. `pinColdExportExecution` binds it to the actual held original archive lease/process and the exact dispatched allocation. `sealed_export_execution` is immutable ORIGINAL provenance, not an enrolled successor capability. `requireColdExportCompletion` separately requires original SUCCEEDED settlement and released control locks. A valid retained export, dead original, complete/partial SQL, or copied execution row does not satisfy either authority contract.

The current-source isolated `cold-contract` run on `task21-tx-fence-red-20260928a` executes the existing cold successor test with the source gone, exact retained seal, fresh processes, original death and unchanged SQL. It confirms refusal, NOT positive successor admission. It is a passing blocker characterization, not a failing positive-grant test. The native concurrency counterexample below is the actual behavioral RED. A new durable enrollment/consumption and original-retirement protocol would be needed to change this cold authority contract safely; this packet does not infer that such a future protocol is impossible. Merely substituting a new owner, relabeling the terminal or accepting copied predecessor JSON would bypass the current contract.

## Concrete current-source RED and minimal implementation

In `task21-tx-fence-red-20260928a/native-red`, native transaction A successfully acquires the current private guard. Native B then also passes that guard and retains catalog SHARE locks. A's real `ALTER FUNCTION ... COST 101` is blocked by B and fails with PostgreSQL `55P03: canceling statement due to lock timeout`. The record preserves both real backend states/lock sets and exact unchanged SQL before/after rollback. The test fails because the contender was admitted. Required full-generation regression runs alongside it, not as an empty command prefix.

`requireSyntheticCatalogFence` now first takes `pg_catalog.pg_namespace IN SHARE ROW EXCLUSIVE MODE NOWAIT`, before collecting its existing all-heap-catalog SHARE locks. The native entrance lock conflicts with itself, is reentrant for the owning transaction, and refuses a contender before it can retain a catalog SHARE lock set that obstructs the owner's later DDL upgrade. All existing native role/function/catalog and private-table locks and ORIGINAL checks remain. There is no advisory-lock replacement, permission change, new server flag, retry loop, transferable handle or file publication.

This is intentionally fail-closed contention: an explicit later transaction may retry after the owner ends; a denied call does not automatically wait, retry, enroll or acquire recovery authority. PostgreSQL releases locks on COMMIT, ROLLBACK, subtransaction rollback (if acquired there), or backend death. No returned void guard result is a reusable authorization token. Existing controlled call sites acquire/revalidate inside their own explicit transaction.

## Bounded native evidence

`syntheticSealedSuccessorFence.postgres.test.ts` covers:

- Concurrent entrant refused with 55P03; admitted owner can perform a real catalog upgrade, then roll it back without publication.
- Native catalog/function/role/table lock readback; same-transaction reentry; exclusion through COMMIT and ROLLBACK; a new exact retry afterward without changing terminal identity.
- Termination of only the exact freshly test-owned PG backend after real uncommitted DML and DDL; in-transaction visibility versus independent unchanged readback, backend disappearance, native aborted XID, no published table, and positive original retry. This is backend-transaction death, not host/application crash recovery.
- Existing app_runtime session role denied with 42501, without changing any role or permissions.
- Same-transaction function-catalog mutation after admission rejected on ORIGINAL revalidation, followed by exact rollback and a positive original retry. This does not claim that native locks protect against arbitrary hostile code already running as the same SQL superuser.

Witnesses retain actual SQL row/xmin/ctid, public rows/sequences/guards, private catalog/role/membership snapshots and ORIGINAL file bytes. Existing sealed successor, private guard and catalog fail-closed tests remain unchanged and are run separately on the final pinned snapshot. Scoped results are not a whole-suite result.

## Not closed

Positive pre-enrolled cold successor restart/resume, a durable one-use grant bound to original retirement and a specific successor transaction, positive grant retry, and the requested foreign/forged predecessor, wrong tenant/sequence and post-grant mutation matrix remain open. Existing refusal tests are not relabeled as coverage of an accepted grant. Full browser, historical whole Vitest exit130, real-data compatibility and Task19–24 full acceptance remain separate. The owning secondbot packet's final manifest records actual receipt exits, hashes, cleanup and source-preservation checks.
