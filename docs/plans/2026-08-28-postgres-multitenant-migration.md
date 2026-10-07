# PostgreSQL Multi-Tenant CRS Implementation Plan

> **2026-10-07 문서 정리:** 현행 제품·검증·잔여 작업은 [README](../../README.md)에 요약한다. 아래 Hermes 역할 배정과 커밋·작업 지시는 과거 계획의 일부이며 실행 지시가 아니다.

> **과거 계획 — 2026-10-05 정정:** Task1–24는 2026-09-29 사용자 승인으로 A–F 파일럿 계획에 대체되었습니다. 아래 작업 번호·Hermes 실행 지시는 이력이며 현행 완료율이나 실행 순서의 기준이 아닙니다. 현재 목표·범위와 원본 근거는 [정정된 인수 보고서](2026-10-04-crs-takeover-assessment.md)를 참조합니다. 첫 출시는 짧은 입력 중단 동안 동결한 전체 자료의 일괄 이전이며, 범용 실시간 delta·자동 Sheets 역이전은 필수 범위에서 제외됐습니다.

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace Google Sheets as the CRS operational source of truth with a central multi-tenant Neon PostgreSQL service, migrate existing individually deployed classes without data loss, and make checkout, task rewards, cancellations, and Padlet evidence claims transactional and idempotent.

**Architecture:** Keep current domain calculations and introduce explicit repository/command boundaries. Use tenant-scoped PostgreSQL tables for operational data, globally unique Padlet evidence claims, immutable transaction snapshots, and durable operation records. Existing Sheets become a read-only import/export adapter; migration uses preflight snapshots, source mappings, reconciliation gates, a write-freeze cutover, and retained rollback artifacts.

**Tech Stack:** Next.js 16, TypeScript, PostgreSQL/Neon, Drizzle ORM + SQL migrations, `pg` pooled connections on Vercel, Vitest, PGlite for real PostgreSQL-compatible schema/constraint tests, Google OAuth with least-privilege incremental Sheets consent.

---

## Codex 인수 — 2026-10-04

사용자 지시에 따라 구현·검증 담당을 Codex로 변경했습니다. 기존 423개 변경 항목과 감독 상태는 백업했으며, 중복 배정을 막기 위해 work_hub의 CRS 전용 감독만 일시 정지했습니다. 기존 D53 실패 기록은 보존하고, 이후 작업은 제품 코드와 재현 가능한 집중 검사로 직접 진행합니다. 아래의 과거 Hermes 실행자/감독 지정은 인수 전 이력입니다.

이번 완료 범위는 **신규 학급 생성과 DRAFT 접근 제한의 로컬 검증**입니다.

- 초기 화면의 JavaScript 초기화 전 제출이 일반 GET으로 실행되던 문제를 수정했습니다. 입력·제출은 초기화 후 활성화됩니다.
- Next.js가 loopback IP를 localhost로 정규화해 정상 생성 POST를 403으로 거부하던 문제를 수정했습니다. 원래 Host와 포트가 정확히 일치하는 경우만 허용하고, 외부 출처·다른 포트·위조 전달 헤더는 거부합니다.
- `npm run test:classes`: 140 PASS. 이 명령에서 opt-in 네이티브 8개는 SKIP이며, 다음 명령으로 별도 실행했습니다.
- `npm run test:classes:postgres`: 실제 PostgreSQL 17, 현재 migration, 별도 DB 연결에서 8 PASS. 동시 요청 중복 방지·계정 격리·원자적 취소·DRAFT 사용 거부를 확인했습니다.
- 실제 Chrome/Next/PostgreSQL에서 로그인 요구 → 합성 인증 세션 → 새 학급 입력/클릭 → 생성 201 → 내 목록의 OWNER/DRAFT → 다른 계정 비노출 → 세션 제거 후 로그인 요구까지 6개 확인을 통과했습니다. 임시 앱·프로세스·DB는 정리했습니다. 외부 Google OAuth 자체의 검증은 아닙니다.
- 전체 TypeScript 검사 exit 0. 변경 파일 ESLint exit 0이며 기존 `window.location.assign` 관련 Next.js 경고 1개가 남습니다.

[검증·인수 기록](../../class-store-supervision/codex-development-20261004.json)에 실행 결과와 원본 증거 경로가 있습니다. A–F 전체, 실제 학급 활성화 또는 운영 배포가 완료된 상태는 아닙니다. 현행 계획에 따른 남은 일은 일반 사용자 흐름, 필요한 과거 이력 호환, 동결 전체 스냅샷의 일괄 이전·대조·활성화, 실제 OAuth·배포·백업 복원·파일럿 검증입니다. 인수 당시 적은 범용 최종 delta 구현 우선순위는 철회합니다.

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
- Student balances may be negative because existing administrative adjustments and later reward recovery support that state. Database checks must not globally clamp account or ledger balances; checkout still checks available funds; cancellation applies the exact inverse to the current balance even when the result is negative (user-confirmed Sheets compatibility policy, 2026-10-05).
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

**RED:** repeat cancellation returns prior result; stock and balance reversal atomic; original transaction and reversal linked; task reward cancellation links and reverses completion according to the preserved policy; a reversal may make the current balance negative and must retain the exact inverse amount, one reversal, and matching audit/completion history; malformed legacy transaction requires manual reconciliation; no best-effort ledger.

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

**Redis acquisition:** The bridge runs inside each legacy deployment and uses its own existing Upstash environment variables. It enumerates the v2 fixed hash and v1 claim-key namespace, creates a bounded signed/encrypted one-time manifest, and sends no Redis URL/token to the central service. For final capture, first exclude **all** legacy writers (not just Redis: every deployment generation, worker/retry/cron, direct credential user and human/service-account Sheet editor), drain in-flight writes and verify continuing exclusion. Only then acquire fresh Sheet and Redis delta manifests while the exclusion remains in force through activation; do not retire source infrastructure before retained recovery is proven. If the deployment cannot run the bridge, cutover is blocked unless it can prove Padlet/Redis was never configured; credentials are never requested manually. The paused execution contract and approval gates are in `/home/haeon/workhub-tasks/live/class-store-supervision/EXECUTION-CONTRACT.md`.

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

**Approved operational-compatibility boundary:** Historical BANK completions whose legacy evidence cannot establish the full modern command/transaction contract are blocking quarantined before `READY_FOR_IMPORT`, including UUID-shaped legacy operation bindings. Preserve original canonical records and source/evidence provenance under the existing redaction policy, propagate blocking conflicts to related operation/claim contributors, and never silently skip or relabel financial history. The importer independently rejects correlated forged-READY bypasses before opening a transaction; it must not manufacture UUIDs, modern hashes, or missing transactions, or relax production readers. Affected tenants cannot complete migration or cut over. Full operational support for these historical BANK variants requires a separately approved audited migration-provenance design.

**Supported-history acceptance:** Project legacy schema/status only for fully validated, semantically equivalent supported nonfinancial events, preserving original source values in canonical staging. Verify real normalization → production-migration import → history query, natural carry, and configuration-boundary materialization, plus a positive current-writer BANK integration. Test retained evidence/readback and quarantine propagation; keep existing deep validation tests reachable rather than letting every negative case fail trivially at the early quarantine gate.

**Downstream contract (Tasks 17–24):** Reconciliation and final-delta processing retain these blocking conflicts; zero numeric deltas cannot override unsupported required history. Administration UI/API and exported reports show preserved-source diagnostics and an explicit blocked state without credentials. Runbooks and canary acceptance prohibit activation while such conflicts remain unresolved; this implementation approval does not authorize live cutover.

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

**States (design target, not current implementation):** `DISCOVERED → VALIDATED → IMPORTING → RECONCILING → READY → FREEZING → FINAL_IMPORT → ACTIVE`, with explicit failed/aborted states. The current `cutover.ts` implements ABORT only. `FREEZING` must fail closed until independent evidence shows all Sheet and Redis writers excluded and in-flight writes drained; fresh Google re-consent is necessary for the Sheet capture but is **not** exclusion proof. Under maintained exclusion, acquire the final Sheet snapshot and fresh Redis bridge manifest, import both deltas, reconcile full claims/digest tombstones, and activate PostgreSQL claim authority atomically only after the other acceptance/approval gates. Keep source writers fenced through activation; retire their resources only later under retention/recovery approval. Failure must not silently reopen either writer; after new PostgreSQL writes, rollback requires a separate reconciled forward-repair/storage migration, not a URL flip. See the paused execution contract above.

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

Safe defaults requiring no interruption: Neon PostgreSQL, Asia/Seoul, Google identity for tenant owners, no stored migration refresh token, legacy student QR compatibility within tenant context, forced post-cutover admin credential rotation, globally unique Padlet tuples across tenants, Sheets-compatible cancellation allowing negative balances on recovery (confirmed 2026-10-05), all-or-nothing administrator batches, source-conflict stop, malformed/duplicate financial-row quarantine with cutover blocking, Sheets read-only retention, and staged canary rollout.
