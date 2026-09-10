# FREEZING reacquisition: executable producer core (first bounded slice)

This is **not** the complete FREEZING reacquisition flow. There is no new public
route, central challenge issuer, durable candidate storage, or production factory
installed by this slice.

## Executable artifact

`freezingReacquisitionContract.ts` defines strict
`CLASS_STORE_FREEZING_REACQUISITION`, binding version 1, status FREEZING and an
exact 60,000ms original challenge lifetime. The binding preserves independent
original semantic/acquisition/Sheet-identity digests, PREFLIGHT snapshot identity
and digest, historical start ceremony/execution digest, actor/subject/session,
tenant/job/source/version and server registration digest/version/deployment.
Random challenge issuance remains the responsibility of the later central issuer.
Parsing a UUID is not proof of random issuance or current membership.

`registeredFreezingReacquisition.ts` signs requests for the fixed POST path
`/api/internal/migrations/freezing-reacquisition` and exact read-only scope
`READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE`. This is a separate request
signature purpose, not a broadened legacy start scope. The server-owned
registration verifies endpoint, source, audience, digest/version and distinct
Ed25519 request/manifest/writer key purposes. Signed actor/session and historical
start fields must match the signed challenge exactly. The companion checks its
local clock; it neither queries nor claims central current membership.

After exact acknowledged replay reservation, the actual producer executes:

1. Deployment-local control **GET** using the existing bounded status parser.
2. Actual deployment-local Redis acquisition: two complete canonical passes,
   followed by the existing Redis snapshot capture. Missing Redis is refused;
   no never-configured proof or empty snapshot is synthesized.
3. Actual Sheets snapshot capture through the deployment's low-level workbook
   reader and existing redactor; actual normalization retains provenance,
   quarantine diagnostics and independent acquisition revisions/digests.
4. Control **GET** requiring exact equality with the first disabled generation,
   including the original `disabledAt` and evidence.
5. Fresh lifetime check, strict candidate validation, bounded encrypted sealing
   and another lifetime check before returning the envelope.

There is no disable POST, enable, ACL mutation, grant exchange/revocation, import,
activation, or central database operation. Redis REST uses POST to transport
read-only HSCAN/SCAN/GET commands; “no POST” means no control mutation POST, not
that the Redis read protocol changes its HTTP method.

The envelope reuses the established bounded Ed25519/AES-GCM codec with a separate
HKDF encryption domain and a strict phase wrapper; the phase is also inside the
authenticated ciphertext. The old envelope parser and old intake reject that
wrapper. The new opener validates exact phase/challenge, source/time/provenance,
observation shape, recomputed normalization and no promotion before invoking its
nonce-consumption seam. It checks lifetimes again after the nonce wait. It is a
crypto decoder for diagnostic data, **not** central SQL intake or a capability.

## Non-authority and lifetime

Every accepted payload is `NONAUTHORITY`, `AUTHENTIC_FREEZING_ACQUISITION`,
`exclusion: NOT_PROVEN`, `finalImportEligible: false`. Even a subsequently proven
fence cannot promote this candidate to FINAL_FROZEN. Final acquisition needs a
separate fresh Google reconsent, a newly bound acquisition and successful grant
revocation/clearing. Historical start receipts do not replace that consent.

`observedAt` describes a local status observation, never a lease. A day-old
`disabledAt` is preserved verbatim, not renewed or relaxed through the old
five-minute writer attestation validator. Human writers, other credentials,
fleet/old deployments and in-flight drain remain unproven. Current control has
no maintained-exclusion mechanism; NOT_PROVEN cannot be switched off by a flag.

Request/envelope expiry never exceeds the original challenge expiry. All
freshness checks use `issuedAt <= now < expiresAt`, without skew extension.
The existing crypto codec additionally requires at least 1,000ms remaining for
sealing. Source adapters retain their existing bounded response/time limits;
checks after each awaited source operation prevent a late capture from sealing.
This does not guarantee cancellation of an already admitted external read.

## Explicit production seams and remaining gates

- `FreezingReacquisitionReservations.reserveAndCommit` must perform durable,
  globally unique nonce **and** challenge reservation, immutable INSERT, exact
  readback and acknowledged COMMIT with no retry. Tests use an in-memory fixture,
  not production durability. The new purpose/start-bound row is incompatible
  with the old SQL adapter; do not cast it to an old reservation or lie about
  its purpose. Cross-phase global challenge uniqueness requires the subsequent
  durable adapter design and separate-connection PostgreSQL proof.
- The Sheets reader is a server-composition-only low-level adapter. A production
  credential/reader factory and durable replay root have not been wired.
- Central bootstrap/CSRF/current Google session and OWNER/ADMIN authorization,
  challenge issuance, exact FREEZING/start/PREFLIGHT/source lock/rechecks,
  acknowledged dispatch, SQL intake, immutable candidate audit storage/readback,
  canonical routes/factory, archival reads and UI remain to be implemented.
- Production SQL/ORM parity, forced RLS, real PostgreSQL concurrency/ACK/clock
  gates, independent specification/security review and parent-owned full suite
  and build remain separate gates.

## Verification scope

Local fixtures replace only low-level control/Redis transport, workbook reads
and replay storage. The real producer, snapshot acquisition, redactor,
normalizer, signing/encryption and opening paths run. These fixtures prove no
live source state, real PostgreSQL durability or central membership.

Focused test evidence and exact frozen source hashes live in the task cache
`task19-freezing-reacquisition/producer-core/`. No live Google, Redis or control
endpoint was invoked for this work. No registration provisioning or operational
action is authorized by this document.
