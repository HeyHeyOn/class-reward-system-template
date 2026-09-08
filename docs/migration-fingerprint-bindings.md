# Semantic and acquisition fingerprint bindings

`migration_jobs.source_fingerprint` is the normalizer's semantic-record fingerprint.
`migration_sources.source_fingerprint` is the original acquisition artifact digest.
The real importer intentionally persists distinct values; READY reconciliation does
not make them interchangeable.

Authenticated freezing confirmation now displays, persists, compares and hashes
`jobSemanticFingerprint` and `sourceAcquisitionDigest` separately. The exact
challenge parser requires both. Existing single-fingerprint challenges remain
immutable evidence but cannot be consumed by the revised adapter; obtain a fresh
explicit confirmation. No old binding is rewritten or upgraded into permission.
The purpose remains start-freezing approval, not activation or writer exclusion.

## Additive receipt representation

Migration 0017 adds nullable `source_acquisition_digest` to the existing immutable
receipt relation. The existing `source_fingerprint` column continues to bind the
job's semantic fingerprint. The new authenticated adapter always supplies the
separate acquisition digest; both are checked against their corresponding locked
rows and retained by exact receipt readback. The challenge's content digest covers
both explicitly named fields.

NULL is solely the legacy single-fingerprint receipt representation. Its old
consistency check (the one value must match both job and source) remains intact;
it is not a way to approve a real import with distinct fingerprints. Old archival
inputs with no new key normalize only that absent column to NULL for readback.
An old envelope cannot recover a new dual-binding receipt, and an invented
acquisition digest cannot recover an old receipt. All receipt storage/recovery
remains `NON_AUTHORITY`; only acknowledged outer confirmation COMMIT mints a
private in-process capability.

No receipt backfill, destructive migration, retention change, SQL 0013/0015/0016
rewrite, or runtime privilege expansion is needed. Existing forced RLS and
immutable receipt triggers cover the new column. Existing READ COMMITTED checks,
source FOR UPDATE snapshot-insert serialization, exact PREFLIGHT cardinality,
CSRF, actor/state/source freshness, expiry checks and commit/rollback boundaries
are unchanged. Deployment ACL and real separate-connection concurrency proofs
remain independent integration gates; local PGlite tests are not deployment proof.

## Explicitly unresolved companion boundary

`finalBridgeIntake.ts` still compares the job semantic fingerprint to the source
acquisition digest in `lockCurrent`. Its CAPTURED bridge challenge contract also
has a single fingerprint. This repair does **not** claim that boundary is fixed.
Moreover, the importer stores `spreadsheetIdDigest` as the source external ID,
whereas final bridge acceptance compares the actual captured `spreadsheetId` to
that ID. A companion change must first reproduce the complete authenticated
READY-to-CAPTURED path and define its registered source identity/bridge wire
binding consistently. Do not remove its equality comparison alone or silently
rewrite retained external identities. No bridge, capture, freeze execution or live
activation was performed here.
