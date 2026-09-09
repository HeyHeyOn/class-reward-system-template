# FREEZING start ceremony checkpoint

## Status and stop line

This slice implements explicit pending intent, purpose-separated authenticated callback continuation, and an acknowledged one-dispatch reservation. **It does not commit READY → FREEZING.** Production start routes, production start factory configuration, authentic response consumption and the final atomic start consumer remain integration gates. The [durable companion producer](migration-bridge-producer.md) now supplies the fixed authenticated route, deployment-local credential factory and replay SQL adapter, but no live registration or invocation is enabled by this code change. The ordinary production consent factory remains consent-only; there is no enabled production writer-disable call in this checkpoint.

A local synthetic transport response is not a verified bridge acquisition. `BRIDGE_RESPONDED_START_NOT_COMMITTED` is deliberately not `FREEZING`, `STARTED`, `FINAL_FROZEN`, or writer-exclusion evidence. Existing job/tenant/acquisition/global claim state is not changed by dispatch. Maintained writer exclusion remains `NOT_PROVEN`.

## Explicit confirmation, not receipt promotion

- A server-owned `StartFreezingRegistration` binds tenant, source, exact raw spreadsheet ID, deployment ID, registration version and registration digest. The registration digest must match the actual registered client's configuration. No browser endpoint, key, reader, writer control or provider credential is accepted.
- In configured start mode, consent challenge issuance and `migration_start_intents` insertion/readback are in the same transaction. The immutable intent binds the exact consent challenge digest/session, semantic fingerprint, source acquisition digest, exact PREFLIGHT identity/digest and displayed action `DISABLE_LOCAL_WRITER_AND_START_FREEZING`. Automatic enable is explicitly false.
- Ceremony ID equals the newly issued consent challenge ID. The TTL is exactly 300 seconds from that challenge's DB issuance timestamp. Confirmation, OAuth and bridge issuance never renew it. Standalone approval and bridge lifetimes remain 60 seconds.
- The actual same-origin POST requires the issued synchronizer and exact full `display`. Consent confirmation and start confirmation share one acknowledged transaction. Start confirmation binds the exact OAuth state digest and immutable intent digest.
- The encrypted routing cookie retains the existing host-only, `/api/`, HttpOnly/Secure/SameSite=Lax design, with a separate start-purpose key derivation and AAD. Start hints also bind intent digest. The canonical directory, exact challenge/intent and current session rebind the hint; a consent-only cookie cannot be promoted, even if a pending row exists.
- The existing consent acquisition purpose and narrow `CONSENT_AND_SHEET_CAPTURE_ONLY` receipt remain unchanged. Only a fresh configured start callback, after acknowledged reservation, real provider verification/capture, revoke+clear and capture COMMIT ACK, obtains additional private start metadata. The metadata has no public mint/recovery setter. IDs, JSON, archived captures and ordinary live consent fail the registry check.
- `continueStart` is awaited before responding, never scheduled as a detached task. The ordinary consent callback still returns only `CAPTURED` and its narrow scope.

## Dispatch boundary

`StartFreezingBridgeAdapter.prepare(intent)` must issue a fresh real bridge challenge and prepare/sign the exact request **without contacting the producer**. It returns `challenge`, `requestDigest` and single-use `send()`; the registered client's prepared request can be composed with this seam. Its send result must be `{outcome:'RECEIVED', manifest}` or a terminal uncertain/not-sent outcome.

The orchestrator checks private start metadata before its first await, detaches request/configuration and reuses the consent intake's real READ COMMITTED tenant → job → source FOR UPDATE → current membership/session/PREFLIGHT checks. It records a DB-clock lower bound after consent ACK before bridge preparation, preventing substitution of a pre-consent challenge. The prepared challenge must match source, actor, state/version, independent fingerprints and registered deployment.

Before send, a short transaction freshly revalidates the entire consent/start binding, reads the exact durable bridge challenge, inserts the unique ceremony → bridge challenge + registration digest + request digest reservation, verifies exact readback and checks clocks again. Only an acknowledged COMMIT permits the next step. Another short current-membership/session/TTL check follows immediately before send; no transaction spans producer work.

`migration_start_dispatches` has globally unique ceremony and bridge challenge dimensions, references the start confirmation, acknowledged consent capture and bridge challenge, and is immutable under UPDATE/DELETE/TRUNCATE with forced tenant RLS. Duplicate or uncertain reservation ACK never sends. Network timeout, a registered client `UNKNOWN` result, or failed post-send revalidation remains terminal `UNKNOWN`, preserves the reservation and never retries or automatically enables the writer. A transport response remains unverified until the separate authentic intake accepts it.

## Verification scope

Local tests execute all production SQL migrations under the restricted PGlite runtime, real Google OAuth cryptographic verification against synthetic signed provider transport, real workbook capture/cleanup and actual normalization/import/READY generation. Dispatch tests issue real bridge challenges and exercise the adapter boundary with local synthetic send results. SQL/Drizzle column, constraint, check and FK parity is verified for all three new relations; forced RLS and immutability are exercised.

These tests do not establish separate-connection PostgreSQL races, actual production configuration, registered producer replay durability, canonical production start route exports, a browser confirmation UI, authentic complete-pair consumption or the final atomic FREEZING transition. Existing immutable evidence and old migration SQL are not rewritten. Parent deletion across the new retained FKs is intentionally blocked; retention requires separate approval.
