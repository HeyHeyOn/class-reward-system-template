# FREEZING producer durable reservations

## Executable boundary

`createFreezingProducerReservations(pool, deploymentId)` implements the exact
`FreezingReacquisitionReservations` interface. Compose it with
`createRegisteredFreezingReacquisition` on the server. The registered core verifies
the genuine phase-specific signed request and body, reserves once, requires an
exact acknowledged row, then performs status GET → actual Redis/Sheets capture →
status GET → authenticated encrypted candidate. No local disable POST is added.

The dedicated companion transaction is explicitly `READ COMMITTED`, verifies the
actual isolation and nonowner/non-superuser/non-BYPASSRLS deployment role plus
forced RLS, inserts and reads back the full phase/start/request binding, checks the
SQL clock, and requires COMMIT ACK. Its maximum attempt count is one; it does not
use the tenant runner, tenant GUC, default tenant pool or retry loop. A lost COMMIT
ACK discards the connection and returns refusal even if SQL committed. No archival
row lookup can turn this failure into a capture authorization. The core rechecks
the original request lifetime after reservation and before any status/source read.

## Shared replay domain and old-version compatibility

Migration **0022** extends the *same* `migration_bridge_producer_reservations`
relation. Keeping its existing global nonce PK and challenge UNIQUE constraint
avoids both a backfill race and cross-table collision holes. Old binaries still
insert into this same ledger and therefore cannot reuse new-phase tombstones.
New binaries likewise cannot reuse old-phase challenge or nonce digests.

The additive columns are `purpose`, `start_ceremony_id` and `execution_digest`.
The constant default is the actual old signed request purpose,
`CLASS_STORE_REGISTERED_FINAL_BRIDGE_REQUEST`; historical values, timestamps and
old INSERT shapes are preserved without UPDATE/DELETE/backfill. The old
`ceremony_id` physical NOT NULL constraint becomes a phase-discriminated CHECK:

- Old purpose: old ceremony is required; new start/execution columns are NULL.
- New purpose: old ceremony is NULL; new start is required and execution digest is
  exactly lowercase SHA-256 text.
- NULL/unknown purpose and hybrid/missing bindings are rejected.

The old adapter is unchanged. New requests are never cast to the old shape or
assigned its old purpose. A new adapter INSERT states the new purpose explicitly.
The existing old registration and its disable/start scope remain unchanged.

Both producers hash `[their exact request purpose, raw nonce]`. Thus nonce
**digests** share a global unique SQL domain, while raw nonce purpose separation
is retained: the same raw nonce under different authenticated purposes is not
mistaken for the same digest. Challenge IDs are globally unique without any phase
or deployment qualification.

## Retention and authority

0020's forced RLS, deployment-bound SELECT/INSERT policies, unconditional immutable
UPDATE/DELETE trigger and statement-level TRUNCATE rejection remain in place.
No runtime grants are broadened. These permanent tombstones survive expiry and
uncertain responses; there is no cleanup or delete/repair path.

No FK is introduced. This existing companion replay ledger deliberately has no
central tenant/job/start/registration FK or cascade: those objects need not exist
in the deployment-local replay database. UUID/digest start bindings are signed
provenance, **not proof of a central execution or action permission**. Invalid-FK
coverage is therefore not applicable to this storage choice; SQL phase/start
CHECKs are tested, and genuine central execution/registration existence checks
remain part of the later authenticated central path. Do not add a fake central
row simply to make a companion FK pass.

## Verification and explicit remaining gates

The focused integration runs all applied migrations through 0021, creates an old
reservation, upgrades with 0022, and compares every old column. It executes the
real signed registered producer against the new adapter and restricted PGlite SQL
role. Only low-level source/control responses and pool transport are fixtures;
reservation and crypto code are real. Crypto-open uses a test-only actual SQL
nonce sink, not the unimplemented central intake. The existing schema parity test
compares real SQL and ORM column domains, defaults, keys and CHECK expressions.

Tests cover both collision directions, independently instantiated/concurrently
invoked producers, same-purpose nonce reuse, exact binding readback, missing or
mismatched readback, suppressed INSERT, lost ACK, post-ACK expiry, incorrect
isolation/SQL clock, role/RLS denial, permanent retention and old-adapter casts.
PGlite has one connection: the pool fixture serializes connection acquisition.
This does **not** prove independent-connection PostgreSQL unique-index waits,
rollback/commit races, production login provisioning or migration lock behavior.
Those real PostgreSQL probes remain a required pre-deployment gate.

The fixed `/api/internal/migrations/freezing-reacquisition` POST and
`freezingReacquisitionProduction.ts` now compose this adapter with the actual
registered producer and deployment refresh-credential reader. Configuration and
synthetic SQL/SDK/HTTP verification are documented in
[migration-freezing-reacquisition.md](./migration-freezing-reacquisition.md).
The separately explicit `READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE`
registration fails closed when missing and never inherits the old disable/start
scope or browser credentials. No live registration or role provisioning is done.

Central bootstrap/current-member/CSRF challenge intake, immutable candidate
storage, canonical tenant routes and UI remain outside this slice. Every candidate
is permanently `NONAUTHORITY`, `NOT_PROVEN`, `finalImportEligible: false`—even if a
later fence is established. No FINAL_FROZEN, import, activation, lease, ACL change,
credential revoke or provider operation is implemented or authorized here.
