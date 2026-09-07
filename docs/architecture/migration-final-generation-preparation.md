# Immutable final-generation preparation

`stageLegacyFinalGeneration` is an internal, server-only **untrusted preparation** entrypoint. It has no route or Server Action and is not imported by an application composition root. It writes only `audit_events`; it never calls the importer to apply a delta, changes a job/lifecycle, publishes claims, consumes approval receipts, or controls external writers.

## Stored production format

Reuse the existing `0003_operations_migrations.sql` / Drizzle `auditEvents` relation: tenant/job foreign keys, forced tenant RLS, immutable UPDATE/DELETE trigger, and exact content-envelope readback. No new SQL migration/schema or weakening of old constraints is necessary.

Three content-addressed audit event types form a checkpoint:

- `MIGRATION_PREPARATION_ORIGINAL`: original redacted Sheet **and complete Redis** acquisitions, newly recomputed normalization manifest, exact tenant/job/import snapshot/source IDs, `ORIGINAL_PREFLIGHT` label.
- `MIGRATION_PREPARATION_CANDIDATE`: candidate acquisitions and normalization manifest, original generation reference, exact expected `READY` job version/binding, exclusion-generation digest **reference**, `FINAL_CANDIDATE` label.
- `MIGRATION_PREPARATION_PLAN`: exact original/candidate generation references and manifest digests, original binding and expected version, exclusion reference, canonical target changes and blockers, `DELTA_PLAN` label.

Every envelope states `UNTRUSTED_PREPARATION`. The existing `migration_snapshots.phase='FINAL_FROZEN'` is deliberately **not** used: a caller label or stored receipt cannot prove a freeze. Old preflight sources, snapshot envelopes, source-record checkpoints, raw/canonical records and reconciliation history are unchanged. A candidate never reuses `ensureSources` to turn a changed Redis digest into a new global source owner. The original full acquisition is stored once per original content/binding, not copied into every later plan. No mutable latest-generation pointer exists.

## Validation and delta meaning

The bounded API accepts acquired snapshots, not caller-normalized manifests or plans. It revalidates acquisition shape, bounds, redaction contract, row/artifact digests, complete Redis arrays, and normalization before the first await; inputs are detached. Full-envelope preparation additionally rejects every noncanonical Settings tab alias recognized by acquisition redaction (`name.trim().toLowerCase() === 'settings'` with `name !== 'Settings'`), even a sanitized alias. This narrow storage boundary applies equally to original and candidate before any transaction; it does not change shared acquisition behavior. Canonical Settings keeps the existing acquisition header/key and supported-hash validation. Both captures must name the same exact workbook. Self-digests prove byte consistency only, not authentic or current source acquisition. Empty complete Redis captures are supported; absent Redis or a caller assertion that Redis was never configured is not.

Staging requires an already fully imported supported original preflight and an `IMPORTING` tenant with the exact `READY` job version. Under existing tenant/job/source/checkpoint/target locks, `inspectLegacyImport` rechecks the original manifest, original snapshot cardinality and exact source bindings, persisted canonical checkpoints, and imported targets. Candidate drift is not passed to that identical-preflight API and never repairs its evidence.

The plan compares **normalized target records**, not operational SQL projections, chronological apply order, final balances, or reconciliation results. Each change records an explicit composite identity, `ADDED`/`REMOVED`/`MUTATED`, and before/after canonical row digests. Full row bodies and all source contributor pointers remain in generation manifests and acquisitions.

- Definition/account/settings/link changes are observations, not permission to hard-delete or mutate history-referenced definitions.
- Transaction/item/adjustment/assignment/completion history, operation bindings, full claims and digest tombstones are append-only for this checkpoint. Removed/mutated canonical rows block the plan. Separately, retained targets' mapping-linked contributors are compared as exact sorted multisets: Sheet kind/tab/physical row number/row hash, or Redis kind/provenance/source digest. Items inherit their transaction source; derived binding/claim/tombstone mapping IDs are resolved explicitly. Source-only differences block with `APPEND_ONLY_HISTORY_PROVENANCE_CHANGED` even when target changes are empty (including trimmed operator whitespace and equal-timestamp row reordering, since importer chronology uses physical row numbers). No contributors are deduplicated or replaced by a union's first member. Acquisition-wide artifact digests remain in full immutable evidence but are excluded from this separate contributor comparison: unrelated appends, metadata or definition changes must not alone invalidate all retained history. Canonical target bytes are still compared exactly, including any embedded claim provenance; no target field is rewritten or silently projected away. Cancellation evolution needs a future audited delta application design.
- Normalization/quarantine/BANK blockers independently block even with **zero target changes**. Raw redacted BANK acquisition, canonical history and evidence are retained; no modern operation authority is manufactured.
- Credential-hash drift blocks separately, because those supported hashes live outside normalized target rows.
- Unknown target tables or repeated target identities fail closed; normalizer-detected duplicate source identities are retained as blocked candidate diagnostics.

`DIFF_VALIDATED` means this bounded canonical difference calculation passed; it is not `READY`, trusted intake, proof of exclusion, an executable delta, or activation authorization. `BLOCKED` plans remain durable evidence and cannot be applied by this module.

## Retry and failure semantics

All three envelope appends/readbacks share one transaction. Identical inserts deduplicate only after exact row readback, including job/type/null actor and operation bindings. Suppressed insert, a conflicting deterministic ID, or failure after readback rolls back every new envelope and retains earlier generations. Same-code retry after a lost commit response reconstructs the same IDs and revalidates the complete original preflight and current expected version. This is preparation retry, not approval replay. After status/version drift, retry refuses; a later archival recovery API is not implemented.

## Retention and access decision required

Complete preparation acquisitions retain personal/student and historical data plus supported credential hashes. The reused audit relation is append-only, with no ordinary expiry or deletion path. Redaction is not anonymization and supported hashes remain sensitive. Production use requires an explicit retention/access decision covering authorized readers, retention duration, backups and any exceptional deletion procedure; this checkpoint grants none of those approvals.

## Explicit remaining gates

Authenticated action-specific approval/freezing-consent intake and central bridge trust/replay composition remain missing. NON_AUTHORITY receipt storage cannot authorize these actions. Maintained external exclusion must cover the supported full writer inventory, generations/credentials, drain, schedulers and human writes through activation/uncertain-commit recovery, under documented trusted-operator assumptions.

Future work must validate operational delta projections and chronology, implement resumable phase-bound application, independently reconcile final state and all full claims/tombstones, then atomically publish authority/activate only with real trusted intake and held exclusion. Grant cleanup, retention decisions and any live cutover remain separate. This checkpoint does not complete Task19.
