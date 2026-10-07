# Delta retrieval/replay contract — design only, NOT_IMPLEMENTED

Task21 G3 is NOT_PROVEN. No capture daemon, publication/slot, outbox, applier,
DDL, grants or cutover is installed by this packet. The executable path supports
ONE synthetic snapshot only and refuses DELTA/multiple-artifact manifests.
This contract is deliberately separate from retainedExportManifest v1: its UTC
(from,to] windows are display metadata, not commit cursors or completeness proof.

## Scope and authority

The initial implementable target is a disposable, single-synthetic-tenant PG17
application-schema cluster. Never connect it to an existing instance. An approved
production implementation would need a separately approved capture architecture,
source owner, keys, privileges, full schema coverage and independent verification.

Inputs must be independently approved tenantId/jobId/generation/exportId,
source cluster identity + timeline/epoch, schema/code profile, base snapshot
fingerprint, base commit cursor, intended final commit cursor and a separately
retained authenticated head. Do NOT derive the expected head or expected tenant
from the fetched manifest. An artifact's own digest is not a trust root.
A job/generation ID is a binding, not an access grant or final-source authority.

Global Padlet claim registry/tombstones and identity/membership dependencies must
be explicitly included in the snapshot/stream closure. A tenant-scoped dump of
only tenant_id tables is invalid. Cross-tenant shared dependency, unknown scope,
missing relation, unknown table version, TRUNCATE, DDL, role/ACL changes and sequence
changes unsupported by the selected profile must STOP, not be silently skipped.

## Capture consistency prerequisite (currently missing)

Preferred research candidate: verified PG logical decoding with a consistent
exported snapshot and a reserved replication slot's exact consistent point.
The snapshot must remain alive until its dump has finished. Writers need not
stop if the snapshot/slot protocol proves no gap; a later timestamp or SELECT
pg_current_wal_lsn() alone cannot establish that proof. An outbox is an alternative
ONLY after every writer and trigger is proven to write it in the same transaction;
the existing operations/audit tables are not assumed to be complete outboxes.
No implementation is chosen/installed in this packet.

Require replica identity / old primary key / old row image coverage sufficient for
UPDATE and DELETE on every captured relation. Track relation schema fingerprints,
publication filters, decoder identity/version, spill/restart/lost-WAL events and
checkpoint durability. Logical LSN values are not consecutive integers; never
invent missing-transaction detection from arithmetic gaps between LSNs.

## Authenticated checkpoint and segment wire requirements

A separately durable capture coordinator records an authenticated checkpoint:

  profile, sourceClusterId, sourceEpoch, tenantId, jobId, generation,
  baseSnapshotSha256, baseCommitCursor,
  finalCommitCursor, segmentCount, finalSegmentSha256,
  relationInventorySha256, schemaProfileSha256, keyId, signerId

Canonical serialization, algorithm/version, exact key lookup, signer trust and
revocation policy are mandatory. KeyId is an opaque locator, never key material.
Encryption must bind the same context as AAD. The coordinator must confirm source
transaction coverage before publishing the head; signing an incomplete chain does
not make it complete. A compromised same-UID fixture custodian is out of scope for
current tests and cannot be called independent key custody.

Each immutable segment contains its segment index, previous ciphertext digest,
base identity, from-exclusive and through-inclusive COMMIT cursors, full ordered
transactions, transaction count, record count and relation inventory digest.
A transaction contains tx identity, commit cursor, commit ordinal when needed,
ordered row changes, event count and canonical transaction digest. No transaction
may be split at a checkpoint. Commit cursor ordering is the source protocol's
ordering, not client wall clock. Empty progress ranges need authenticated source
checkpoint evidence. Timestamp-only gaps and manifest READY flags prove nothing.

Row change forms (typed, table-specific decoders, no embedded SQL):

  INSERT: relation identity/version, primary key, full after image, after digest
  UPDATE: immutable identity, old primary key, expected before digest,
          complete after image, after digest, row-version transition
  DELETE: relation identity/version, old primary key, expected before digest,
          tombstone with source operation/transaction identity

Soft-delete columns are UPDATE, not omission. Business cancellation/reversal is
its actual transaction plus all ledger/items/task/claim effects atomically;
never translate a cancellation into deleting an immutable original transaction.
Hard deletes and PK changes must not be inferred from a missing row in a partial
scan. Snapshot export must preserve numeric/date/null precision and duplicates.

## Retrieval and replay

1. Authenticate requester and re-check present membership; resolve independent
   expected tenant/job/generation/head and custody policy. No current API is added.
2. Fetch exactly the immutable objects listed by that authenticated head. Refuse
   foreign scope, replaced bytes, oversize, expiry, unknown version, missing or
   extra segments, duplicated index, reordered segments, broken previous digest,
   changed inventory, mismatched base/head or stale source epoch. Verify AEAD before
   decoding. Retry fetch is idempotent; partial files are never publishable.
3. Restore the base into a NEW isolated database. Verify schema, all rows,
   sequences and security catalog against the independently captured source oracle.
   Existing active DB targets are forbidden. This is not an activation operation.
4. Replay committed transactions in exact source order using table-specific,
   parameterized DML. Allowlist relation identifiers; never execute source text.
   Check UPDATE/DELETE preimage + expected row version. Verify INSERT absence and
   expected identities. Preserve FK/uniqueness, tenant/claim/operation boundaries,
   ledger/immutability semantics. Blind UPSERT / ON CONFLICT DO NOTHING is forbidden.
5. Apply a transaction and insert its (stream identity, commit cursor, tx digest)
   replay receipt and checkpoint in the SAME target transaction. A retry with the
   same identity+digest is no-op only if that committed receipt exists. Same ID
   with another digest, older cursor without a matching receipt, missing predecessor
   or changed source epoch is fatal. Crash before commit rolls back all effects;
   crash after commit resumes from verified receipt, not a client-side filename.
6. Before final completion, reach the independently expected head exactly, verify
   all transaction/event counts, rows/schema/sequences/security and invariants.
   Missing receipts/checkpoints must not be reconstructed by trusting final rows.
   Replay into append-only tables requires a reviewed restore-time construction
   sequence and trigger semantics; do NOT disable existing guards to force green.

Replay checkpoint/receipt schema and the consumer/import adapters do not currently
exist in the allowed DB scope. They require separate ownership in db/migrations
and migration services. This packet does not emulate them with a self-comparison.

## Required real-PG adversarial experiments — NOT_RUN

Base + INSERT/UPDATE/DELETE, PK change, soft delete, delayed cancellation, reversal,
claim/tombstone collision, assignment/completion/recurrence change, ledger/stock
and account reconstruction. Independently query a source after final commit,
then compare a separately restored target; never generate expected rows from the
same replay function. Missing segment AND missing individual event, reordered and
duplicate segment/tx, same bytes/different cursor, different bytes/same receipt,
foreign tenant, concurrent writer at snapshot boundary, crash before/after commit,
slot loss, schema drift, unsupported sequence/ACL change, stale/revoked signing key,
lost/wrong decryption key, and truncated artifact must all be exercised.

All of these are implementation/verification dependencies, not new acceptance
scores. Snapshot success would not prove G3, production RPO/RTO, exclusion or
storage rollback. Legacy writer reactivation/cutover is explicitly out of scope.
