# Freezing consent HTTP composition (acquisition only)

This surface records fresh user consent and a bounded, stable Google Sheet acquisition. It does **not** start FREEZING, disable writers, prove writer exclusion, import a delta, activate a tenant, or recover execution authority from archival rows.

## Configuration and provisioning

Existing isolated `MIGRATION_GOOGLE_CLIENT_ID`, `MIGRATION_GOOGLE_CLIENT_SECRET`, `MIGRATION_GOOGLE_OAUTH_ORIGIN`, and existing login `AUTH_SECRET` are required. `CLASS_STORE_STORAGE` must be exactly `postgresql`. The origin must be an exact HTTPS origin (no trailing slash, path, query or fragment).

`MIGRATION_GOOGLE_SHEET_REGISTRATIONS` is explicit server-owned JSON configuration:

```json
[{"tenantId":"20000000-0000-4000-8000-000000000001","sourceId":"registered-source-id","spreadsheetId":"registered-raw-sheet-id"}]
```

These are illustrative identifiers, not live registrations. Each row has exactly those three keys; tenant/source pairs must be unique. This is the existing intake's raw-ID registration input, not a new ownership proof. The intake independently compares SHA256(raw Sheet ID) to the stored source identity and requires the exact current job/source/preflight binding. No request can supply a registration, reader, token, origin, or endpoint. Missing/ambiguous configuration fails closed without using a deployment-global Sheet or token.

Runtime database provisioning remains an explicit operator gate: use a nonowner `NOSUPERUSER NOBYPASSRLS` role, exact platform slug discovery EXECUTE, existing tenant/job/source/membership lock privileges, and SELECT/INSERT only on the immutable `0018` consent relations. No live provisioning or OAuth-console registration was performed in this change. The production runner uses READ COMMITTED, one attempt, acknowledged commits, and discards connections whose COMMIT acknowledgement fails.

## Ceremony

1. `POST /api/c/[slug]/migrations/[jobId]/freezing/consent/challenge`
   - Exact JSON: `{ "expectedStateVersion": "1", "sourceId": "registered-source-id" }`.
   - Requires an actual Google login cookie, current DB canonical user/email and OWNER/ADMIN membership, exact READY source/preflight, exact `Origin`, `Content-Type: application/json`, and absent or same-origin Fetch Metadata.
   - Returns the immutable challenge ID, random session-bound synchronizer token (`csrfToken`), exact registered Sheet/display bindings and expiration. This is display/CSRF issuance, not consent confirmation.
2. `POST /api/c/[slug]/migrations/[jobId]/freezing/consent`
   - Exact JSON: `{ "challengeId": "issued-challenge-id" }` and `X-CSRF-Token: <issued csrfToken>`.
   - Retain cookies and the exact Origin/content-type. No query string is permitted on either POST.
   - Returns `{ "authorizationUrl": "https://accounts.google.com/..." }` after acknowledged durable confirmation. Navigate explicitly to this URL; no code or provider token is in this response.
3. `GET /api/migrations/google-sheets/callback`
   - Fixed existing isolated-client callback, not a tenant-query endpoint.
   - Authenticated encrypted routing hints are rebound through exact canonical slug discovery and immutable tenant-scoped challenge lookup before the real service reserves the callback.
   - Singleton `scope`, `authuser`, and `prompt` are informational only. `code` and `state` are validated by the service. Unknown or duplicate query keys, code+error, and orphan error metadata are refused.
   - A singleton error callback with valid session/state/routing binding consumes a terminal attempt without provider exchange. Error descriptions and error URLs are never reflected, persisted or logged. Re-consent requires a new ceremony.
   - Success returns only `{ "challengeId": "...", "status": "CAPTURED", "scope": "CONSENT_AND_SHEET_CAPTURE_ONLY" }`. The server-only handle is never serialized; no report, token, acquisition, private capability, or recoverable authority is returned. CAPTURED does not imply that normalization is unblocked or that freezing is authorized.

All responses, including canonical directory failures, use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Errors are generic. Direct unscoped POST handlers fail without request-local canonical tenant context. The dispatcher uses its trusted context rather than reconstructing a slug from the rewritten URL. Its generic compatibility-admin fallback is not authority for this surface.

The host-only `__Secure-class_store_freezing_route` cookie uses AES-256-GCM with a purpose/origin-derived key and dedicated authenticated domain, `HttpOnly; Secure; SameSite=Lax; Path=/api/`, and at most the remaining five-minute challenge lifetime. `/api/` covers both canonical POSTs and the fixed callback. It contains routing/session/state hints, not provider credentials. Clearing it is browser cleanup, not replay protection; SQL attempts enforce terminal use across instances. A second ceremony in the same browser replaces the hint, so an older tab fails closed and must restart rather than silently switching tenants.

## Verified and deferred boundaries

Local composition tests exercise actual Next route exports, canonical directory discovery, the production factory/transaction runner against production SQL under a restricted PGlite role, real RSA ID-token verification/tokeninfo, the real workbook reader, capture, normalizer, and immutable readback. Only the pool transport and Google provider transport are local synthetic adapters. One positive path starts from real normalization/import/READY rather than only seeded READY rows.

No external Google account, Sheet, deployment, writer control, freeze or activation was accessed. PGlite overlap and rollback are not separate-connection PostgreSQL locking evidence. Independent SPEC/security-quality review, parent full-suite/build verification, real PostgreSQL race evidence and runtime provisioning remain separate gates.
