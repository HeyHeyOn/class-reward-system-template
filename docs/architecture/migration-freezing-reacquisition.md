# FREEZING reacquisition: executable companion production root

The fixed signed internal POST and deployment-local production dependency factory
are implemented, including durable SQL reservation and real read-only capture.
This is **not** the complete central FREEZING reacquisition flow: central challenge
issuance, current-member authorization and immutable candidate intake/storage are
still deferred. An internal companion endpoint is not a canonical tenant API.

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

There is no disable POST, enable, ACL mutation, consent-code exchange/revocation, import,
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

## Production composition and configuration

`freezingReacquisitionProduction.ts#getProductionFreezingReacquisitionProducer`
constructs `createFreezingProducerReservations` and the actual exported core
`createRegisteredFreezingReacquisition`. The fixed route exports only POST and
Node runtime, preserves the body stream, and returns generic no-store refusals.
The inventory classifies it as a platform mutation because of its durable replay
INSERT, separately from both tenant authority and the old disable-capture route.

The new **server-owned** `CLASS_STORE_FREEZING_PRODUCER_REGISTRATION` is exact JSON:
`endpoint`, `deploymentId`, `registrationVersion`, `registrationDigest`,
`approvedScope`, `tenantId`, `sourceId`, `spreadsheetId`, `requestKeyId`,
`requestPublicKey`, `manifestPublicKey`, `writerPublicKey`. Its scope must be
`READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE`; endpoint must use the new fixed
path. The old `CLASS_STORE_BRIDGE_PRODUCER_REGISTRATION` is never a fallback, and
its old scope and producer bytes remain unchanged. PEM public keys must resolve
to distinct Ed25519 request/manifest/writer purposes. The configured manifest
private key must match the registered manifest public key.

This existing companion deployment must independently provision:

- `CLASS_STORE_STORAGE=sheets` and exact registered `GOOGLE_SHEET_ID`.
- `CLASS_STORE_BRIDGE_PRODUCER_DATABASE_URL`: dedicated companion SQL, never the
  tenant/default pool. URL role must equal deploymentId, within PostgreSQL's
  identifier byte limit. Runtime verifies actual nonowner/NOSUPERUSER/NOBYPASSRLS,
  forced RLS, READ COMMITTED, SELECT/INSERT and acknowledged exact readback.
  All applicable migrations, including 0022, and explicit least-privilege grants
  must already be present. This code performs no provisioning.
- Existing `CLASS_STORE_BRIDGE_MANIFEST_KEY_ID`,
  `CLASS_STORE_BRIDGE_MANIFEST_PRIVATE_KEY` and canonical 32-byte base64
  `CLASS_STORE_BRIDGE_MANIFEST_ENCRYPTION_KEY`. Encryption is HKDF purpose-bound
  by the new core, not reuse of the old ciphertext domain.
- Existing deployment `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REFRESH_TOKEN`: the actual `createDeploymentSheetsAuth` root, not a
  browser cookie, Authorization header, temporary migration grant, service
  account or central credential fallback. Durable refresh is necessary for this
  reader; no authorization-code consent or credential mutation/revocation is
  performed. SDK refresh responses are streamed and capped at 128,000 decoded
  bytes with a 10-second deadline, no redirects and explicit zero retries.
- Server-allowlisted HTTPS `LEGACY_REDIS_WRITER_CONTROL_URL` plus token, and
  `UPSTASH_REDIS_REST_URL` plus token. Missing/malformed configuration is rejected
  before reservation or any GET. Existing low-level control/Redis response caps,
  timeouts, no-redirect/no-store and credential omission remain in force. Only
  tests allow loopback HTTP for control and companion ingress.

The root does not require or use a writer-disable private key. Writer public-key
purpose separation is registration binding, not proof of maintained exclusion.
The companion verifies signed actor/session/start bindings, not central current
membership or existence of a historical start row.

Requests cannot supply endpoints, credentials, keys or callback readers. Cookie,
Authorization, Origin and Referer headers are refused. Signed body bytes are
bounded at 8,192 before JSON decoding; no upstream body materialization occurs.
Reservation COMMIT ACK is required before the first control GET. Timeouts, lost
ACKs and duplicate challenges have no automatic retry or archival recovery.

## Remaining gates

Central bootstrap/CSRF/current Google session and OWNER/ADMIN authorization,
challenge issuance, exact FREEZING/start/PREFLIGHT/source lock/rechecks,
acknowledged dispatch, SQL intake, immutable candidate audit storage/readback,
canonical routes/factory, archival reads and UI remain to be implemented.
No maintained writer exclusion, FINAL_FROZEN selection, final import, reconciliation
or activation authority is established by this companion root.

## Verification scope

The production composition fixture runs the actual exported route, factory,
installed OAuth SDK transport, restricted PGlite SQL with every migration,
producer, source acquisition, redactor, normalizer and crypto-open. Only low-level
pool/HTTP responses are synthetic. It captures nonempty Redis tombstones and
Sheet rows, then a separate candidate with an added row/new revision. It checks
COMMIT-before-GET, ACL/role denial, suppressed INSERT, lost/stalled ACK, replay,
original expiry, exact body caps, registration/key/phase confusion and bounded
refresh transport. PGlite tests are local serialized SQL, not independent
PostgreSQL connection races or real deployment provisioning.

Archived RED/GREEN reports, exact source copies and SHA-256 manifests are under
`task19-freezing-reacquisition/producer-production/` in the active task cache.
The first RED uses an explicitly throwing missing-production module seam and
calls the factory directly; a route HTTP sentinel is not its behavioral proof.
Additional tests that immediately passed are regression coverage, not claimed
as missing-feature RED. Earlier core/durability evidence remains historical.
No live Google, Redis or control endpoint, registration provisioning, deployment,
import, enable/disable, credential mutation or activation was performed.
