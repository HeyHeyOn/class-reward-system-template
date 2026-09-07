# Legacy write-freeze compatibility (Task 18)

This is **source-code compatibility support, not a deployed or verified freeze**. No tenant is activated, no source fingerprint is certified, and no Sheet or Redis data is changed by this implementation task. Task 17 READY grants no activation authority.

## Operator configuration contract (do not activate without explicit approval)

- `MIGRATION_READ_ONLY=true`: reject new legacy operational mutations with HTTP **503**, JSON `code: MIGRATION_READ_ONLY`, and `Cache-Control: no-store`.
- Unset, empty, or exactly `false`: preserve normal operation. Any other nonempty spelling fails closed as read-only; use exactly `true` rather than relying on typo handling.
- Optional `MIGRATION_CENTRAL_TARGET_URL=https://central.example/c/class-slug`: show an explicit link in the legacy notice. Only exact canonical HTTPS tenant landing URLs are accepted: no credentials, query, fragment (even empty delimiters), URL-parser repair, encoded path, or deep path. Invalid values suppress only the link, never the freeze.
- The target is trusted deployment configuration, not request input. It is **not fetched, prefetched, or used for an automatic redirect**. The plain anchor opens a new tab with `noreferrer noopener` and `referrerPolicy=no-referrer`; no incoming query, credentials, student IDs, or QR values are appended or submitted. It does not transfer sessions; the user authenticates independently on the central service. Existing unrelated tenant compatibility routing is unchanged.
- The notice is resolved at request time using Next `connection()` inside a Suspense boundary; it is not baked from build-time public environment values. It covers `/`, `/bank`, `/admin` and legacy admin children, not `/c/*`, `/classes`, or the generator UI. It is informational, not an authentication control.

## Authority boundary

The shared `legacyWriteFreezeResponse()` is the **first operation** in all 27 legacy operational writer methods. A separate explicit `generator-sheets` kind also refuses generator creation before consuming its global DB grant, even when that platform stores identities in PostgreSQL. This is 28 guarded methods in 21 route files.

Trusted request-local tenant context bypasses only this *legacy deployment* refusal: the existing dispatcher, membership checks, lifecycle checks, and PostgreSQL selection remain authoritative. `CLASS_STORE_STORAGE=postgresql` does not freeze central tenant writes. Client headers, cookies, request bodies, query strings and claimed slugs cannot create trusted context. A scoped legacy-adapter fallback is still rejected by the pre-existing adapter boundary.

Do not put the freeze on `createConfiguredSheetsStore()`: `createConfiguredSheetsReader` is currently an alias of that constructor, so doing so would break reads. Do not use the HTTP verb as the side-effect inventory: POST preview/QR and legacy admin login must remain usable, while OAuth GETs do issue/revoke tokens and cookies. Refusal happens before body parsing, authorization reads, provider lookup, schema migration, named-range claims, batch loops, or generator claim consumption; no partial batch can begin in an already frozen request.

The policy module follows `trustedTenantRequestContext`'s server-runtime convention (`node:async_hooks` dependency), so existing route unit tests do not need to mock the new policy. The presentation loader also uses the Next server-only marker. The client gets only sanitized presentation data.

## Exhaustive API method inventory

The independent fixture `src/server/testing/legacyWriteFreezeRoutes.json` is compared against TypeScript AST discovery of **all** concrete exported API methods, including function, const and named/aliased re-exports (using the exported name) and HEAD/OPTIONS if added. Explicit declaration-level and specifier-level type-only exports are excluded. This is syntax-level discovery, not cross-module symbol resolution: exported variable declarations must use Identifier bindings. Any exported object or array destructuring binding (including aliases, nested/default/rest forms and non-HTTP names) is detected and refuses the inventory gate rather than silently omitting possible methods; binding patterns are not resolved. Runtime `export *` also fails the gate rather than silently omitting unknown methods; type-only `export type *` is ignored. The scoped dispatcher `/api/c/[slug]/[...path]` is deliberately excluded as a composition root, not counted as another legacy endpoint. Its routing/isolation tests are retained.

There are 54 concrete methods: 27 operational Sheets writers, 1 generator writer, 17 read/status methods, 2 QR POST renderers, 4 cookie/state auth methods, 1 OAuth-exchange GET, and 2 unsupported methods. The existing tenant-authority inventory also has exactly these 54 method/path pairs; it intentionally classifies legacy admin login differently because DB tenant login persists a tenant session.

| Method | API suffix | Legacy effect and freeze decision |
| --- | --- | --- |
| POST | `/admin/login` | ALLOW: local session/state-cookie issuance or clearing; legacy admin login reads Settings but does not save credentials. |
| POST | `/admin/logout` | ALLOW: local session/state-cookie issuance or clearing; legacy admin login reads Settings but does not save credentials. |
| GET | `/bank/balance` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| GET | `/bank/student` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| GET | `/bank/tasks` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| POST | `/checkout` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| POST | `/checkout/preview` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| POST | `/generator/create` | BLOCK: consumes global PostgreSQL generator grant claim, creates a new Sheet and may revoke an OAuth grant on failure. Guard applies even with platform PostgreSQL storage. |
| GET | `/generator/grant` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| GET | `/google/callback` | ALLOW: GET is not side-effect-free: exchanges/revokes OAuth grants and sets/clears cookies, but does not mutate source Sheets or claim registry. |
| GET | `/google/login` | ALLOW: local session/state-cookie issuance or clearing; legacy admin login reads Settings but does not save credentials. |
| POST | `/google/logout` | ALLOW: local session/state-cookie issuance or clearing; legacy admin login reads Settings but does not save credentials. |
| GET | `/google/session` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| GET | `/products` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| POST | `/products` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| DELETE | `/products/[productId]` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| PATCH | `/products/[productId]` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| DELETE | `/products/batch` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| PATCH | `/products/batch` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| GET | `/promotions` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| POST | `/promotions` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| DELETE | `/promotions/[promotionId]` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| PATCH | `/promotions/[promotionId]` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| GET | `/promotions/active` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| GET | `/qrcode` | UNCHANGED: existing 405, not a writable compatibility path. |
| POST | `/qrcode` | ALLOW: local QR rendering only (student/admin credential or system link); existing strict body-only validation remains. |
| POST | `/qrcode/link` | ALLOW: local QR rendering only (student/admin credential or system link); existing strict body-only validation remains. |
| GET | `/settings` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| PATCH | `/settings` | UNCHANGED: existing 405, not a writable compatibility path. |
| POST | `/settings` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| GET | `/students` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| POST | `/students` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| DELETE | `/students/[studentId]` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| GET | `/students/[studentId]` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| PATCH | `/students/[studentId]` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| DELETE | `/students/batch` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| PATCH | `/students/batch` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| PATCH | `/students/bulk` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| GET | `/tasks` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| POST | `/tasks` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| DELETE | `/tasks/[taskId]` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| GET | `/tasks/[taskId]` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| PATCH | `/tasks/[taskId]` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| GET | `/tasks/[taskId]/assignments` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| PATCH | `/tasks/[taskId]/assignments` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| POST | `/tasks/[taskId]/complete` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| GET | `/tasks/[taskId]/history` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| POST | `/tasks/assignments/batch` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| DELETE | `/tasks/batch` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| PATCH | `/tasks/batch` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| POST | `/tasks/completions/reset` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| POST | `/tasks/schedules/batch` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |
| GET | `/transactions` | ALLOW: read-only projection/status; existing authentication and validation remain. |
| POST | `/transactions/[transactionId]/cancel` | BLOCK: legacy operational Sheets command; before parsing, schema initialization, atomic claims or any batch iteration. |

## Concrete side-effect call graph audit

- Money: checkout → configured checkout → Sheets balance/stock/immutable-ledger command; student bulk → configured adjustment; transaction cancel → configured cancellation and linked completion reversal; student detail/batch → direct Sheets balance/detail mutation. All paths are guarded before constructing their commands/stores.
- Admin definitions: products, students, promotions (including link rows), settings/password saves, tasks, schedules, assignments, reset and deletion call configured creators or direct Sheets commands. Both branches of mixed-method routes and every batch method are individually guarded. Additive/recurring schema migrations and Sheet creation/header writes are downstream of these commands, not ordinary reads.
- Task reward: configured Sheets completion → `completeTaskForStudent` → queued legacy completion command, schema/history reads, Sheet atomic mutation/named-range operation claim, reward/ledger writes. All are below the route guard. The current legacy branch does **not** call the removed historical Redis Padlet writer. The current PostgreSQL branch uses database Padlet claims and retains its existing transaction authority.
- Redis: the only production deployment Redis HTTP acquisition code at this revision is in `legacyMigrationBridge.ts`, not an exported route. It performs bounded snapshot reads (`SCAN`, `HSCAN`, `GET`) using deployment-local configuration. The bridge's separate deployment-control freeze protocol remains unchanged. No new Redis writer was introduced or invoked; old deployments and their historical Redis writers still require independent disable/readback proof. Local route tests install a throwing fetch sentinel, not a real Redis client.
- Generator: `/generator/create` claims a PostgreSQL one-time grant **before** parsing its body in the old flow, then creates/populates a Sheet and clears cookies or revokes grants. Therefore it has an explicit Sheets-writer guard before even entering its existing try block, not a generic DB-storage exemption.
- Auth: legacy `/admin/login` reads settings and signs a cookie, no Sheet password writeback. Logout only clears cookies. Google login GET writes OAuth state cookies; callback GET exchanges tokens, may revoke a failed generator grant, and changes cookies. They are preserved to support independent authentication/read administration; they are not source-data writer authority. Generator grant GET only inspects the local grant/session.
- QR: student/admin QR POSTs perform validation/auth/read/sign/render only. System-link QR is a separate renderer. Neither is redirected to the migration target. The prior unsupported credential-bearing QR GET stays 405.
- No server-action, cron route or other app route writer exists outside this concrete API inventory at this revision. Standalone generator CLI and migration bridge/library code are not user-request composition roots and are not claimed to be disabled by the flag.

## Local evidence and scope

- `legacyWriteFreezeRoutes.test.ts`: exact filesystem/tenant-inventory equality; first-operation AST checks; all 28 concrete handlers return the exact refusal without body consumption, Sheet SDK calls, fetch/Redis calls, redirect or cookies; partial-batch and reward payloads; generator global-claim ordering; normal validation/logout remain.
- `legacyWriteFreezeReads.test.ts`: all 17 operational/QR read methods succeed through real handlers, configured repositories, domain readers and GoogleSheetsStore backed only by a local SDK fixture. Tests include legacy task headers and absent assignments without schema writes, login cookie preservation, and a real local-fixture Sheet mutation when unset followed by refusal with unchanged rows under freeze.
- `legacyWriteFreezeTenant.test.ts`: actual canonical dispatcher → configured checkout → SQL command using isolated PGlite; verifies balance/stock mutation while legacy freeze is enabled, denies nonmembership and untrusted header bypass, and makes no external request.
- `legacyDeploymentMode.test.ts` and `LegacyMigrationBanner.test.tsx`: fail-closed configuration, safe target validation, no credential/query forwarding, runtime notice wiring and scoped-page exclusion.

## Not freeze proof / reserved Task 19 gates

This per-request code cannot drain already-running requests, stop another deployment or direct human Sheet writes, revoke old write credentials, prove historical Redis writers disabled, or certify source freshness. Do **not** treat this flag, a local test pass, a banner, or Task 17 READY as a freeze proof or cutover approval. No live configuration was changed for these tests.

Before final acquisition/cutover, explicitly approved operations must install/verify the compatibility update on every writer or disable the old deployment/revoke its writer credential; restrict direct human Sheet writes; drain/verify in-flight work; probe the complete deployed mutation inventory; record fresh, time-bounded authoritative disable/readback evidence; and capture fresh Sheet and Redis fingerprints. Task 19 must reject missing/stale proof or changed sources. Custom deployments that cannot receive this code remain blocked until equivalent manual controls and proof exist. No automatic source repair, source deletion, live freeze or tenant activation is implemented here.
