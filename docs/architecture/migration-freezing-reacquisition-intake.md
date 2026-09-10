# FREEZING diagnostic reacquisition: bounded central intake

## Status and stop line

`createFreezingReacquisitionIntake` is an internal HTTP-handler composition root with explicitly injected **server-owned** canonical tenant/job/path, signing/verification configuration, and a transaction runner. Its bootstrap/challenge/confirm/status methods are exercised against restricted local SQL, the real registered companion producer, durable producer reservations, and real cryptography. It is **not exported from canonical central Next routes**, does not include a central environment/configuration factory, and has no browser UI. Do not call this full Task19 completion or deployed functionality.

Every candidate is permanently `NONAUTHORITY`, `NOT_PROVEN`, and `finalImportEligible: false`. Even a later proven fence cannot promote this candidate to `FINAL_FROZEN`. Final acquisition requires separate fresh purpose-bound Google consent, a newly bound Sheet/Redis acquisition, and grant revoke/clear. No importer, activation, fence, ACL change, writer disable or auto-enable is added here.

## Current internal HTTP contract

The composition's `canonicalPath` must be `/api/c/<canonical-slug>/migrations/<job-UUID>/freezing/reacquisition`. The canonical tenant must come from trusted directory resolution; dependency injection is not browser authority.

- `GET <path>/bootstrap`: current Google identity and current OWNER/ADMIN, actual `Sec-Fetch-Site: same-origin`, and absent or exact Origin. Returns a random synchronizer and an authenticated purpose/tenant/job/actor/original-session/digest/time-bound cookie. HttpOnly, Secure, SameSite=Strict, host-only, exact path, 60-second original lifetime. No challenge INSERT or outbound request.
- `POST <path>/challenge`: exact Origin, same-origin Fetch Metadata, JSON `{}`, original authenticated bootstrap cookie and `x-csrf-token`. Stores a new immutable SQL challenge and a **distinct confirmation synchronizer digest**. Returns the exact display and intent digest. Clears the cookie using the identical Path. Cookie clearing is not durable one-use enforcement.
- `POST <path>`: exact `{challengeId, display}` and confirmation `x-csrf-token`. SQL reservation and exact readback must acknowledge COMMIT before one bounded signed request to `/api/internal/migrations/freezing-reacquisition`. No transaction spans transport. No automatic retry.
- `GET <path>/<challengeId>`: exact `x-reacquisition-intent-digest`, original actor/session and current membership; returns archival facts only. Absent candidate means UNKNOWN, not proof of no external read. No sends, token exchange or capability mint.

All handler responses are `no-store`. POST request bytes are bounded before JSON parsing. Non-success/redirect/oversized/expired transport responses fail closed. Unknown reservation or capture acknowledgements are conservatively UNKNOWN, never permission to resend.

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
- The central positive uses actual production start exports/factory with synthetic low-level provider transport; reacquisition uses actual internal handlers, real registered producer core and durable SQL adapter with a low-level workbook reader fixture. The existing full companion production-root suite passes separately; **one joined central canonical-export-to-full-companion-root test is not present**.
- Local SQL uses PGlite runtime roles without owner/BYPASSRLS authority for central intake; import setup uses the harness administrator. Owner DML/TRUNCATE refusal, runtime tenant isolation, SQL/ORM columns/PK/UNIQUE/FK/CHECK parity, unchanged-data upgrade, old/new nonce replay, INSERT suppression, real-COMMIT simulated ACK loss and committed-fact recovery are covered.
- Independent specification and security reviews passed for this bounded internal intake. Valid independent binding swaps, separate semantic/acquisition drift, exact-zero/two PREFLIGHT cardinality at issuance/presend/response, and isolated login-session expiry before send/precommit/after ACK are covered. Post-ACK session expiry preserves committed diagnostic evidence but returns UNKNOWN; expired-login archival access is denied.
- Expiry probes inject the clock at nonce INSERT and actual dispatch/candidate COMMIT acknowledgement. They are not real elapsed-time PostgreSQL lock-wait probes or packet-loss experiments.

Still required before broader completion: central canonical exports/config factory/route inventories and UI; joined full production-root positive; independent PostgreSQL same-challenge/nonce and membership/source/PREFLIGHT lock races;  parent-owned full inventory/build/browser gates. The archival method currently belongs to the configured internal factory; a key-independent archival production root is also deferred. Runtime grants/provisioning are deliberately not installed by the migration.

No live Google, Sheet, Redis, control-plane, deployment, credential/ACL mutation, final import or activation was performed.
