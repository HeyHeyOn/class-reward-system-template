# Durable final-bridge companion producer

## Implemented boundary

`POST /api/internal/migrations/final-bridge` is a fixed, Node-runtime companion ingress. It calls `getProductionBridgeProducer()` without passing browser configuration. The existing registered-request verifier authenticates Ed25519 purpose, POST/path, exact endpoint, audience deployment, registration version/digest, ceremony/challenge, body digest, nonce and lifetime before reserving anything. Cookies and Authorization headers are not companion authority. The route preserves the request stream; the verifier bounds it before decoding. Every application response is generic and `no-store`.

The server factory composes the production PostgreSQL reservation adapter, the deployment's durable Google credential and bounded workbook reader, and the existing `runLegacyMigrationBridge`. It does not replace the producer with a success stub. The existing ordering remains:

1. Authenticate and detach the request.
2. Insert the nonce **and** challenge tombstone, read back all supplied fields, recheck the actual database clock, and acknowledge COMMIT.
3. Recheck request cancellation and expiry, then disable the registered local writer.
4. Read back the disabled generation, capture Redis and Sheets, read back the same disabled generation again, then seal.

This proves an observation of the registered local deployment only. It does **not** establish maintained exclusion of older instances, in-flight work, schedulers, humans or other credential holders. It grants no `FINAL_FROZEN`, `ACTIVE` or tenant lifecycle authority. The consumer still has to cryptographically authenticate the returned manifest and consume its own durable intake nonce. Writer exclusion remains `NOT_PROVEN`.

## Explicit server-only configuration

Nothing is provisioned or enabled automatically. Missing or invalid configuration produces a generic refusal, without a public configuration stub. Live configuration, credential provisioning and invocation require separate approval for the exact deployment's disable scope.

- `CLASS_STORE_STORAGE=sheets`: this is the legacy companion, not the tenant PostgreSQL application.
- `CLASS_STORE_BRIDGE_PRODUCER_REGISTRATION`: one JSON object, at most 16,384 UTF-8 bytes, with exactly the fields below. No array, request-selected registration or fallback.
  - `endpoint`: the exact canonical HTTPS URL ending in `/api/internal/migrations/final-bridge`; no query, fragment, userinfo or redirects. Only test mode accepts loopback HTTP.
  - `deploymentId`, `registrationVersion`, `registrationDigest`, `tenantId`, `sourceId`, `spreadsheetId`.
  - `approvedScope`: exactly `DISABLE_LOCAL_WRITER_AND_START_FREEZING`.
  - `requestKeyId`, `requestPublicKey`, `manifestPublicKey`, `writerPublicKey`. Public keys are PEM Ed25519 keys; all three purposes must be distinct.
- `CLASS_STORE_BRIDGE_PRODUCER_DATABASE_URL`: dedicated companion PostgreSQL login, never a fallback to `DATABASE_URL`/the tenant pool. The decoded login name must **exactly equal** `deploymentId`. This concrete deployment-role binding supports deployment IDs of at most **63 UTF-8 bytes**, without truncation or normalization. Longer existing IDs must be explicitly re-registered under a supported identifier or use a separately reviewed authority design; they are not silently repaired.
- `CLASS_STORE_BRIDGE_MANIFEST_KEY_ID`, `CLASS_STORE_BRIDGE_MANIFEST_PRIVATE_KEY`, `CLASS_STORE_BRIDGE_MANIFEST_ENCRYPTION_KEY`: the corresponding manifest signing key and a canonical base64-encoded 32-byte encryption key. The producer has no request-signing private key.
- `GOOGLE_SHEET_ID`: exact equality with the registered raw `spreadsheetId`.
- Existing deployment-owned `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`: the **durable deployment** credential path already used by the legacy Sheets app. The bridge deliberately supports this explicit path only; there is no service-account, generator, session-cookie or ephemeral-consent fallback. The credential needs permission to read the registered workbook and Drive file version. Token scopes/permissions are not expanded or provisioned by this factory.
- Existing `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `LEGACY_REDIS_WRITER_CONTROL_URL`, `LEGACY_REDIS_WRITER_CONTROL_TOKEN`, and `CLASS_STORE_REDIS_WRITER_DISABLE_KEY_ID/PUBLIC_KEY/PRIVATE_KEY` remain the existing local control/capture facilities. The request cannot supply their URLs, keys, callbacks or readers. Writer signing keys must match the registered writer-purpose public key before reservation/disable.

The workbook reader's explicit acquisition deadline is not a newly issued consent lifetime. The durable credential is neither passed from the browser nor reconstructed from a revoked consent token. Refresh response JSON is independently streamed and capped at 128,000 bytes; SDK retries and redirects are disabled. The workbook adapter retains its existing byte, deadline, revision and double-pass limits.

The dedicated pool is bounded and lazily created. A connection-string change within a warm process refuses rather than mixing pooled authority; credential changes require a process restart. Rotations must preserve the **same permanent replay database**, including its backups and tombstones. Changing databases is not a supported replay reset.

## SQL authority and provisioning contract

Additive migration `0020_bridge_producer_reservations.sql` and the Drizzle `bridgeProducer.ts` mirror define the permanent relation. No applied migration is edited. The relation intentionally has no tenant/source foreign keys or cascade path: tenant removal cannot erase replay history.

- Global primary key: purpose-framed `nonce_digest`, independent of tenant, deployment or signing-key rotation.
- Independent global unique constraint: `challenge_id`; a fresh nonce cannot revive an old challenge.
- Exact immutable ceremony/deployment/registration/request/lifetime fields and a database-created timestamp.
- Forced RLS permits SELECT and INSERT only when `deployment_id = current_user::text`. No caller-set tenant/deployment GUC determines authority. A role can observe only its own rows, while the unique indexes reject cross-deployment replay without exposing other rows.
- UPDATE/DELETE are unconditionally rejected by row triggers; TRUNCATE is rejected by a statement trigger. No expiry pruning, conflict-as-success, repair or replay recovery is provided.

A trusted administrator must apply migrations as a separate owner, then separately provision a dedicated exact-deployment login with `NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION`, **no role memberships**, schema USAGE and **only SELECT/INSERT on this relation**. Do not make the runtime login the table owner. Do not grant it tenant-table SELECT, general table UPDATE/DELETE/TRUNCATE, schema CREATE, role switching, or migration-owner membership. Conversely, do not grant this relation to the ordinary tenant runtime. No blanket grant is executed by the migration.

The adapter checks the actual principal, non-owner/non-superuser/non-BYPASSRLS role, enabled forced RLS, and actual `READ COMMITTED` isolation before INSERT. It opens an explicitly READ COMMITTED transaction, uses hard uniqueness without retry, compares exact readback, and checks `clock_timestamp()` after possible lock waits. Only an acknowledged COMMIT returns a reservation. Lost BEGIN/COMMIT acknowledgement or rollback failure discards the physical connection. A successful later ROLLBACK does not turn an uncertain COMMIT into permission.

## Failure and replay behavior

- Authentication/configuration/SQL/readback/expiry/cancellation failures before disable do not execute the writer operation.
- An uncertain reservation COMMIT can leave a permanent row even though no disable occurred. Never recover that row into success or resend the request.
- Any failure or timeout after possible disable is `UNKNOWN`; automatic re-enable is forbidden. Committed tombstones remain even if later capture fails.
- Any future status API must be exact, read-only and archival. No status/receipt lookup may call the reservation method or re-execute the producer.
- This route is a platform companion mutation in both method inventories, not a tenant route and not an ordinary legacy Sheets write. Its explicit authenticated local-disable operation is separate from the presentation/per-request `MIGRATION_READ_ONLY` compatibility flag.

## Local verification and remaining gates

The production-composition tests exercise the actual route export, factory, production SQL and existing producer through a signed localhost client. Only SQL/provider/control/Redis transports and pool lifecycle attachment are substituted in the Vitest fixture; no producer, factory or successful seal verifier is mocked. Independent isolated PostgreSQL probes additionally exercise actual node-postgres restricted logins, observed cross-role nonce/challenge lock contention, COMMIT-ACK-loss connection discard, and database-clock expiry after a real lock wait. A separate real-PostgreSQL localhost vertical probe verifies committed-row visibility and absence of a transaction during external transport work before the synthetic disable.

All provider data and credentials in these tests are synthetic. They do not demonstrate live provider permissions, operational writer exclusion, deployment provisioning or READY→FREEZING consumer completion. Full-project verification and independent specification/security review remain parent gates. Actual deployment calls and configuration changes remain explicitly out of scope.
