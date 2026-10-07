# Task19 synthetic final mutable Products delta

> **과거 실험 기록:** Task1–24 계획에 속한 당시의 합성 검증·복구 실험이다. 현행 A–F의 실행 순서나 현재 운영 완료율을 나타내지 않는다. 현재 상태는 [README](../README.md)를 따른다.

This is a bounded local feature, not the protected final cutover importer. Only caller-owned synthetic captures and exclusively leased disposable PostgreSQL databases are accepted. No live Sheets/Redis source, production connection, writer fence, ACTIVE publication, deployment, or credential is involved.

## Existing behavior and actual gap

The existing full-generation stage retains exact MUTATED/REMOVED before/after images and removal tombstones, and the owned destination materializer imports the final candidate snapshot. The baseline mixed ADDED/MUTATED/REMOVED cold-process PG acceptance passed before this packet. Do not describe those existing behaviors as newly implemented.

The missing behavior was persisted mandatory empty-category accounting. The stage and retained-evidence verifier enumerated only `Object.keys(manifest.records)`. Normalization can omit an empty `padlet_claim_digest_tombstones` array. Pure category coverage included it, but the SQL reconciliation and cold retained-evidence readback silently accepted its missing report. Real PG tests reproduced both acceptance paths before the behavioral edits: a missing empty report still materialized, and cold retention verification did not throw.

Mutable (non-recapture) generation staging and readback now require the entire normalized-category catalog, including zero-count categories and their exact empty digests. The mixed-only retention verifier requires the same catalog. Missing persisted evidence is rejected, not synthesized on read or repaired on retry. ADDED-only and claim-recapture accounting contracts remain unchanged; no Task20/21 code or schema migration is added.

A complete existing mutable generation remains readable. An older incomplete generation/archive without all mandatory reports is intentionally refused; recreate only an owned synthetic fixture with complete evidence. There is no backfill, in-place upgrade, or claim of real-data compatibility.

## Final delta acceptance

`src/server/migration/localFinalMutableDelta.postgres.test.ts` uses the optional test-only variants in `test-support/task19MutableFixture.ts`:

- modified plus deleted Products with no additions;
- modified-only Products with no additions/removals;
- deleted-only Products with no additions/modifications;
- the unchanged mixed default for existing retention/regression tests.

Positive acceptance independently checks exact Products before/after graphs, Sheet contribution pointers and digests, absence of ADDED changes, all normalized-category and provenance/delta reports, and exact destination rows. Fresh application processes open separately pinned source/destination containers for import and retry. SQL write tripwires prove the successful retry is read-only. Tenant RLS, IMPORTING lifecycle, NONAUTHORITY and activationAllowed=false remain explicit.

Negative acceptance removes each mandatory report before import and after a valid receipt; omits or substitutes mutation/removal evidence; inserts a duplicate-removal alias; tests the SQL duplicate-removal key; substitutes same-count Product bytes; checks tenant/job/generation/version/fingerprint/manifest and different physical-source bindings; and preserves inherited same-tenant/other-tenant PX sentinel rows.

The destination must be vacant (apart from owned metadata), or a byte-matching retry of this import. A removal tombstone is evidence for exclusion from the new candidate, not permission to DELETE an inherited destination record. Source Products, including removed PX, remain unchanged. Importing into an existing operational destination would require a separate authority/lifecycle/rollback design and is outside this slice.

## Interrupted writes and limits

A suppressed Product INSERT is detected by readback and rolls back without a receipt. A separate actual PostgreSQL cancellation test pauses an AFTER INSERT trigger, records the backend PID in a nontransactional sequence, verifies the active app_runtime backend belongs to that owned disposable destination, and calls `pg_cancel_backend`. The sequence witnesses that a real Product write occurred before cancellation. Full source/destination SQL state equals the pre-attempt state afterwards, no materialization receipt exists, and a fresh application process can retry successfully.

This proves SQL statement cancellation and transaction rollback, not SIGKILL, power failure, host loss, or durability after destruction of PG tmpfs. Source/destination ownership is a trusted exclusive infrastructure lease; it is not protection against an administrator replacing both a pin and its resources.

## Execution

Use `secondbot-stage-runner-v2.py` with unique immutable labels and unique stage names. The PG guard requires `localFullGenerationStage.test.ts` in the command. Run new positives and negatives serially, then direct PG/pure regression, typecheck, scoped lint and build from the final freeze. Retention regression must include a subsequent no-PG cold reopen stage. Capture default+JSON reports, heartbeat/final receipts, exact exits, hashes, packet diff and owned-container cleanup.

Full Vitest is a distinct gate, executable only as an independent `class-store-*` systemd job; its historical exit130 is not acceptance. Browser NOT_RUN, protected authority transition, real-data compatibility and all production gates remain separate unaccepted conditions. Final evidence is in this packet's supervisor dispatch `FINAL-HANDOFF.md` and `final-manifest.json`.
