# PostgreSQL Multi-Tenant CRS Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace Google Sheets as the CRS operational source of truth with a central multi-tenant Neon PostgreSQL service, migrate existing individually deployed classes without data loss, and make checkout, task rewards, cancellations, and Padlet evidence claims transactional and idempotent.

**Architecture:** Keep current domain calculations and introduce explicit repository/command boundaries. Use tenant-scoped PostgreSQL tables for operational data, globally unique Padlet evidence claims, immutable transaction snapshots, and durable operation records. Existing Sheets become a read-only import/export adapter; migration uses preflight snapshots, source mappings, reconciliation gates, a write-freeze cutover, and retained rollback artifacts.

**Tech Stack:** Next.js 16, TypeScript, PostgreSQL/Neon, Drizzle ORM + SQL migrations, `pg` pooled connections on Vercel, Vitest, PGlite for real PostgreSQL-compatible schema/constraint tests, Google OAuth with least-privilege incremental Sheets consent.

---

## Non-negotiable contracts

- Production writes use PostgreSQL only after a tenant reaches `ACTIVE`; Sheets are never a second writable source of truth.
- Every operational row belongs to a tenant, except the globally unique `(board_id, post_id)` Padlet claim registry and platform identity records.
- Tenant isolation is enforced by forced PostgreSQL RLS under a non-bypass runtime role plus transaction-scoped tenant context; application `WHERE` clauses alone are not a security boundary.
- Checkout, task reward, cancellation/reversal, and admin balance mutation require immutable `operationId` + normalized payload hash.
- Same operation ID + same payload returns the prior result; same ID + different payload fails closed.
- Balance, stock, completion, transaction ledger, Padlet claim, and operation result commit atomically in one DB transaction.
- Padlet provider fetch occurs before the short DB transaction; authorization is rechecked inside the transaction before claim/reward.
- `(board_id, post_id)` is globally unique; a claim has no TTL and is never deleted by completion reset.
- Student balances may be negative because existing administrative adjustments and later reward recovery support that state. Database checks must not globally clamp account or ledger balances; checkout and cancellation commands enforce their own policy.
- Existing `Asia/Seoul` recurrence and carry/reset rules remain unchanged.
- Existing student QR values remain accepted only within an already selected tenant context; new QR values are tenant-scoped and signed.
- Existing Sheets are never modified during preflight. Cutover requires a verified legacy write freeze and a final delta snapshot.
- Unknown source columns are preserved in migration raw artifacts; malformed required data blocks cutover rather than being guessed.
- Existing `AGENTS.md` and `.hermes/` remain untouched and uncommitted.

## Phase 1 — Database foundation

### Task 1: Add PostgreSQL tooling and environment validation

**Files:**
- Modify: `package.json`, `package-lock.json`, `.env.example`
- Create: `drizzle.config.ts`
- Create: `src/server/db/config.ts`
- Test: `src/server/db/config.test.ts`

**RED:** Tests require `DATABASE_URL`, distinguish pooled runtime URL from direct migration URL, reject malformed/non-Postgres URLs, and never include credentials in errors.

**GREEN:** Add Drizzle, `pg`, Vercel pool attachment, drizzle-kit, and PGlite test dependencies. Implement strict server-only configuration.

**Verify:** Focused Vitest, TypeScript, ESLint.

### Task 2: Define tenant and identity schema

**Files:**
- Create: `src/server/db/schema/identity.ts`
- Create: `src/server/db/schema/tenants.ts`
- Create: `src/server/db/schema/index.ts`
- Create: `src/server/db/migrations/0001_identity_tenants.sql`
- Test: `src/server/db/schema/identity.test.ts`

**Tables:** `users`, `tenants`, `tenant_memberships`, `tenant_auth_secrets`, `tenant_sessions`, `tenant_settings`, `tenant_setting_extras`.

**Constraints:** canonical Google subject/email identity, unique tenant slug, owner/admin roles, tenant lifecycle `DRAFT|IMPORTING|READY|ACTIVE|MIGRATION_READ_ONLY|SUSPENDED`, Asia/Seoul default, hashed compatibility credentials only, and credential/session versions so rotation invalidates old sessions.

**RED:** Cross-tenant membership and duplicate slug/email tests; no plaintext admin password field.

### Task 3: Define operational relational schema

**Files:**
- Create: `src/server/db/schema/students.ts`
- Create: `src/server/db/schema/catalog.ts`
- Create: `src/server/db/schema/tasks.ts`
- Create: `src/server/db/schema/ledger.ts`
- Create: `src/server/db/migrations/0002_operational.sql`
- Test: `src/server/db/schema/operational.test.ts`

**Tables:** `students`, `accounts`, `products`, `promotions`, `promotion_products`, `tasks`, `task_allowed_students`, `task_assignments`, `task_completions`, `transactions`, `transaction_items`, `adjustments`.

**Constraints/indexes:** tenant-scoped stable IDs; integer money and nonnegative stock checks (balances may be negative); append-only student/inventory/assignment/completion/ledger identities with explicit sequence/order; immutable checkout snapshots in typed columns plus validated JSON; task prerequisite FK in same tenant; cycle and current-state indexes; soft deletion for definitions referenced by history.

**RED:** Tenant FK isolation, duplicate IDs inside tenant, negative stock, invalid snapshots, and cross-tenant relationship rejection.

**RLS:** Enable and force RLS on every tenant table. Runtime and background-worker transactions must set `SET LOCAL app.tenant_id`; missing/invalid context yields no rows and rejects writes. The browser never receives a DB credential.

### Task 4: Define operations, Padlet claims, migration, and audit schema

**Files:**
- Create: `src/server/db/schema/operations.ts`
- Create: `src/server/db/schema/migrations.ts`
- Create: `src/server/db/migrations/0003_operations_migrations.sql`
- Test: `src/server/db/schema/operations.test.ts`

**Tables:** `operations`, `padlet_evidence_claims`, `padlet_claim_digest_tombstones`, `migration_jobs`, `migration_sources`, `migration_source_records`, `migration_snapshots`, `reconciliation_results`, `audit_events`, `exports`.

**Constraints:** operation ID + payload conflict rules; database-global unique `(provider, board_id, post_id)` Padlet tuple and its canonical SHA-256 tuple digest even across tenants; immutable evidence; digest-only tombstones for legacy v1 claims whose tuple cannot be reconstructed; source spreadsheet ownership uniqueness; source row hash/mapping idempotency; migration state transition checks; Recovery plaintext is never imported operationally. Every new claim computes the legacy-compatible digest and conflicts with either a full claim or tombstone.

## Phase 2 — Transactional database commands

### Task 5: Create DB client and transaction test harness

**Files:**
- Create: `src/server/db/client.ts`
- Create: `src/server/db/transaction.ts`
- Create: `src/server/db/testing/pglite.ts`
- Test: `src/server/db/transaction.test.ts`

**RED:** Rollback on thrown effects, transaction-scoped `SET LOCAL` tenant context required, missing context fail-closed, pool reuse cannot retain a prior tenant, serialization retry bounded, pooled connection cleanup attached to Vercel lifecycle, and runtime role cannot bypass RLS.

### Task 6: Establish repository contracts and storage selection

**Files:**
- Create: `src/server/repositories/contracts.ts`
- Create: `src/server/repositories/context.ts`
- Create: `src/server/repositories/factory.ts`
- Modify: route composition roots only; keep existing Sheets functions intact during transition.
- Test: `src/server/repositories/factory.test.ts`

**RED:** Active DB tenant selects DB adapter; legacy single deployment selects Sheets only when explicitly configured; no silent fallback from broken DB to Sheets.

### Task 7: Implement transactional checkout

**Files:**
- Create: `src/server/repositories/database/checkoutCommands.ts`
- Modify: `src/server/checkoutService.ts`, checkout API payload and client operation generation.
- Test: `src/server/repositories/database/checkoutCommands.test.ts`, route/component tests.

**RED:** concurrent stock/balance races; idempotent retry; payload conflict; pricing drift; insufficient stock/balance; rollback leaves no partial balance/stock/ledger changes.

**Transaction:** lock student account and products in stable ID order, recompute authoritative price, update all resources, insert immutable ledger/items, persist operation result.

### Task 8: Implement transactional task reward and Padlet claim

**Files:**
- Create: `src/server/repositories/database/taskCompletionCommands.ts`
- Create: `src/server/repositories/database/padletClaims.ts`
- Modify: `src/server/padletTaskVerification.ts` to use a provider-independent claim interface.
- Test: command, concurrency, route, and projection tests.

**RED:** authorization before provider/claim where possible; fresh authorization inside transaction; same-now allocation; global one-use claim; operation retry binding; board/student/task/cycle drift conflict; provider failure no mutation; concurrent requests exactly one reward.

### Task 9: Implement transactional cancellation and admin adjustments

**Files:**
- Create: `src/server/repositories/database/transactionCommands.ts`
- Create: `src/server/repositories/database/adminCommands.ts`
- Modify: cancellation/adjustment routes and clients for operation IDs.
- Test: focused command/route tests.

**RED:** repeat cancellation returns prior result; stock and balance reversal atomic; original transaction and reversal linked; task reward cancellation links and reverses completion according to the preserved policy; a reversal that would make the balance negative is rejected; malformed legacy transaction requires manual reconciliation; no best-effort ledger.

### Task 10: Implement DB query repositories and every remaining mutation path

**Files:**
- Create: `src/server/repositories/database/studentQueries.ts`
- Create: `catalogQueries.ts`, `taskQueries.ts`, `transactionQueries.ts`, `settingsQueries.ts`
- Create: `studentCommands.ts`, `catalogCommands.ts`, `promotionCommands.ts`, `taskAdminCommands.ts`, `settingsCommands.ts`
- Modify: every student/product/task/promotion/settings/assignment/schedule/reset/batch API composition root to use tenant-aware contracts.
- Test: parity fixtures comparing Sheets projection and DB projection; route-method inventory proving every active-tenant read and mutation resolves to PostgreSQL and no route can fall back to Sheets.

**Mutation inventory:** Cover individual and batch create/update/delete for students, products, tasks, task assignments/completions/resets/schedules, promotions and links, typed settings, administrator credentials, and schema/admin maintenance. Multi-row commands are all-or-nothing, lock rows in stable order, use optimistic versions where stale edits matter, and append audit events. Money-changing and retryable multi-row commands require operation IDs.

## Phase 3 — Central tenant/authentication and URL model

### Task 11: Separate ordinary Google login from migration consent

**Files:**
- Modify: `src/server/googleOAuth.ts` and auth routes.
- Create: `src/server/migration/googleSheetsConsent.ts`
- Test: OAuth scope and cookie tests.

**RED:** normal login requests only identity scopes; migration requests temporary Sheets readonly plus the minimum Drive metadata/file permission needed to prove the selected file and claimant role. The default flow captures an immutable preflight snapshot during the browser-attached consent, then deletes/revokes that grant; resumability uses the snapshot. At `FREEZING`, the administrator explicitly re-consents so a fresh frozen final snapshot/fingerprint can be captured before activation, then that grant is deleted at once. If background capture is ever needed, its durable refresh token is encrypted, expiry/revocation-bound, and retained only through the final frozen snapshot. Knowing a Sheet ID, admin password/QR, recovery code, or editable `ownerEmail` cell is not ownership proof.

### Task 12: Add tenant selection, membership authorization, and scoped routes

**Files:**
- Create: `src/server/tenantContext.ts`, `src/server/tenantAuth.ts`
- Add: `/classes`, `/c/[slug]`, `/c/[slug]/bank`, `/c/[slug]/admin/*`
- Add tenant-aware API route group or trusted tenant context middleware.
- Preserve existing routes as explicit default-tenant compatibility redirects.
- Test: cross-tenant access, confused-deputy, membership, and redirect tests.

**Bootstrap transaction:** After Google verifies owner role (or an explicitly labeled supported Shared Drive control role) for a selected Sheet, atomically create the tenant, first owner membership, and one-time source binding. The same source cannot bootstrap two tenants. Editor-only cases require ownership transfer/copy or an explicit administrator-reviewed exception. Supported `adminPasswordHash`/`recoveryCodeHash` values are imported per tenant without plaintext; environment-only passwords are replaced after ownership proof. Any valid Google session without membership has no tenant-admin authority.

### Task 13: Preserve legacy QR and introduce signed tenant QR

**Files:**
- Create: `src/server/studentQr.ts`
- Modify: QR print/scanner and student lookup flows.
- Test: legacy student QR accepted only after tenant selection; signed student QR tenant mismatch rejected; tampering rejected; no student enumeration across tenants. Legacy admin QR is only a tenant-scoped password compatibility path when an imported hash validates it, is never globally searched, never appears in a URL/query string, and is invalidated by required post-cutover credential rotation.

## Phase 4 — Sheets migration and cutover

### Task 14: Capture immutable Sheets and legacy Redis claim snapshots

**Files:**
- Create: `src/server/migration/sheetsSnapshot.ts`, `redisClaimSnapshot.ts`, `legacyBridgeManifest.ts`, `sensitiveRedaction.ts`
- Create: `src/server/legacyMigrationBridge.ts` for deployment-local authenticated export without credential transfer.
- Reuse existing parsers without mutating the source.
- Test: schema v1/v2/v3, missing optional tabs, unknown trailing columns, blank/custom headers, stable row hashes, complete Upstash claim/operation-binding registry capture, orphaned claims without completion rows, digest-only v1 claims, signed manifest tampering/replay, and conflicting binding detection.

**Redis acquisition:** The bridge runs inside each legacy deployment and uses its own existing Upstash environment variables. It enumerates the v2 fixed hash and v1 claim-key namespace, creates a bounded signed/encrypted one-time manifest, and sends no Redis URL/token to the central service. At final freeze it emits a fresh delta manifest and then disables the legacy Redis writer. If the deployment cannot run the bridge, cutover is blocked unless it can prove Padlet/Redis was never configured; credentials are never requested manually.

**Digest-only preservation:** A v1 key exposes only `sha256(boardId + NUL + postId)`. Preserve that digest as a permanent global tombstone with an owner digest and source provenance. Do not attempt tuple reconstruction. PostgreSQL claim insertion computes the same digest and fails on any tombstone, so an orphaned historical post cannot become reusable.

**Sensitive data:** Never persist or export plaintext `Recovery` values. Raw workbook artifacts omit/redact credential-bearing tabs and columns before durable storage; import only supported hashes from trusted Settings fields. Encrypt any unavoidable temporary credential artifact and test all report/export redaction.

### Task 15: Normalize and validate legacy data

**Files:**
- Create: `src/server/migration/normalize.ts`, `validators.ts`, `manifest.ts`
- Test fixtures for every generated sheet and malformed/duplicate/broken-reference cases.

**Output:** canonical records, warnings, blocking conflicts, redacted source artifact digest, and deterministic source-to-target mappings. Union Sheet completion evidence with the legacy Redis registry, preserving Redis-only/orphaned claims; conflicting claim/operation bindings block cutover. Duplicate financial/ledger identifiers and malformed required history are quarantined and block cutover until explicitly resolved; they are never silently merged or skipped.

### Task 16: Implement idempotent importer

**Files:**
- Create: `src/server/migration/importer.ts`
- Test: interruption/resume, rerun without duplicates, source mutation detection, tenant isolation, transaction rollback.

**Rule:** imports write only to non-active tenant staging records until reconciliation passes.

### Task 17: Implement reconciliation gates

**Files:**
- Create: `src/server/migration/reconcile.ts`, `report.ts`
- Test: student/account balances, stock, transaction counts/sums, cancellation counts, tasks/assignments/completions, promotions, recurrence projections.

**Gate:** any required mismatch or source mutation blocks `READY` and cutover. Reconciliation includes legacy Redis claim/operation counts, orphaned claims, and tuple-owner bindings. Sheets and Redis remain authoritative until a verified write freeze; conflicts stop for resolution rather than choosing DB or Sheets silently. Reports store expected/actual/delta and row-level diagnostics without credentials.

### Task 18: Implement legacy write-freeze compatibility mode

**Files:**
- Create: `src/server/legacyDeploymentMode.ts`
- Modify all Sheets mutation route composition roots to reject writes when `MIGRATION_READ_ONLY` is active while preserving reads.
- Add migration banner and central target URL support.
- Test every money/admin mutation route is blocked; reads remain available.

**Manual/custom deployments:** If the compatibility update cannot be installed, cutover requires disabling the old deployment or revoking its write credential, restricting direct human Sheet writes, probing every known mutation endpoint for failure, and recording a time-bounded freeze proof. Then capture fresh Sheet and Redis fingerprints. Activation fails when proof is missing/stale or either source changes.

### Task 19: Implement final delta import and cutover state machine

**Files:**
- Create: `src/server/migration/cutover.ts`
- Test: verified freeze required, final source fingerprint, delta import, reconciliation, atomic tenant activation, aborted cutover, no dual-active state.

**States:** `DISCOVERED → VALIDATED → IMPORTING → RECONCILING → READY → FREEZING → FINAL_IMPORT → ACTIVE`, with explicit failed/aborted states. Entering `FREEZING` requires fresh Google re-consent for the final Sheet snapshot and a fresh bridge manifest for Redis claims. Final import captures both deltas, reconciles full claims plus digest tombstones, activates PostgreSQL claim authority atomically, then retires/disables the legacy Redis writer and deletes the migration grant.

### Task 20: Add migration administration UI/API

**Files:**
- Add: `/admin/migrations` pages/components and `/api/migrations/*` routes.
- Test: login/membership, preflight read-only behavior, conflict display, confirmation boundaries, progress resume, report download.

**External side effects:** preflight is read-only; freeze/cutover requires explicit administrator confirmation showing the exact source Sheet and target tenant.

### Task 21: Add exports and retained rollback artifacts

**Files:**
- Create: `src/server/exports/*`, admin export routes/UI.
- Test: CSV/XLSX/Sheets-compatible exports, immutable migration report, post-cutover delta export, no secret leakage.

**Rollback distinction:** Application-version rollback keeps PostgreSQL authoritative. Storage rollback to Sheets is a separate controlled migration: freeze DB writes, export/apply every post-cutover DB delta, reconcile balances/stock/ledger/tasks/claims, atomically change authority, and only then re-enable a legacy writer. Direct URL rollback to a stale Sheet is prohibited.

## Phase 5 — Verification and rollout

### Task 22: Documentation and operator runbooks

**Files:**
- Update: `README.md`, `.env.example`, `docs/admin-settings.md`, `docs/vercel-deploy-guide.md`
- Create: `docs/database-architecture.md`, `docs/sheets-migration-runbook.md`, `docs/cutover-rollback-runbook.md`, `docs/data-retention-export.md`

### Task 23: Full verification and independent reviews

**Gates:**
1. Focused TDD suites for each task.
2. Full `npm test`.
3. `npx tsc --noEmit --pretty false`.
4. `npx eslint .`.
5. `npm run build`.
6. `git diff --check` and secret scan.
7. Real PostgreSQL migration/constraint/transaction rehearsal on an isolated preview DB branch.
8. Full import of a copied production Sheet snapshot and reconciliation with zero required deltas.
9. Browser verification of tenant, kiosk, bank, admin, migration, Padlet unavailable/available states.
10. Independent spec review, security/tenant-isolation review, and migration/data-integrity review.
11. Automated route inventory proving every active-tenant API mutation is DB-backed and every RLS-negative cross-tenant probe fails.
12. Legacy Redis claim migration rehearsal including orphaned claim and race-lost candidates.

### Task 24: Controlled production rollout

- Provision Neon through Vercel only after schema/transaction review passes.
- Create preview and production DB roles with least privilege; migration role is not used at runtime.
- Deploy DB-capable code with existing tenant still on Sheets and no automatic cutover.
- Migrate the current managed class as the first canary.
- Observe and reconcile before inviting other existing deployments.
- Never delete source Sheets automatically; retain read-only until the administrator chooses an export/retention policy.

## Decisions reserved for the administrator

Only pause implementation for decisions that materially alter data ownership or user-visible compatibility:

1. Whether a specific existing custom deployment can receive the write-freeze compatibility update; otherwise use manual cutover.
2. Whether to activate a migrated tenant after a zero-delta report; migration preflight/import alone never activates it.
3. Whether and when to retire each old deployment URL.
4. Whether old student QR support is eventually disabled after new QR distribution.
5. Source Sheet retention/deletion after the rollback window; default is indefinite read-only retention.
6. Retention period for sensitive raw migration staging rows and generated backup exports; this is decided before the first real import, while aggregate reconciliation/audit records remain durable.

Safe defaults requiring no interruption: Neon PostgreSQL, Asia/Seoul, Google identity for tenant owners, no stored migration refresh token, legacy student QR compatibility within tenant context, forced post-cutover admin credential rotation, globally unique Padlet tuples across tenants, cancellation rejection when recovery would make balance negative, all-or-nothing administrator batches, source-conflict stop, malformed/duplicate financial-row quarantine with cutover blocking, Sheets read-only retention, and staged canary rollout.
