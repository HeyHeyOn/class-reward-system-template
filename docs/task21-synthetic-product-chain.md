# Task21 synthetic multi-segment product chain

> **과거 실험 기록:** Task1–24 계획에 속한 당시의 합성 검증·복구 실험이다. 현행 A–F의 실행 순서나 현재 운영 완료율을 나타내지 않는다. 현재 상태는 [README](../README.md)를 따른다.

NONPRODUCTION only. Extends, and does not replace, `syntheticProductDelta.ts`'s single-transaction contract. No Next/HTTP API, runtime export service, operational database migration or authority transition is added.

## Trusted inputs and chain contract

The owner/coordinator retains a fresh random `chainId` and `parentIdentity = SHA256(canonicalJson(entire admitted MaterializedArchiveExpectation))` separately from transport. The parent expectation comes from the existing private cold coordinator, never from delta bytes. The full parent pin covers backup digest, tenant/job/full binding, original and materialized source identities/owner, exact base rows, sequences, guard definitions and provenance. The parent pin and chain identity are trusted API arguments; accepting attacker-controlled values there is outside this contract.

Segment envelope V1: exact chain/parent identity, segment ordinal (1..32), cumulative `from`/`through` event checkpoints, `previousDigest`, and one existing validated V1 product transaction. First previousDigest is SHA256(canonicalJson(chain pin)); subsequent previousDigest is the immediately preceding complete segment SHA256. Each segment additionally requires a separately trusted SHA256 supplied by the coordinator. Digests authenticate relative to those pins, not a public-upload signature.

Each source call commits one controlled product transaction and an immutable owner-only SQL outbox entry together. The next segment uses the preceding final product wire as its base, while all other public rows, sequences and guards must still match the retained backup. Both before and final rows are checked. A durable source tip retry must match the stored request and exact payload. A historical source request is not silently reapplied.

The restored destination uses an append-only owner-only checkpoint journal. Its latest ordinal, cumulative checkpoint and digest are the durable destination checkpoint; no process-local cache is authoritative. Every call checks the full journal chain, exact current public state, private restore lease and immutable source/destination receipt. DML and checkpoint insertion commit atomically. Missing, skipped, reordered, conflicting, wrong-chain, cross-tenant or tampered segments refuse without destination changes. Duplicate old segments refuse once a successor exists. A byte-identical retry of the CURRENT tip is intentionally ALREADY_APPLIED, not a duplicate failure; this is the unambiguous lost-response retry contract. No batch transport accepts duplicate entries.

The journals are private schemas, have no runtime grants and reject update/delete/truncate. Public guards and RLS are not disabled. A per-database whole-public-table lock (and destination lease lock) serializes these synthetic functions only, not a claimed production writer fence.

`verifySyntheticProductChainCheckpoint` is the explicit completion gate. It requires a separately trusted intended endpoint `{segment, checkpoint, sha256}`, reauthenticates the parent/chain/destination and complete SQL journal, and reconciles actual public rows, sequences and guards with that endpoint. It performs no writes. A valid prefix is not complete: omitted terminal segments, stale/wrong endpoint pins and any endpoint mismatch refuse without changes. Replay success alone is not whole-chain completion. Without a trusted intended endpoint, unknown trailing transactions cannot be inferred.

## Executable evidence scope

Tests create three sequential committed product segments after the retained native backup, with cumulative checkpoints 2, 4, 6. Source capture/retry and destination replay/retry use separate cold Vitest child processes with native node-postgres connections to the exact still-parent-owned synthetic container. The launcher parent alone owns cleanup. It passes an exclusive private request file, not environment-sized JSON, endpoints, credentials, or an artifact-declared resource handle. The source is removed and its capture child exits before fresh destination allocation/restoration.

At EVERY checkpoint tests reconcile raw PostgreSQL public-row JSON text, sequence last_value/is_called (including non-default sequence values) and guard definitions with the source's independently captured committed state. Only the four established source/destination provenance tables differ, and their exact applicable identities/emptiness are separately checked. Negative attempts retain complete public and private before/after witnesses, including late rollback after earlier valid DML and after prior committed segments. Exact tip retry after a terminated worker is read back from SQL, not JavaScript memory.

## Explicit non-goals and limits

Only existing product create/update/delete semantics are supported: up to 100 events / 1 MB per segment, 1000 final products, 32 segments, and no sequence-changing mutation. Students, accounts/balances, ledger/transactions, tasks/schedules, settings, promotions, claims/tombstones and other entities remain unchanged witnesses, NOT supported delta targets. Direct other writers, concurrent CDC, WAL cursors, global commit ordering, event completeness relative to outside writers, truncated stream detection without a trusted intended terminal pin, power-loss/fsync durability and actual COMMIT transport-loss fault injection are not proved. The caller must retain the intended terminal digest/checkpoint to know that all intended segments arrived.

SQL commits survive the tested APPLICATION-process restarts; the disposable PG tmpfs cluster itself is not restarted or crash-durability tested. Trusted same-UID private coordinator storage, launcher ownership and synthetic superuser integrity remain prerequisites. No malicious-superuser resistance or real-data recovery approval is implied.

Whole-suite historical exit130 and Task21 green3 timeout remain NOT_ACCEPTED. Browser Chrome ENOENT/userns remains NOT_RUN. Operational originals, real Sheets/Redis/DB/data/session, writer fence, ACTIVE/deploy/promotion, commit/push, account/model/effort and profile assignment are outside this packet. STOP before operational authority or uncontrolled real-data access.
