# Google Sheets Padlet Task Integration Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add production-safe Padlet-backed task eligibility and completion to the current Google Sheets template while preserving the verified carousel implementation and postponing all PostgreSQL migration work.

**Architecture:** Store only the canonical Padlet board ID on each task and immutable evidence snapshots on successful Sheet completion rows. Fetch Padlet posts server-side, derive ephemeral `READY | SUBMISSION_REQUIRED | CHECK_UNAVAILABLE` eligibility from the server-resolved QR student name and current recurrence cycle, and reserve `(boardId, postId)` globally through an atomic Upstash Redis operation binding before completing the existing idempotent Sheets reward operation. Provider timestamps are normalized at ingress to canonical UTC milliseconds so documented Padlet responses and strict Sheet evidence schemas agree.

**Tech Stack:** Next.js 16, React 19, TypeScript, Google Sheets repositories, Padlet API v1, Upstash Redis REST, Vitest, Testing Library.

**Base:** `origin/master` at or after `2da080724e5670bbf353ff5d43e278f9760c656e`.

**Historical reference only:** `39d7ccddd04274d5a930f76cc08d6e59d19ca131`. Never cherry-pick or restore this commit wholesale; its `BankApp` predates the final carousel interaction fixes.

---

## Product contract

1. An administrator may optionally associate a task with an official Padlet board URL or canonical board ID.
2. The Sheet stores the canonical board ID only; it never stores the Padlet API key or Redis credentials.
3. A student sees `완료 가능` only when an approved post exists whose normalized Padlet `author.fullName` exactly equals the server-resolved CRS student name after outer whitespace trimming.
   If that trimmed name belongs to more than one active CRS student, Padlet evidence is ambiguous and every affected task fails closed as `CHECK_UNAVAILABLE`; neither student may claim a post by name alone.
4. A repeating task accepts only posts created at or after the current cycle start. A one-time task uses its current projected cycle start under the existing Asia/Seoul scheduling rules.
5. The same Padlet post cannot fund more than one task completion anywhere that shares the configured Redis registry. Claims have no TTL and are not removed by completion reset.
6. If Padlet, Redis, configuration, response validation, cycle state, or allocation is uncertain, the feature fails closed as `확인 불가`; it never grants a reward optimistically.
7. The client never selects or submits evidence. The server selects, claims, snapshots, and binds evidence to the completion operation.
8. The same completion `operationId` with the same task/student/evidence returns the prior result; an operation rebound to different evidence fails closed.
9. Successful evidence snapshots are immutable Sheet history: provider, board ID, post ID, canonical UTC created-at, and author full name.
10. UI progression is `과제 부여 → 완료 가능 → 완료`. `게시물 필요` and `확인 불가` are non-completable explanatory states.
11. Existing non-Padlet tasks continue through the current Sheets completion path unchanged.
12. Current carousel behavior from `2da0807`—50% indicator threshold, held-touch protection, cancellable animation, synthetic-click suppression, position restoration—must remain unchanged.
13. No PostgreSQL schema, repository, route selection, or migration code is changed in this phase.

## Student identification boundary

This phase preserves the current bank's QR identification model; it does not claim to introduce cryptographic student authentication. The client submits only the scanned/manual QR student value and `operationId`. Before Padlet or Redis access, the server re-reads the active student row from Sheets, derives the canonical student ID and name there, and uses only those server-resolved values for assignment policy, name matching, operation binding, evidence, and reward history. Client-supplied names, authors, board IDs, post IDs, evidence, cycle IDs, and reward values are rejected.

Tests must prove that a nonexistent/inactive QR value and a request attempting to add or override identity/evidence fields fail before Padlet access, Redis claim, or Sheet mutation. Stronger signed tenant QR authentication remains part of the later PostgreSQL/tenant phase and is not silently smuggled into this Sheets feature.

Before exposing eligibility or claiming evidence, the server also reads active student names and proves that the resolved trimmed name maps to exactly one active student ID. Zero or multiple matches fail closed before provider evidence is exposed or reserved. Name uniqueness is revalidated immediately before claim so a concurrent roster change cannot turn an earlier eligibility result into an unsafe reward.

## Concrete safety bounds

- Padlet request timeout: 8,000 ms.
- Maximum linked tasks evaluated per board: 100.
- Maximum complete posts accepted per board response: 200.
- Maximum concurrent Padlet board requests: 4.
- Maximum Redis claim-owner HMGET fields per request: 200.
- Maximum claim race attempts for one completion: 8.

If the provider indicates additional pages, returns more than the allowed complete set, or cannot prove the response is complete within these limits, every affected task is `CHECK_UNAVAILABLE`. Truncation must never be interpreted as `SUBMISSION_REQUIRED`.

---

## Known defect that must not be restored

Historical `src/server/padletClient.ts` accepted only timestamps matching exactly `YYYY-MM-DDTHH:mm:ss.sssZ`. Padlet's documented API can return `YYYY-MM-DDTHH:mm:ssZ`, so valid posts were rejected as `INVALID_RESPONSE` and appeared as `CHECK_UNAVAILABLE`.

The replacement ingress contract is:

```ts
normalizePadletTimestamp('2023-07-22T00:52:32Z')
  === '2023-07-22T00:52:32.000Z';

normalizePadletTimestamp('2023-07-22T09:52:32+09:00')
  === '2023-07-22T00:52:32.000Z';
```

Accept a bounded RFC 3339/ISO-8601 date-time with an explicit `Z` or numeric offset and optional fractional seconds; reject timezone-less, date-only, impossible, non-string, or non-canonical trailing data. Normalize once at the Padlet boundary with `Date#toISOString()`. All domain, Redis binding, and Sheet codecs continue to require canonical `.sssZ` UTC values.

---

### Task 1: Create an isolated integration branch and establish the current baseline

**Objective:** Protect the paused DB worktree and ensure the implementation starts from the verified carousel template.

**Files:** None.

**Steps:**

1. Fetch `origin/master`.
2. Create a separate worktree and branch from `origin/master`, not from `feat/postgres-multitenant-migration`.
3. Verify HEAD contains commit `2da0807` and the worktree is clean.
4. Run the baseline:

```bash
npm ci
npx vitest run src/components/BankApp.test.tsx
npm test -- --run
npx tsc --noEmit
npm run lint
npm run build
npm audit --omit=dev
```

5. Record baseline counts. Do not modify or stage `AGENTS.md`; Next may regenerate it during `next dev`, so restore only that generated worktree copy before any review.

**Gate:** No implementation begins if current `origin/master`, baseline tests, or build is not clean.

---

### Task 2: Restore Padlet tests first and prove feature-level RED

**Objective:** Reuse the historical contract without overwriting current production/UI code.

**Files:**
- Add test: `src/domain/taskEvidenceEligibility.test.ts`
- Add test: `src/server/padletClient.test.ts`
- Add test: `src/server/padletEvidenceClaimStore.test.ts`
- Add test: `src/server/padletSchemas.test.ts`
- Add test: `src/server/padletTaskVerification.test.ts`
- Add test: `src/app/api/tasks/taskPayload.padlet.test.ts`
- Add test: `src/components/AdminManagePage.padlet.test.tsx`
- Modify tests selectively: existing Padlet-related route, Sheets repository, codec, generator, projection, admin, and Bank tests listed by `git diff-tree 39d7ccd`.

**Steps:**

1. Copy standalone historical test files from `39d7ccd` only.
2. Port Padlet-specific test cases into current modified test files by applying individual hunks; never `git checkout 39d7ccd -- BankApp.test.tsx` or overwrite the current 63-test carousel suite.
3. Update the timestamp contract before running tests:
   - move `2026-08-01T01:02:03Z` from rejection cases to acceptance/normalization;
   - add offset and fractional-second normalization;
   - keep timezone-less and impossible-date failures.
4. Run focused groups and observe expected RED due to missing modules/fields/behavior:

```bash
npx vitest run \
  src/server/padletClient.test.ts \
  src/server/padletEvidenceClaimStore.test.ts \
  src/server/padletTaskVerification.test.ts \
  src/domain/taskEvidenceEligibility.test.ts
```

5. Run UI/schema RED groups separately so failures remain attributable.

**Expected RED:** Missing Padlet modules, task/evidence fields, Sheet columns, API payload support, and UI status behavior. A test that passes immediately must be checked for vacuity.

---

### Task 3: Implement strict Padlet URL, board, post, and timestamp ingress

**Objective:** Validate all provider-controlled data and normalize timestamps before any eligibility or persistence logic.

**Files:**
- Create: `src/server/padletClient.ts`
- Test: `src/server/padletClient.test.ts`

**Required API:**

```ts
parsePadletBoardId(input: string): string | null;
isCanonicalPadletPostId(input: string): boolean;
normalizePadletTimestamp(input: string): string | null;
fetchPadletBoardPosts(input: {
  boardId: string;
  apiKey?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<PadletPost[]>;
```

**Behavior:**

- Official HTTPS `padlet.com`/`www.padlet.com` URLs only; reject credentials, ports, query, fragment, malformed escapes, extra unsupported shapes, and lookalike hosts.
- Canonical board IDs and post IDs are bounded and allowlisted.
- Fetch server-side with API key header and bounded timeout.
- Accept official `approved`, `pending_moderation`, `scheduled`, and nullable status; only `approved` is eligible.
- Validate the complete included-post collection. Do not silently skip malformed post records.
- Normalize created-at to canonical `.sssZ` UTC at ingress.
- Classify configuration, authentication, rate limit, timeout, upstream, and invalid-response errors without retaining response bodies, API keys, or network causes.

**TDD cycle:** Run `src/server/padletClient.test.ts` RED, implement minimal behavior, then GREEN.

---

### Task 4: Add optional Padlet task and immutable evidence Sheet schema

**Objective:** Extend generated and existing Sheets non-destructively.

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/generator/config/schema.ts`
- Modify: `src/generator/config/schema.test.ts`
- Modify: `src/generator/commands/create.ts`
- Modify: `src/generator/generator.test.ts`
- Modify: `src/server/repositories/sheets/recurringSchemaMigrator.ts`
- Modify: `src/server/repositories/sheets/recurringSchemaMigrator.test.ts`
- Modify: `src/server/sheetsRows.ts`
- Modify: `src/server/sheetsRows.test.ts`
- Modify: `templates/students.csv`
- Modify: `docs/google-sheets-template.md`
- Modify: `docs/sheets-template.md`
- Test: `src/server/padletSchemas.test.ts`

**Schema additions:**

```text
Tasks.padletBoardId
TaskCompletions.evidenceProvider
TaskCompletions.evidenceBoardId
TaskCompletions.evidencePostId
TaskCompletions.evidenceCreatedAt
TaskCompletions.evidenceAuthorFullName
```

**Rules:**

- Existing Sheets gain missing columns by the existing append-only recurring schema migrator; no row rewrite, reorder, destructive migration, or fabricated evidence.
- Blank `padletBoardId` means ordinary task.
- Evidence is all-or-none; partial evidence rows are malformed and fail closed.
- Evidence provider is exactly `PADLET`; IDs are canonical; created-at is canonical UTC milliseconds; full name is nonblank and bounded.
- Preserve unknown trailing columns and existing row values.
- Generated Sheets, CSV template, generator schema, runtime parser, writer, and documentation must share the exact column order contract.

**TDD cycle:** Schema/generator/migrator tests RED → minimal schema changes → GREEN.

---

### Task 5: Add task CRUD and administrator Padlet linkage

**Objective:** Allow administrators to attach or remove a Padlet board without exposing credentials.

**Files:**
- Modify: `src/app/api/tasks/taskPayload.ts`
- Test: `src/app/api/tasks/taskPayload.padlet.test.ts`
- Modify: `src/app/api/tasks/route.ts`
- Modify: `src/app/api/tasks/route.test.ts`
- Modify: `src/app/api/tasks/[taskId]/route.ts`
- Modify: `src/server/sheetsRepository.ts`
- Modify: `src/server/sheetsRepository.test.ts`
- Modify: `src/components/AdminManagePage.tsx`
- Modify: `src/components/AdminManagePage.test.tsx`
- Test: `src/components/AdminManagePage.padlet.test.tsx`

**Behavior:**

- Admin may paste an official Padlet URL or canonical ID; client extracts the board ID for the strict task payload.
- Create, update, batch, read-back, and clear operations preserve `padletBoardId` exactly.
- Unknown request keys and malformed IDs are rejected server-side.
- Editing a task must preserve unrelated unsaved admin drafts and the existing recurrence/prerequisite state.
- API key and Redis values never appear in task payloads, DOM, client bundles, Sheets, logs, or API errors.

**TDD cycle:** Payload/repository tests RED, then admin UI tests RED, then production implementation and GREEN.

---

### Task 6: Implement deterministic eligibility without claiming evidence

**Objective:** Show safe student status while leaving the actual claim to completion time.

**Files:**
- Create: `src/domain/taskEvidenceEligibility.ts`
- Test: `src/domain/taskEvidenceEligibility.test.ts`
- Create: `src/server/padletTaskVerification.ts`
- Test: `src/server/padletTaskVerification.test.ts`
- Modify: `src/server/studentTaskProjection.ts`
- Modify: `src/server/studentTaskProjection.test.ts`
- Modify: `src/app/api/tasks/route.ts`
- Modify: `src/app/api/tasks/route.test.ts`

**Eligibility statuses:**

```ts
type PadletEligibilityStatus =
  | 'READY'
  | 'SUBMISSION_REQUIRED'
  | 'CHECK_UNAVAILABLE';
```

**Rules:**

- Resolve the active student from the submitted QR value and project only that server-resolved student's visible tasks before provider enrichment.
- Prove the resolved trimmed name is unique across active Sheet students. A duplicate active name maps every Padlet-linked task for that student to `CHECK_UNAVAILABLE` before provider/Redis access; ordinary non-Padlet tasks are unaffected.
- Group linked tasks by board; bound posts/tasks and provider concurrency.
- Exact trimmed full-name match; no case folding, partial matching, or student-name exposure in errors.
- Approved posts only.
- Compare normalized canonical post time against current `cycle.startsAt`, inclusive.
- Query Redis claim ownership in batches of at most 200 fields.
- For multiple eligible tasks sharing one board, deterministically allocate oldest eligible posts in task dependency/order sequence so one post does not make several cards `READY`.
- Eligibility is ephemeral and does not reserve a post.
- Provider/Redis/config/schema uncertainty maps every affected linked task to `CHECK_UNAVAILABLE`, never ordinary-ready.
- Return only status/message to the client; do not expose post IDs, timestamps, authors, claim owners, or provider response details.

**TDD cycle:** Pure selection tests RED/GREEN first, then bounded service and projection tests.

---

### Task 7: Implement global atomic evidence claims and operation binding

**Objective:** Ensure a post can be rewarded only once while preserving idempotent retries.

**Files:**
- Create: `src/server/padletEvidenceClaimStore.ts`
- Test: `src/server/padletEvidenceClaimStore.test.ts`

**Storage contract:**

- Use Upstash Redis REST only from the server.
- Store global claim ownership and immutable operation binding in a fixed hash/namespace.
- Use one Lua command to atomically bind `operationId` and claim `(boardId, postId)`.
- The immutable operation record contains `operationId`, server-resolved student ID, task ID, task-instance/assignment identity, canonical cycle identity, and the complete normalized evidence snapshot.
- At the start of every linked retry—before any Padlet fetch—read the operation binding. A matching complete binding resumes Sheets from that snapshot without refetching or reallocating evidence. Malformed, partial, or mismatched bindings fail closed.
- A lost or ambiguous Redis command response is recovered by rereading the same operation binding; it is never retried by selecting different evidence blindly.
- Same operation and same binding → `IDEMPOTENT`.
- Same operation and different task/student/cycle/evidence → `OPERATION_CONFLICT`.
- Different operation for an already claimed post → `CONFLICT`.
- No TTL, delete, reset, or client-controlled owner.
- Validate all Redis response shapes; ambiguous responses and missing URL/token throw a safe `UNAVAILABLE` error.
- Bound HMGET sizes and claim attempts.
- Preserve both historical namespaces with exact fixtures: standalone `padlet:evidence-claim:v1:<tupleDigest>` keys and the fixed `padlet:evidence-bindings:v2` hash operation/claim fields.
- New allocation and the atomic claim script treat a claim in either namespace as occupied. Where check-then-claim would race, the Lua command performs the compatibility check and new write atomically. Malformed or partial legacy state is `UNAVAILABLE`, never unclaimed.
- Production uses one dedicated durable registry shared by every deployment participating in the global claim contract. Deletion/flush is prohibited operationally. Switching, restoring, or recreating it requires migration and reconciliation of all v1/v2 claims before traffic is enabled; otherwise Padlet completion stays disabled. “Global” means every deployment using this preserved registry, not every possible Redis database.
- Document registry backup/restore, capacity monitoring, write-failure alerts, and the fact that losing the registry would invalidate the single-use guarantee.

**TDD cycle:** Lua command/response/concurrency fixtures RED → implementation → GREEN.

---

### Task 8: Bind Padlet evidence to the existing idempotent Sheets completion operation

**Objective:** Claim evidence and award the existing Sheets reward without accepting client evidence or creating duplicate rewards.

**Files:**
- Modify: `src/server/repositories/sheets/taskCompletionCommands.ts`
- Modify: `src/server/repositories/sheets/taskCompletionCommands.test.ts`
- Modify: `src/app/api/tasks/[taskId]/complete/route.ts`
- Modify: `src/app/api/tasks/[taskId]/complete/route.test.ts`
- Modify: `src/server/sheetsRepository.ts`
- Modify: `src/server/sheetsRepository.test.ts`

**Required sequence:**

1. Parse strict `{ studentId, operationId }`; reject every extra identity/evidence field.
2. Resolve the active student row server-side from the QR value and use only its canonical ID/name from this point onward.
3. Prove that the resolved trimmed name belongs to exactly one active student. Duplicate/ambiguous names fail closed before Padlet or Redis access.
4. Read current authoritative task, assignment, prerequisite, availability, cycle, and prior Sheet completion operation.
5. If this operation already completed in Sheets, replay the immutable success without Redis or provider access.
6. Before Padlet access, read any existing Redis operation binding. If its full student/task/task-instance/assignment/cycle identity matches, resume with its immutable evidence snapshot. A mismatch is a non-retryable operation conflict; malformed/partial state is unavailable.
7. Only for a genuinely unbound operation, fetch current Padlet posts and select evidence.
8. Revalidate active-student identity, trimmed-name uniqueness, task, assignment, and cycle policy immediately before claiming.
9. Atomically write the complete immutable operation binding and claim evidence in Redis.
10. Bind the canonical evidence snapshot into the Sheet operation payload hash.
11. Persist PENDING/SUCCESS evidence and reward through the existing resumable Sheets completion command.
12. Re-read and return an authoritative safe projection.

**Failure/retry tests:**

- provider unavailable: no Sheet mutation, no claim;
- no eligible post: no claim/reward;
- duplicate active student names: no READY status, provider evidence disclosure, claim, or reward; a roster change creating a duplicate between projection and completion is caught by pre-claim revalidation;
- Redis unavailable/ambiguous: no reward;
- claim race: exactly one operation proceeds;
- Sheet failure after claim: same operation can resume from immutable Redis binding; different operation cannot steal the post;
- cycle/assignment rollover after claim but before Sheet persistence: resume only against the exact bound identity when still valid; otherwise return a non-retryable manual-reconciliation state while permanently retaining the claim. Never apply old evidence to a new cycle;
- operation payload conflict: 409 fail-closed;
- PENDING/SUCCESS retry does not refetch/reclaim or duplicate balance/ledger/completion;
- evidence snapshot does not change if Padlet post later changes;
- ordinary non-Padlet completion remains unchanged;
- admin completion/reset policy remains unchanged and never deletes a claim.

**Important limitation:** Google Sheets is not a cross-service transaction with Redis. The durable operation binding is the recovery contract for claim-before-Sheet failures. Tests and user messages must state unknown/manual-reconciliation states honestly; do not describe this as a PostgreSQL-style atomic transaction.

---

### Task 9: Add student `완료 가능` UI without regressing the carousel

**Objective:** Present `과제 부여 → 완료 가능 → 완료` clearly and safely.

**Files:**
- Modify selectively: `src/components/BankApp.tsx`
- Modify selectively: `src/components/BankApp.test.tsx`

**Rules:**

- Never restore historical `BankApp.tsx` or its full test file.
- Extend current `BankTask` DTO with Padlet eligibility status/message only.
- Card overlay:
  - `READY` → `완료 가능`;
  - `SUBMISSION_REQUIRED` → `게시물 필요` and disabled completion;
  - `CHECK_UNAVAILABLE` → `확인 불가` and disabled completion;
  - successful completion → existing `완료됨` takes precedence.
- Preserve prerequisite precedence and accessible labels.
- Detail dialog explains the current Padlet state and enables `완료하기` only for `READY`.
- Safe retry/status-unknown UI keeps the same `operationId`; it never generates a new operation while the result is uncertain.
- Preserve all current carousel interaction tests and behavior from `2da0807`.

**TDD cycle:** Port only Padlet UI test cases into the current suite, observe RED, implement minimal status UI, then run all BankApp tests including the 63 carousel tests.

---

### Task 10: Add environment, deployment, and operator documentation

**Objective:** Make the optional feature deployable without leaking secrets or implying unsafe behavior.

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/admin-settings.md`
- Modify: `docs/vercel-deploy-guide.md`
- Modify: `docs/google-sheets-template.md`
- Modify: `docs/sheets-template.md`

**Document:**

```text
PADLET_API_KEY=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

- All three are server-only Vercel Production variables when Padlet tasks are used.
- Padlet board visitor login/identity and approved-post behavior must be configured.
- CRS student name and Padlet full name must match exactly after trimming.
- Missing/degraded configuration fails closed.
- Redis claims are permanent and shared across every deployment using the same registry.
- The dedicated registry must be backed up and migrated/reconciled before URL/token or Redis-instance replacement; an empty replacement must not be treated as a fresh valid registry.
- Never paste actual secret values into docs, tests, logs, screenshots, or the Sheet.
- Document timestamp normalization and cycle cutoff in user terms, not implementation jargon.

---

### Task 11: Run staged, browser, and external-service verification

**Objective:** Prove the complete Sheets architecture before publishing the template.

**Automated focused gates:**

```bash
npx vitest run \
  src/server/padletClient.test.ts \
  src/server/padletEvidenceClaimStore.test.ts \
  src/server/padletTaskVerification.test.ts \
  src/domain/taskEvidenceEligibility.test.ts \
  src/server/padletSchemas.test.ts \
  src/app/api/tasks/taskPayload.padlet.test.ts \
  src/components/AdminManagePage.padlet.test.tsx

npx vitest run src/components/BankApp.test.tsx
```

**Full gates:**

```bash
npm test -- --run
npx tsc --noEmit
npm run lint
npm run build
npm audit --omit=dev
git diff --check
```

**Browser matrix with mocked safe fixtures:**

- admin add/edit/clear Padlet URL;
- assigned, post-required, check-unavailable, ready, and completed card/detail states;
- completion retry and operation-conflict messages;
- current carousel swipe, indicator, held-touch, and position restoration.

**Live external E2E, only on a copied test Sheet and dedicated test Padlet/Upstash:**

1. Post before cycle start is rejected.
2. Pending/unapproved post is rejected.
3. Wrong author name is rejected.
4. Two active test students with the same trimmed name both receive `CHECK_UNAVAILABLE`; neither can expose or claim the other's post. Creating the duplicate after projection but before completion is also blocked.
5. Approved uniquely matching post produces `완료 가능`.
6. Completion writes one reward and canonical immutable evidence.
7. Repeating the same operation returns the prior success.
8. A second task/operation cannot reuse the same post.
9. Padlet/Redis outage fails closed without Sheet reward mutation.
10. Inject a Sheet failure immediately after a confirmed Redis claim and before Sheet `PENDING`; verify the claim remains, the same operation resumes without Padlet refetch, a different operation is blocked, exactly one reward/evidence history is eventually written, and completion reset does not release the claim.
11. Claim in the v1 namespace blocks a new v2 claim, and a v2 claim blocks reuse after restart/redeployment.

Do not perform a live reward/claim against the production class without explicit approval. If credentials or a dedicated test post are unavailable, report live E2E as blocked rather than fabricating success.

---

### Task 12: Independent review, selective commit, and template publication

**Objective:** Publish only after cross-service safety and regression gates pass.

**Reviews, in order:**

1. Specification review against every product contract item.
2. Security/privacy review: secrets, safe errors, client DTOs, exact identity match, bounded provider/Redis work.
3. Sheets reliability review: operation replay, claim-before-Sheet failure recovery, evidence immutability, no destructive migration.
4. UI/accessibility review including all current carousel behavior.

Fix every Critical/Important finding with a new RED regression and repeat the relevant review.

**Commit discipline:**

- Stage only reviewed Padlet source, tests, schema, template, and documentation paths.
- Exclude generated `AGENTS.md`, `.next`, `node_modules`, credentials, local env files, and all paused DB-branch artifacts.
- Commit with a verified feature message.
- Push the isolated branch result to template `master` only after final gates.
- Fetch and verify `origin/master` equals the local commit; verify the GitHub commit page.

---

## Expected implementation duration

- Historical tests/contracts and schema restoration: 1–2 hours.
- Timestamp normalization and provider client: 0.5–1 hour.
- Eligibility, Redis binding, and Sheets completion integration: 2–4 hours.
- Current UI/admin merge and docs: 1–2 hours.
- Full reviews, build, browser checks, and live E2E: 1.5–3 hours.

**Expected total:** approximately 6–12 hours if dedicated Padlet, Upstash, and copied-Sheet test access are ready. Automated implementation can finish without those credentials, but live external E2E cannot be claimed complete.

## Out of scope

- PostgreSQL tables, RLS, tenant routing, importer, reconciliation, cutover, or Redis-to-PostgreSQL migration.
- Automatic migration of arbitrary old custom Sheets beyond appending the known optional columns non-destructively.
- Fuzzy student-name matching, email matching, or client-selected evidence.
- Deleting or expiring evidence claims.
