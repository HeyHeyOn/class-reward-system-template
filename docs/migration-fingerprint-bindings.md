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

## Version-2 final bridge companion binding

The internal READY-to-CAPTURED companion now requires the unchanged purpose
`CLASS_STORE_FINAL_BRIDGE_INTAKE` with exact `bindingVersion: 2` JSON. Its three
lowercase SHA-256 fields have independent meanings:

- `jobSemanticFingerprint`: the locked READY job's semantic-record fingerprint.
- `sourceAcquisitionDigest`: the locked source's **original** acquisition digest.
- `spreadsheetIdDigest`: the persisted source external ID, produced by hashing
  the original raw spreadsheet ID. It is neither of the other two fingerprints.

Server-owned registrations explicitly supply both raw `spreadsheetId` and
`spreadsheetIdDigest`. Issue and accept require exactly one matching canonical
tenant/source/digest registration and verify `sha256(raw) === digest`. The bridge
producer hashes its raw input ID before capture, then embeds the exact challenge
in its authenticated encrypted payload. Intake verifies the captured raw ID
against the registered raw ID, not against a digest. A 64-character hash-shaped
raw ID is still raw. Legacy raw database identities are refused, not inferred,
automatically hashed, repaired or backfilled. Requests cannot supply this mapping,
keys, registry entries, deployment trust anchors or bridge URLs.

The new final acquisition may have a different time, revision and artifact digest.
Its complete schema, row hashes, redaction and provenance still pass the real
normalizer; its digest is **not** forced equal to the original READY acquisition.
The original job semantic and acquisition bindings are independently rechecked
under locks. No importer provenance is rewritten or equalized. Final generation
preparation still validates the original import separately from its candidate;
this capability is not wired into that service or a public route.

Old single-fingerprint, missing-version and mixed challenges remain immutable
archival JSON but are refused by issue/accept/replay parsing. Obtain a fresh
challenge; never upgrade retained evidence or delete old nonce tombstones. The
existing 0014 JSON envelope supports this without DDL or ORM changes. Receipt
storage and migration 0017 are unchanged and are not reused by bridge intake.

Global purpose-framed nonce replay, exact immutable readback, current membership,
DB-clock expiry after waits/consumption and acknowledged outer COMMIT remain the
acceptance boundaries. The returned opaque acquisition has
`exclusion: 'NOT_PROVEN'`: **CAPTURED is not a job transition, writer-exclusion
proof, freeze consent, executable delta, or activation authority.** Unsupported
missing/null Redis is not synthesized; BANK quarantine and Settings/credential
redaction remain blocking for import even when authentic acquisition is inspectable.

`authenticFinalBridge.test.ts` starts with actual Sheets and Redis capture, then
runs the real normalizer, importer and READY reconciler before issue, real
`runLegacyMigrationBridge(final-delta)` and accept. Only workbook/HTTP I/O is
fixture-controlled, including the writer-disable POST and two matching GETs;
crypto, acquisition, normalization, SQL and tenant transaction handling are real.
Its raw ID is deliberately hash-shaped, semantic/acquisition hashes differ,
and the final capture changes time/revision without changing original import
rows. Every public-schema table except the two bridge replay tables is compared
before/after acceptance. Independent semantic, acquisition and identity drift
are covered alongside retained replay, trust replacement and malformed-wire
regressions. These are local PGlite checks using all production migrations and
the harness runtime role, not separate-connection PostgreSQL or deployment proof.
No production capture, live writer disable, deployment, freeze or activation is
part of this change.
