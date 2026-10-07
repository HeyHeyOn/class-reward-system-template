# Task21: isolated synthetic product post-write recovery

> **과거 실험 기록:** Task1–24 계획에 속한 당시의 합성 검증·복구 실험이다. 현행 A–F의 실행 순서나 현재 운영 완료율을 나타내지 않는다. 현재 상태는 [README](../README.md)를 따른다.

## Scope and authority

This is an executable NONPRODUCTION slice, not an operational recovery mechanism.
`src/server/exports/syntheticProductDelta.ts` has no HTTP route, environment URL,
real session, Sheets/Redis client, deployment action, or lifecycle transition.
It accepts only launcher-owned disposable PostgreSQL handles and a trusted cold
backup expectation obtained through the existing retained backup coordinator.
An uploaded delta, hash supplied alongside an upload, or copied tenant marker is
not a source of authority. The expected delta digest must arrive through the
trusted coordinator channel independently of the artifact being checked.

The supported scope is ONE controlled product transaction after ONE scoped
materialized backup. Products support create, update (name/price/stock with a
version increment), and physical delete of an unreferenced product. Existing
foreign keys can refuse a delete. Product defaults, timestamps, nullable fields,
versions and maximum safe bigint values are carried as exact PG JSON row images.
The source outbox records ordered before/after images with contiguous sequences
1..N and an explicit checkpoint 0..N (at most 100 events, 1 MB artifact, 1000 final
products). These are transaction-local logical positions, not WAL LSNs or global
commit-order cursors. Native constraints and tenant RLS remain enabled.

## Path

1. Existing materialized backup creates and seals real `pg_dump` bytes. The cold
   coordinator retains the archive and expectation outside the source process.
2. `captureSyntheticProductWrites` checks the owned source, exact sealed initial
   public rows, guards and sequence state. Only the allowlisted controlled
   commands run as tenant-scoped `app_runtime` inside one PG transaction. All
   unsupported public rows, guards and sequence values must remain unchanged.
3. The same transaction saves the exact exported bytes, request digest, artifact
   digest and source physical identity into an owner-only immutable private
   outbox. An identical retry reads and verifies that receipt and final source
   state instead of repeating writes. Changed requests or state fail closed.
4. The source is closed and removed. A fresh independent child process acquires
   the existing cold archive lease, allocates a new private owned PG cluster,
   executes the real native cold restore, and validates its immutable receipt.
5. `replaySyntheticProductDelta` checks the separate trusted digest, scope,
   sequence, event/entity/row shape, tenant and full binding, native destination
   lease, physical identity, immutable restoration identity/receipt and exact
   pre-state. It does not allocate a caller-selected target or acquire authority.
6. The product row mutations and immutable private destination checkpoint commit
   together. Every before-image must match; final products and ALL unaffected
   public tables, sequence values and public guard definitions must reconcile.
   Native errors or late reconciliation failures roll back rows and checkpoint
   DDL together. The private control schema has no runtime access grant.
7. An identical retry requires the persisted digest/checkpoint AND unchanged
   exact final state, and returns `ALREADY_APPLIED`. Conflicting retries refuse.

The transaction locks are only database transaction serialization within this
fresh synthetic cluster. They are not a production writer-fence implementation.
Four source/destination provenance tables differ by design and are independently
checked against the cold backup/restore identities; they are not replay targets.
The two source-only provenance tables must remain empty on the destination,
including on checkpoint retries. All public rows other than products must also
remain byte-exact across the replay transaction, including provenance rows.

## Executable evidence

`src/server/exports/syntheticProductDelta.postgres.test.ts` runs separate capture
and restoration children through `test-support/productDeltaChild.test.ts`.
Positive and negative scopes run independently on a fixed runner snapshot.
Tests use actual native PG, dump, restoration, product SQL and constraint errors;
no fake connection, psql output or fabricated rows substitute for execution.
Source and destination raw PG table wires, guards, sequences, artifact bytes,
checkpoint rows, child reports and exact cleanup IDs are retained as evidence.

Negative cases include transport tampering, wrong digest/owner/base,
out-of-order/gapped/truncated events, cross-tenant rows, unsupported entities,
unknown fields, stale late preimages, false final-state claims, a native FK
failure after an earlier insertion, a conflicting checkpoint retry, and copied
source-only provenance after a successful replay. The latter is intentionally
injected only after the exact source/target reconciliation, and its unchanged
rejected state is separately hashed rather than called a clean final destination.
Each refusal is followed by actual table/guard/sequence and private-control
readback. Source partial-write failure and exact source retry are also exercised.

Run ONLY under the existing approved `secondbot-stage-runner-v2.py` frozen
owned-PG topology and a unique NAME. The required existing PG scope prefix stays
unchanged, with the new test path appended and an exact test-name filter. Do not
run this on a real database or copy operational credentials into a fixture.

## Explicit noncoverage / blockers

- No arbitrary writer interception, continuous CDC, multi-segment incremental
  chain, distributed ordering, general outbox deployment or WAL replay.
- No student/account/balance/ledger/task/promotion/settings/claim/tombstone
  mutations. No sequence-changing mutation. Those rows are unchanged witnesses,
  not evidence that replay for those entities is implemented.
- No post-ACTIVE rollback, writer exclusion, authority promotion or production
  DB import/export API. Existing operational authority remains unchanged.
- The synthetic source outbox protects this controlled PG commit/response retry;
  disk loss, power loss, storage fsync, upload and retention-service crash safety
  are not proven by a successful fixture run.
- The coordinator is trusted. It must preserve the independently admitted backup
  expectation and artifact pin; the library does not sign public uploads or
  defend against a malicious PG superuser replacing all private evidence.
- Passing these tests does not accept Task19–24, browser/product behavior,
  operational recovery, or a historically incomplete full Vitest gate.

The packet FINAL-HANDOFF under the supervisor ROOT is the source of actual run
results, frozen hashes, RED/GREEN receipts, cleanup and remaining acceptance.
