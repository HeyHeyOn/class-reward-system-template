# FREEZING diagnostic reacquisition: bounded central intake

## Status and stop line

`createFreezingReacquisitionIntake` is the canonical tenant-bound HTTP composition, now installed through `freezingReacquisitionCentralProduction.ts` and four central Next target exports. The `/api/c/[slug]/[...path]` dispatcher resolves the current canonical directory and preserves these handlers' canonical URLs instead of rewriting them to unscoped legacy paths. The handlers independently require current Google identity plus OWNER/ADMIN; generic compatibility-admin fallback is not authority. No browser UI, provisioning or deployment is included. Do not call this full Task19 completion.

Every candidate is permanently `NONAUTHORITY`, `NOT_PROVEN`, and `finalImportEligible: false`. Even a later proven fence cannot promote this candidate to `FINAL_FROZEN`. Final acquisition requires separate fresh purpose-bound Google consent, a newly bound Sheet/Redis acquisition, and grant revoke/clear. No importer, activation, fence, ACL change, writer disable or auto-enable is added here.

## Canonical HTTP contract

The composition's `canonicalPath` must be `/api/c/<canonical-slug>/migrations/<job-UUID>/freezing/reacquisition`. The canonical tenant must come from trusted directory resolution; dependency injection is not browser authority.

- `GET <path>/bootstrap`: current Google identity and current OWNER/ADMIN, actual `Sec-Fetch-Site: same-origin`, and absent or exact Origin. Returns a random synchronizer and an authenticated purpose/tenant/job/actor/original-session/digest/time-bound cookie. HttpOnly, Secure, SameSite=Strict, host-only, exact path, 60-second original lifetime. No challenge INSERT or outbound request.
- `POST <path>/challenge`: exact Origin, same-origin Fetch Metadata, JSON `{}`, original authenticated bootstrap cookie and `x-csrf-token`. Stores a new immutable SQL challenge and a **distinct confirmation synchronizer digest**. Returns the exact display and intent digest. Clears the cookie using the identical Path. Cookie clearing is not durable one-use enforcement.
- `POST <path>`: exact `{challengeId, display}` and confirmation `x-csrf-token`. SQL reservation and exact readback must acknowledge COMMIT before one bounded signed request to `/api/internal/migrations/freezing-reacquisition`. No transaction spans transport. No automatic retry.
- `GET <path>/<challengeId>`: exact `x-reacquisition-intent-digest`, original actor/session and current membership; returns archival facts only. Absent candidate means UNKNOWN, not proof of no external read. No sends, token exchange or capability mint.

All handler responses and canonical directory/method refusals are `no-store`. Canonical POST request bytes are capped at 8,192 with a five-second read deadline before directory SQL or JSON parsing, including absent/false Content-Length and unauthenticated streams. The internal handler retains its own cap. Cancellation occurs upon the first over-limit chunk; that incoming chunk exists transiently, but it is not retained in the bounded buffer. Non-success/redirect/oversized/expired transport responses fail closed. Unknown reservation or capture acknowledgements are conservatively UNKNOWN, never permission to resend.

## Server-owned production configuration

The central factory requires `CLASS_STORE_STORAGE=postgresql`, the existing explicit HTTPS `MIGRATION_GOOGLE_OAUTH_ORIGIN`, `AUTH_SECRET`, current canonical SQL directory, and exact `MIGRATION_GOOGLE_SHEET_REGISTRATIONS`. It uses the existing single-attempt READ COMMITTED runner. It does not exchange or acquire Google credentials.

`MIGRATION_FREEZING_REACQUISITION_REGISTRATIONS` is a bounded JSON array, exactly one registration per tenant. Each row has exactly:

- `tenantId`, `sourceId`, `spreadsheetId`, `deploymentId`, `registrationVersion`;
- `endpoint` ending at the exact `/api/internal/migrations/freezing-reacquisition` path;
- `approvedScope: READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE`;
- `requestKeyId`, `requestPublicKey`, `requestPrivateKey`;
- `manifestKeyId`, `manifestPublicKey`, `writerKeyId`, `writerPublicKey`;
- `encryptionKey`: canonical base64 of 32 explicitly provisioned bytes.

The three public keys must be distinct Ed25519 keys, request private/public keys must match, and key IDs must be distinct. No old start registration, deployment-global Sheet, OAuth grant, missing key or alternate endpoint fallback exists. The registration digest is SHA256 of canonical JSON containing purpose `CLASS_STORE_FREEZING_REACQUISITION_CONFIGURATION_V1` and the public fields above, with SPKI DER/base64 public keys, excluding request private key and raw encryption key, including `encryptionKeyDigest = SHA256(base64EncryptionKey)`. Provision the companion's existing `CLASS_STORE_FREEZING_PRODUCER_REGISTRATION` with the same digest and matching read configuration **before** receiving any request; the request's own digest is not registration authority. Companion manifest credentials must match the explicitly provisioned central read registration. Provisioning is not performed here.

`getProductionFreezingReacquisitionStatus` deliberately does not load either read/start registrations, Sheet registrations, signing/encryption keys or Google resource credentials. It requires canonical tenant context, configured HTTPS origin, ordinary login authentication and SQL access. The shared archival reader revalidates current OWNER/ADMIN and the original session/actor, exact job/challenge and intent digest, complete stored display plus raw-Sheet digest, and candidate/audit consistency. It neither requires unexpired acquisition approval nor revives it. Missing candidate remains UNKNOWN, and there is no network send or capability mint.

The route inventories now classify 66 concrete method exports: 19 tenant reads, 34 tenant mutations, 11 platform methods and 2 unsupported methods. Bootstrap is a nonexecuting cookie response (no durable challenge INSERT); challenge and confirmation are mutations. The configured mutation authority count is 19, leaving the unchanged 15 direct-Sheets mutation routes. Legacy write-freeze inventory distinguishes bootstrap-cookie, archival-read, challenge and confirmation effects rather than treating them as legacy writes.

## SQL and provenance

Additive migration `0023_freezing_reacquisition_intake.sql` introduces immutable, forced-RLS challenge/dispatch/candidate relations. Existing applied migrations are unchanged. Central `migration_bridge_consumptions` receives a nullable new-phase binding alongside the retained original nullable old-phase binding, with an exclusive phase CHECK and exact candidate `(nonce, tenant, challenge)` FK. Old INSERT defaults and every old row are retained. The global nonce PK is shared across central phases using the original raw-nonce digest framing. The deployment-local producer ledger remains separate.

Current binding checks require actual READ COMMITTED, tenant IMPORTING, job FREEZING with exact state version, started timestamp and null final fields, registered raw-Sheet digest, original semantic and acquisition digests, exact-one original PREFLIGHT, and exact STARTED execution/audit digest. Lock order is tenant → job → source FOR UPDATE → current actor/membership; immutable PREFLIGHT and start evidence are read after locks. Session/membership/binding and clocks are rechecked after waits, before send, after response, after candidate/nonce/audit writes/readbacks, and after final ACK. Revocation after send cannot promise cancellation of an already-started external read.

The real upstream importer uses `import:<manifestDigest>` PREFLIGHT identifiers, not UUIDs. The companion contract now accepts that bounded literal text without rewriting it. UUID ceremony/challenge/actor bindings retain their original validators.

The companion's real normalizer revalidates the complete Sheet/Redis pair; intake cryptographically opens and revalidates it again. Candidate audit separately links intent/request/envelope/start/normalization/Sheet/Redis/local-observation digests. Original sources, snapshots, grants, operational targets, checkpoints, claims and tombstones are not rewritten. Candidate insertion never changes job status/version or sets final fields. Normalization-blocked data remains diagnostic, never eligible for import.

## Verification and limits

Evidence resides under the active-profile cache `task19-freezing-reacquisition/central-intake/`:

- Genuine first RED executes the real start flow and fails on the deliberately missing central module; no HTTP-refusal sentinel substitutes for a missing implementation.
- PREFLIGHT diagnostic RED identifies the genuine producer/consumer ID incompatibility; its archived source includes logging added after the failing run and is not an exact-source RED replay.
- ORM-export RED and genuine old-phase-nonce FK acceptance RED are separately archived with source copies and SHA256 manifests.
- Central suite: 71 passing tests. Focused unchanged start/replay/companion/producer suites: 215 passing tests. Expanded negative tests that were already green are regression coverage, not claimed individual RED cycles.
- The historical internal-intake positive used real producer core with a low-level workbook reader fixture. The next central-production suite now joins actual canonical exports and both production factories through actual SQL ACK, real companion Google OAuth2/Gaxios refresh and workbook reads, local control GET → Redis/Sheets capture → control GET, crypto verification and immutable central candidate readback. Low-level SQL/SDK/HTTP fixtures replace transport only, with deny-by-default nonlocal network guards. The prerequisite still uses real normalize/import/READY and authenticated signed start/CAS; no seeded FREEZING status or fabricated candidate response.
- Local SQL uses PGlite runtime roles without owner/BYPASSRLS authority for central intake; import setup uses the harness administrator. Owner DML/TRUNCATE refusal, runtime tenant isolation, SQL/ORM columns/PK/UNIQUE/FK/CHECK parity, unchanged-data upgrade, old/new nonce replay, INSERT suppression, real-COMMIT simulated ACK loss and committed-fact recovery are covered.
- Independent specification and security reviews passed for this bounded internal intake. Valid independent binding swaps, separate semantic/acquisition drift, exact-zero/two PREFLIGHT cardinality at issuance/presend/response, and isolated login-session expiry before send/precommit/after ACK are covered. Post-ACK session expiry preserves committed diagnostic evidence but returns UNKNOWN; expired-login archival access is denied.
- Expiry probes inject the clock at nonce INSERT and actual dispatch/candidate COMMIT acknowledgement. They are not real elapsed-time PostgreSQL lock-wait probes or packet-loss experiments.

Central-production evidence is separately archived under `task19-freezing-reacquisition/central-production/`: missing-factory RED after real start, key-independent archival RED, canonical unauthenticated-stream cancellation RED, and exact route-inventory RED. Added guards that already passed are labeled regression coverage, not invented RED. The final handoff records frozen hashes and exact verification counts. The joined positive preserves populated unrelated claims/tombstones/operations, grant metadata, originals and operational data; an exact 8,192-byte confirmation succeeds, duplicate confirmation cannot resend, and ambiguous actual-COMMIT ACK/expiry outcomes remain UNKNOWN.

Still required before broader completion: independent SPEC then security/quality reviews, parent-owned complete inventory/build and deferred UI/browser gates. This new composition was tested with restricted PGlite runtime and companion roles, not new independent-connection PostgreSQL concurrency probes; earlier PostgreSQL evidence belongs to the prior unchanged intake boundary. Maintained writer exclusion, separate final fresh Google consent/acquisition, final import/reconciliation and activation remain unimplemented. Runtime grants/provisioning are deliberately not installed by the migration.

No live Google, Sheet, Redis, control-plane, deployment, credential/ACL mutation, final import or activation was performed.
