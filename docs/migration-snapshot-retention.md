# Migration snapshot append-only contract

`0016_migration_snapshots_immutable.sql` adds enforcement without changing the
bytes of earlier migrations or rewriting existing snapshot rows. Applying it is
not validation or repair of historical evidence: consumers must still reject
missing, ambiguous, corrupted or incorrectly bound snapshots.

## Stored evidence

Every persisted `migration_snapshots` row is immutable. All UPDATEs (including
no-op assignments to any column) and DELETEs fail through `reject_immutable_row`.
A statement-level trigger also refuses TRUNCATE, including TRUNCATE CASCADE.
Existing primary keys, phase checks, source FKs and the
`(tenant_id, source_id, phase, artifact_digest)` idempotency constraint remain.
New phases and artifacts are appended as new rows; never promote a PREFLIGHT
row to FINAL_FROZEN or rewrite an old artifact. Exact importer reruns retain the
original snapshot instead of updating it.

The source FK still declares ON DELETE CASCADE. Reaching a retained snapshot now
aborts the complete parent deletion, including source/job/tenant cascades. This
is intentional retention, not an incidental cleanup failure. Any future evidence
deletion needs a **separately approved retention procedure** accounting for
linked authority and audit evidence. No runtime bypass or production deletion
procedure is provided here.

## Concurrency and authority

Immutability prevents a previously excluded non-PREFLIGHT row from entering an
intake predicate by UPDATE. It does **not** prevent INSERT phantoms. Keep the
existing source FOR UPDATE lock, snapshot locking reads, and the actual
transaction READ COMMITTED check before binding reads. Unsupported isolation is
refused, not silently upgraded or treated as equivalent. A pre-existing FK
INSERT must finish before the source lock and become visible to the following
READ COMMITTED query; a later INSERT waits until the approving transaction ends.

Rows can still be appended after approval commits. Therefore exact-one cardinality
is not a permanent set invariant, and downstream actions must revalidate their
own bindings. This change supplies neither maintained writer exclusion nor live
freeze, final-capture authenticity, activation authority, or retention approval.

## Runtime and privileged boundary

Provision runtime as a nonowner NOSUPERUSER NOBYPASSRLS role with no schema CREATE,
DDL, trigger-disable, or TRUNCATE privileges and no membership in privileged owner
roles. Keep SELECT/INSERT and only the column UPDATE privileges necessary for
locking reads; those lock privileges cannot mutate snapshot rows through these
triggers. Broad-CRUD test roles exercise defense in depth, not recommended
production grants. Deployment ACL provisioning is a separate operational gate;
this migration adds no grants. Owners/superusers capable of changing DDL remain
trusted and outside the runtime protection boundary.

## Tests and historical corruption

The common PGlite harness deliberately retains its historical 0008 baseline.
Snapshot upgrade tests seed evidence first, apply all remaining migrations and
compare PostgreSQL logical row serialization unchanged. Intake, reconcile,
final-generation, cutover and importer integration tests apply later migrations
explicitly. Existing tampered-evidence/overflow tests use the isolated PGlite
owner-only `withMigrationSnapshotTampering` fixture helper. It disables only the
snapshot UPDATE/DELETE trigger during fixture construction and re-enables it in
`finally`, before invoking any consumer. It does not disable TRUNCATE protection
or confer runtime rights. Integrity assertions are retained, not replaced with
an earlier trigger rejection. Never import this test helper into production.
