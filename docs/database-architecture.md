# PostgreSQL 데이터베이스 아키텍처

> 구현된 데이터베이스 경계와 아직 완료되지 않은 전환 경로를 구분한다. 이 문서는 운영 배포·마이그레이션 완료 또는 실제 DB 권한 검증을 의미하지 않는다. 인용 링크는 저장소 소스이며 검토 시점의 바이트 식별자는 부록에 있다.

## 1. 구성과 권위 흐름

```text
/c/<slug>, /api/c/<slug>/…
  → canonical slug + 서버 tenant directory
  → 경로별 read 또는 identity/membership 기반 admin 검사
  → AsyncLocalStorage의 trusted request context
  → PostgreSQL repository authority (운영 경로는 ACTIVE)
  → tenant transaction + app.tenant_id
  → tenant 명시 SQL + composite FK + FORCE RLS

명시적 unscoped compatibility → 별도 환경 기반 storage 선택
마이그레이션 서비스 → 서비스별 lifecycle/job 검사 (운영 ACTIVE gate와 별개)
```

- slug는 소문자 canonical 값으로 해석하며 directory 결과의 slug/UUID도 재검사한다. URL 경로가 tenant 선택의 출발점이다. body/query/header는 admin context의 tenant 후보가 아니다. [tenantContext.ts:48–89](../src/server/tenantContext.ts#L48-L89) [tenantAuth.ts:83–109](../src/server/tenantAuth.ts#L83-L109)
- dispatcher는 경로별 admin/read 요구를 선택하고 요청-local context 안에서 handler를 실행한다. 모든 read에 관리자 membership을 요구한다고 일반화하지 않는다. context는 `AsyncLocalStorage`이며 client cookie의 전역 선택 값이 아니다. [tenantApiDispatcher.ts:30–60](../src/server/tenantApiDispatcher.ts#L30-L60) [trustedTenantRequestContext.ts:14–30](../src/server/trustedTenantRequestContext.ts#L14-L30)
- configured repository는 trusted tenant가 있으면 `postgresql`과 그 tenant lifecycle을 우선한다. context가 없을 때만 명시적 compatibility 환경을 읽는다. `CLASS_STORE_STORAGE`는 정확히 `postgresql` 또는 `sheets`; Sheets 선택에 central tenant를 섞으면 거부한다. PostgreSQL 운영 authority는 유효 UUID와 정확히 `ACTIVE`를 요구한다. 선택한 adapter 오류를 다른 adapter로 복구하는 factory 경로는 없다. [configuredRepository.ts:24–47](../src/server/repositories/configuredRepository.ts#L24-L47) [context.ts:23–49](../src/server/repositories/context.ts#L23-L49) [context.ts:78–96](../src/server/repositories/context.ts#L78-L96) [factory.ts:25–47](../src/server/repositories/factory.ts#L25-L47)

## 2. 인증과 tenant 권한은 다르다

- `users`는 Google subject/정규화 email이 unique인 플랫폼 identity다. `tenant_memberships`는 tenant/user unique 및 `OWNER|ADMIN` 역할을 가진다. Google 로그인 성공만으로 다른 tenant의 관리자가 되지 않는다. admin 검사는 선택 tenant와 session subject에 해당하는 membership의 두 바인딩과 역할을 다시 확인한다. [0001_identity_tenants.sql:1–51](../src/server/db/migrations/0001_identity_tenants.sql#L1-L51) [tenantAuth.ts:42–68](../src/server/tenantAuth.ts#L42-L68)
- 예상 가능한 `UNAUTHENTICATED`/`NOT_A_MEMBER`에 한해서 정확한 tenant의 compatibility session을 별도로 허용한다. mismatch나 인프라 오류를 삼키는 fallback은 아니다. production compatibility 세션은 tenant, 만료/폐기, session version, 현재 credential version을 검증한다. ACTIVE에서는 credential version이 1보다 커야 한다. 이는 credential 회전의 소비 조건이지 activation 구현 증거가 아니다. [tenantAuth.ts:95–104](../src/server/tenantAuth.ts#L95-L104) [tenantAccess.ts:66–70](../src/server/tenantAccess.ts#L66-L70) [tenantLegacyAdminAuth.ts:106–122](../src/server/tenantLegacyAdminAuth.ts#L106-L122) [tenantLegacyAdminAuth.ts:146–157](../src/server/tenantLegacyAdminAuth.ts#L146-L157)
- identity OAuth와 generator consent는 별도 생성 함수/범위다. freezing consent도 명시적 서버 origin/Sheet 등록과 별도 production factory를 요구한다. membership, generator grant, source 소유 증명, 동의 영수증을 서로의 권한으로 승격하지 않는다. [googleOAuth.ts:121–137](../src/server/googleOAuth.ts#L121-L137) [freezingConsentProduction.ts:7–38](../src/server/migration/freezingConsentProduction.ts#L7-L38)
- bootstrap은 검증된 source-control proof를 읽고 transaction 안에서 user, DRAFT tenant, 첫 OWNER membership, 지원 credential hash, DISCOVERED job, source binding을 기록한다. `(provider, external_source_id)`의 전역 unique 제약은 source 중복 등록 경계다. 이 서비스의 존재는 runtime bootstrap ACL이 설치됐다는 뜻이 아니다. [tenantBootstrap.ts:61–143](../src/server/repositories/database/tenantBootstrap.ts#L61-L143) [0003_operations_migrations.sql:170–185](../src/server/db/migrations/0003_operations_migrations.sql#L170-L185)

## 3. 데이터 모델과 무결성

| 영역 | 실제 관계/역할 | 근거 |
|---|---|---|
| Identity / tenant | `users`, `tenants`, membership, credential hash, tenant session, settings/extras | [0001_identity_tenants.sql:1–121](../src/server/db/migrations/0001_identity_tenants.sql#L1-L121) |
| 학생 / 잔액 | `students`와 `accounts`; `(tenant_id, student_id)` PK/FK, balance/version bigint 범위 | [0002_operational.sql:5–29](../src/server/db/migrations/0002_operational.sql#L5-L29) |
| 상점 | `products`, `promotions`, `promotion_products` | [0002_operational.sql:32–117](../src/server/db/migrations/0002_operational.sql#L32-L117) |
| 과제 / 이벤트 | `tasks`, `task_allowed_students`, `task_assignments`, `task_completions`; cycle/student/event 인덱스 | [0002_operational.sql:118–229](../src/server/db/migrations/0002_operational.sql#L118-L229) [0002_operational.sql:381–467](../src/server/db/migrations/0002_operational.sql#L381-L467) |
| 금융 / 재고 | `transactions`, `transaction_items`, `adjustments`, `inventory_ledger`; 과거 스냅샷과 증감 보존 | [0002_operational.sql:230–380](../src/server/db/migrations/0002_operational.sql#L230-L380) |
| 작업 / 감사 | tenant + operation ID, payload hash, 상태/결과 스냅샷; `audit_events` | [0003_operations_migrations.sql:11–53](../src/server/db/migrations/0003_operations_migrations.sql#L11-L53) [0003_operations_migrations.sql:256–270](../src/server/db/migrations/0003_operations_migrations.sql#L256-L270) |
| 마이그레이션 | jobs, sources, source-record checkpoints, snapshots, reconciliation results, exports | [0003_operations_migrations.sql:124–287](../src/server/db/migrations/0003_operations_migrations.sql#L124-L287) |
| 전역 중복 방지 | Padlet claim/digest registry/tombstone; 일반 tenant-local 데이터와 다른 전역 키 공간 | [0003_operations_migrations.sql:55–122](../src/server/db/migrations/0003_operations_migrations.sql#L55-L122) |

금전 데이터는 bigint와 JS safe-integer 제약을 사용한다. 모든 bigint를 무검사 Number로 바꾸지 않는다. 학생 query는 tenant를 명시한 join/where와 DTO 무결성 검사를 갖는다. [0002_operational.sql:1–29](../src/server/db/migrations/0002_operational.sql#L1-L29) [studentQueries.ts:24–60](../src/server/repositories/database/studentQueries.ts#L24-L60) [studentQueries.ts:88–97](../src/server/repositories/database/studentQueries.ts#L88-L97)

SQL migration과 Drizzle schema는 함께 읽어야 한다. 예를 들어 현재 `tenant_settings.version`과 admin operation kinds는 baseline 뒤의 additive migration을 반영한다. ORM export가 있다고 RLS/trigger/실제 DB 적용까지 증명되지는 않는다. [tenants.ts:132–147](../src/server/db/schema/tenants.ts#L132-L147) [operations.ts:7–38](../src/server/db/schema/operations.ts#L7-L38) [0004_admin_operation_kinds.sql:1–18](../src/server/db/migrations/0004_admin_operation_kinds.sql#L1-L18) [0005_mutable_entity_versions.sql:1–34](../src/server/db/migrations/0005_mutable_entity_versions.sql#L1-L34)

transactions/adjustments는 UPDATE/DELETE 방지 trigger가 있고, snapshot에는 UPDATE/DELETE뿐 아니라 TRUNCATE 방지도 있다. **모든 테이블에 같은 append-only/TRUNCATE 보장이 있다고 읽으면 안 된다.** retained snapshot에 도달하는 parent CASCADE 삭제도 거부되므로 retention 삭제는 별도 승인 절차다. [0006_immutable_ledger_guards.sql:1–15](../src/server/db/migrations/0006_immutable_ledger_guards.sql#L1-L15) [0016_migration_snapshots_immutable.sql:1–14](../src/server/db/migrations/0016_migration_snapshots_immutable.sql#L1-L14)

## 4. RLS와 DB 역할 분리

tenant 테이블 정책은 `NULLIF(current_setting('app.tenant_id', true), '')::uuid`와 행 tenant를 비교하고 `USING`/`WITH CHECK` 모두 적용한다. operational 테이블은 ENABLE + FORCE RLS를 설정한다. 설정 누락/빈 값은 tenant 일치를 만들지 않으며 잘못된 UUID는 cast 오류가 될 수 있다. RLS는 **이 설정의 사용자 권한을 인증하지 않는다**. trusted context와 비특권 runtime을 함께 유지해야 한다. [0001_identity_tenants.sql:124–158](../src/server/db/migrations/0001_identity_tenants.sql#L124-L158) [0002_operational.sql:474–491](../src/server/db/migrations/0002_operational.sql#L474-L491)

| 역할 경계 | 소스가 정의한 계약 | 설치 여부 |
|---|---|---|
| 중앙 runtime | nonowner, NOSUPERUSER, NOBYPASSRLS; 필요한 최소 DML/lock 권한, DDL·trigger-disable·TRUNCATE 금지 | 이번 문서 작업에서 확인하지 않음 |
| migration / discovery owner | migration 0012 실행자는 superuser 또는 BYPASSRLS여야 함. FORCE RLS 아래 일반 table owner만으로 discovery 우회 불가 | 실제 owner/ACL 미조회 |
| discovery 호출자 | 정확한 함수 signature의 EXECUTE만 별도 provision; PUBLIC 실행권한은 migration에서 revoke | 주석의 GRANT 계약 ≠ 실행된 GRANT |
| companion producer | tenant runtime과 다른 연결/로그인; role 이름 = 등록 deployment ID, NOSUPERUSER NOBYPASSRLS NOINHERIT, 필요한 schema USAGE와 replay SELECT/INSERT | 실제 계정/등록 미확인 |

근거: [0012_platform_tenant_discovery.sql:1–17](../src/server/db/migrations/0012_platform_tenant_discovery.sql#L1-L17) [0012_platform_tenant_discovery.sql:82–92](../src/server/db/migrations/0012_platform_tenant_discovery.sql#L82-L92) [0016_migration_snapshots_immutable.sql:11–14](../src/server/db/migrations/0016_migration_snapshots_immutable.sql#L11-L14) [0020_bridge_producer_reservations.sql:1–5](../src/server/db/migrations/0020_bridge_producer_reservations.sql#L1-L5).

pre-context discovery는 `platform_find_tenant_by_slug(text)`, `platform_find_membership_by_tenant_and_google_subject(uuid,text)`, `platform_list_memberships_by_google_subject(text)`의 좁은 SQL SECURITY DEFINER 함수다. `search_path=pg_catalog`, `public.*` 명시 관계, exact slug/subject 조건을 사용한다. runtime BYPASSRLS 부여로 discovery를 해결하는 구조가 아니다. [0012_platform_tenant_discovery.sql:19–85](../src/server/db/migrations/0012_platform_tenant_discovery.sql#L19-L85) [tenantAccess.ts:46–63](../src/server/tenantAccess.ts#L46-L63)

전역 `users`, Padlet registry, generator claim을 tenant RLS 적용 테이블로 뭉뚱그리지 않는다. companion replay는 tenant GUC 대신 `deployment_id=current_user::text` 정책을 사용한다. 동일 nonce/challenge 키 공간은 start/read phase에 걸쳐 유지되고 중앙 tenant/start FK를 갖지 않는 deployment-local ledger다. [0001_identity_tenants.sql:1–14](../src/server/db/migrations/0001_identity_tenants.sql#L1-L14) [0003_operations_migrations.sql:55–122](../src/server/db/migrations/0003_operations_migrations.sql#L55-L122) [0011_generator_grant_claims.sql:1–28](../src/server/db/migrations/0011_generator_grant_claims.sql#L1-L28) [0020_bridge_producer_reservations.sql:25–42](../src/server/db/migrations/0020_bridge_producer_reservations.sql#L25-L42) [0022_freezing_producer_reservations.sql:1–25](../src/server/db/migrations/0022_freezing_producer_reservations.sql#L1-L25)

## 5. 연결, transaction, 불확실한 COMMIT

- `pg.Pool` + Drizzle를 lazy singleton으로 만들고 Vercel `attachDatabasePool`에 연결한다. runtime은 `DATABASE_URL`; migration config는 `DIRECT_DATABASE_URL` 우선, 없으면 `DATABASE_URL`이다. **변수 이름이 실제 DB 역할 분리를 강제하지 않는다.** [client.ts:24–84](../src/server/db/client.ts#L24-L84) [config.ts:14–25](../src/server/db/config.ts#L14-L25) [drizzle.config.ts:1–14](../drizzle.config.ts#L1-L14)
- tenant runner는 connection 한 개에서 BEGIN → transaction-local `set_config(..., true)` → callback → COMMIT 순서다. 기본 옵션명 `READ COMMITTED` 분기는 실제로 평범한 `BEGIN`을 보낸다. 따라서 DB session default가 READ COMMITTED인지 별도 확인해야 하며 옵션명만으로 단정할 수 없다. snapshot runner는 명시적 `BEGIN ISOLATION LEVEL REPEATABLE READ`를 사용한다. [transaction.ts:83–91](../src/server/db/transaction.ts#L83-L91) [transaction.ts:114–141](../src/server/db/transaction.ts#L114-L141) [transaction.ts:197–204](../src/server/db/transaction.ts#L197-L204)
- 기본 최대 3회, 기본 지연 10ms이며 SQLSTATE `40001`만 제한 재시도한다. callback은 재실행될 수 있다. 외부 writer disable/send 같은 효과를 일반 retry callback에 넣으면 안 된다. freezing consent production은 별도 `maxAttempts: 1` runner를 선택한다. [transaction.ts:67–90](../src/server/db/transaction.ts#L67-L90) [transaction.ts:157–166](../src/server/db/transaction.ts#L157-L166) [freezingConsentProduction.ts:33–35](../src/server/migration/freezingConsentProduction.ts#L33-L35)
- COMMIT 응답 실패 후 ROLLBACK ACK가 와도 원래 COMMIT 결과는 확정되지 않는다. COMMIT 시도 중 오류가 발생한 연결 또는 rollback 실패 연결은 `release(true)`로 폐기한다. 성공 commit 뒤 release 오류는 관측 처리하며 성공을 실패로 바꾸지 않는다. **DB 예외 = 미커밋**으로 해석하지 않는다. [transaction.ts:142–180](../src/server/db/transaction.ts#L142-L180)
- checkout은 tenant/operation ID를 claim하고 kind/hash를 대조하며 기존 성공의 저장 결과와 audit를 검사한다. 재시도는 같은 operation identity의 의미를 유지해야 한다. 이는 해당 command의 idempotency 경계이지 외부 provider 전체의 exactly-once 보장이 아니다. [checkoutCommands.ts:90–154](../src/server/repositories/database/checkoutCommands.ts#L90-L154)

## 6. import staging과 activation의 분리

1. **Import:** unblocked manifest를 검증하고 tenant/job/source/manifest binding을 잠근다. 원본 checkpoint staging, 운영 target, checkpoint 완료를 각각 restartable batch transaction으로 기록한다. 전체 import가 하나의 transaction은 아니므로 뒤 batch 실패가 앞서 commit된 batch까지 되돌리지는 않는다. 반환 상태는 IMPORTING이다. [importer.ts:134–177](../src/server/migration/importer.ts#L134-L177) [importer.ts:1324–1372](../src/server/migration/importer.ts#L1324-L1372)
2. **미공개 evidence:** `padlet_evidence_claims`, `padlet_claim_digest_tombstones`, `legacy_operation_bindings`는 deferred다. import 성공으로 전역 claim을 publish하거나 legacy binding을 현대 `operations` 권한으로 바꾸지 않는다. [importer.ts:13–17](../src/server/migration/importer.ts#L13-L17) [importer.ts:114–132](../src/server/migration/importer.ts#L114-L132)
3. **Preparatory READY:** `reconcileLegacyImport`는 잠긴 source/SQL/operational projection 비교이고 자체 write는 없다. `prepareLegacyImportReady`는 같은 transaction에서 immutable audit report를 기록하고, `MATCHED_PREFLIGHT`일 때 job READY 전이를 readback한다. BLOCKED도 반환할 수 있으며 이미 READY인 job에 binding-valid drift가 있으면 FAILED로 전환한다. report에는 `BOUND_SNAPSHOT_NOT_LIVE_FREEZE`를 기록한다. tenant는 IMPORTING에 머문다. source manifest의 자기 hash나 READY report는 live freshness/freeze 증명이 아니다. [reconcile.ts:13–35](../src/server/migration/reconcile.ts#L13-L35) [reconcile.ts:79–143](../src/server/migration/reconcile.ts#L79-L143) [importer.ts:1364–1372](../src/server/migration/importer.ts#L1364-L1372)
4. **Final-generation 준비:** `stageLegacyFinalGeneration`은 원본/candidate/plan audit envelope만 저장하며 `UNTRUSTED_PREPARATION`이다. `DIFF_VALIDATED`는 canonical 차이 검증일 뿐 실행 가능한 SQL delta나 최종 승인권이 아니다. [finalGeneration.ts:30–34](../src/server/migration/finalGeneration.ts#L30-L34) [finalGeneration.ts:60–93](../src/server/migration/finalGeneration.ts#L60-L93)
5. **현재 구현된 FREEZING start:** fresh intake 바인딩, dispatch/nonce/capture, audit/execution exact readback 뒤 job READY→FREEZING CAS를 수행한다. final fingerprint/freeze verified/completed 필드는 NULL로 검사하며 결과는 `exclusion: NOT_PROVEN`, 자동 재시도/enable false다. FREEZING을 maintained writer exclusion으로 읽지 않는다. [startFreezing.ts:95–137](../src/server/migration/startFreezing.ts#L95-L137)
6. **현재 진단 reacquisition:** candidate는 `NONAUTHORITY`, `NOT_PROVEN`, `finalImportEligible:false`다. 별도 final fresh consent/acquisition, maintained exclusion, final import/reconciliation, activation은 아직 지원 완료 상태가 아니다. 기존 상세 문서의 시험 수치/승인 서술은 이 초안의 검증 결과로 재사용하지 않는다. [freezingReacquisitionIntake.ts:246–250](../src/server/migration/freezingReacquisitionIntake.ts#L246-L250) [migration-freezing-reacquisition-intake.md:64–70](architecture/migration-freezing-reacquisition-intake.md#L64-L70)

SQL job 상태 제약은 DISCOVERED/VALIDATED/IMPORTING/RECONCILING/READY/FREEZING/FINAL_IMPORT/ACTIVE/FAILED/ABORTED와 전이를 정의한다. **FINAL_IMPORT/ACTIVE가 enum/check에 있다는 사실은 해당 실행 서비스가 완성됐다는 뜻이 아니다.** tenant lifecycle와 job status도 별개 상태다. [0003_operations_migrations.sql:124–168](../src/server/db/migrations/0003_operations_migrations.sql#L124-L168) [tenants.ts:17–24](../src/server/db/schema/tenants.ts#L17-L24)

## 7. 중단·rollback·retention

- bounded cutover abort는 tenant→job lock, 최신 identity membership, expected status/version/fingerprint 검사와 audit/readback을 거쳐 ABORTED만 기록한다. `externalCleanup: NOT_PERFORMED`; writer 재활성화, grant 삭제, storage rollback은 하지 않는다. [cutover.ts:37–98](../src/server/migration/cutover.ts#L37-L98)
- start local transaction rollback은 앞선 consent/bridge replay 증거나 이미 disable된 외부 writer를 복구하지 않는다. UNKNOWN은 자동 resend/enable 허가가 아니다. archival read는 사실 조회이며 승인 capability를 되살리지 않는다. [migration-freezing-start.md:29–41](architecture/migration-freezing-start.md#L29-L41)
- **앱 버전 rollback과 저장소 rollback은 다르다.** 전자는 PostgreSQL authority를 유지한다. Sheets 복귀는 DB write freeze, 모든 post-cutover delta export/apply, 전체 정합성 확인, authority 전환 뒤 legacy writer 재개라는 별도 통제 migration이다. stale Sheet URL로 직접 돌아가면 안 된다. 이 순서는 원래 계획의 요구사항이며 현재 실행 가능한 runbook/구현 완료 주장도 아니다. [2026-08-28-postgres-multitenant-migration.md:257–263](plans/2026-08-28-postgres-multitenant-migration.md#L257-L263)
- retained snapshot/audit/preparation에는 학생·이력·지원 credential hash가 남을 수 있다. redaction은 익명화가 아니다. snapshot parent 삭제와 permanent producer replay 삭제를 일반 housekeeping으로 취급하지 않는다. retention/access/backup/예외 삭제 승인은 별도다. [migration-final-generation-preparation.md:37–39](architecture/migration-final-generation-preparation.md#L37-L39) [0016_migration_snapshots_immutable.sql:1–14](../src/server/db/migrations/0016_migration_snapshots_immutable.sql#L1-L14) [0022_freezing_producer_reservations.sql:20–25](../src/server/db/migrations/0022_freezing_producer_reservations.sql#L20-L25)

## 8. 운영 검증과 남은 경계

- 소스에 정의된 계약과 실제 DB 적용 상태는 다르다. 적용 migration, grants, owner/role flags, session isolation, backup 복원 가능성은 별도 운영 검증 대상이다.
- 이 문서는 전체 route/SQL/ORM parity 감사나 독립 connection race 검증 결과가 아니다. full test/build, 실제 PostgreSQL 및 tenant 격리 검증은 원래 계획의 Task23 gate에 남는다. [2026-08-28-postgres-multitenant-migration.md:273–287](plans/2026-08-28-postgres-multitenant-migration.md#L273-L287)
- maintained external writer exclusion, final-purpose fresh consent/acquisition, final operational delta 적용·정합성·전역 claim publication·activation 및 storage rollback 실행은 아직 완료되지 않았다.
- live freeze/activation/canary/data 변경은 별도 명시적 승인이 필요하다. 배포 준비나 이 문서의 존재는 운영 권한을 부여하지 않는다. [2026-08-28-postgres-multitenant-migration.md:289–307](plans/2026-08-28-postgres-multitenant-migration.md#L289-L307)

## 부록: 검토 소스 식별자

아래 SHA-256은 검토한 전체 파일의 원시 바이트 기준이다. 저장소 상대 링크는 향후 변경될 수 있으므로 행 링크만을 immutable 증거로 사용하지 않는다. 문서를 갱신할 때 관련 source hash와 설명을 함께 재검토한다.

| 소스 | SHA-256 |
|---|---|
| [docs/architecture/migration-final-generation-preparation.md](architecture/migration-final-generation-preparation.md) | `7eb46f24151aac77b9e0e722a4d560adfb76bd01db723066cf4eaabe37e53fe2` |
| [docs/architecture/migration-freezing-reacquisition-intake.md](architecture/migration-freezing-reacquisition-intake.md) | `7d322e73c812cf5a61429004f663e1587bb33bb81139db8a228b4f1af55322f0` |
| [docs/architecture/migration-freezing-start.md](architecture/migration-freezing-start.md) | `d2460d3acc47e93991cd302e86d80ef600c2c06b497ed4769e64154e7d3631ac` |
| [docs/plans/2026-08-28-postgres-multitenant-migration.md](plans/2026-08-28-postgres-multitenant-migration.md) | `aeaaf4ffdbbad5a2f49a4954daecd0e8f25b85e9a727dc7ff11564c09ac5caeb` |
| [drizzle.config.ts](../drizzle.config.ts) | `6319915de47ab9d87998ffaccf3326d90e39fccc2cff55d2a107429f70dcb9c3` |
| [src/server/db/client.ts](../src/server/db/client.ts) | `8e7156e2f8ca70dfb99cfae77bb4368658eb555d7c3a225a20f00bfbe0f992fc` |
| [src/server/db/config.ts](../src/server/db/config.ts) | `eb3f57728e4eeaf509c4a5ea05350334da7980d17004d3310478c6a35b73e853` |
| [src/server/db/migrations/0001_identity_tenants.sql](../src/server/db/migrations/0001_identity_tenants.sql) | `b397b7470f86b7d2a1ffbcb9d28e6d5e5d0e93e9bcf4ae2b7deea39c85645e70` |
| [src/server/db/migrations/0002_operational.sql](../src/server/db/migrations/0002_operational.sql) | `319640a1433e670e507111368ec03e18ed4a0bc675b940a4d4ce790f00119c28` |
| [src/server/db/migrations/0003_operations_migrations.sql](../src/server/db/migrations/0003_operations_migrations.sql) | `dae0450cb63964cc8568df07d93377420e704017c488aca8460f06653a7f7fa2` |
| [src/server/db/migrations/0004_admin_operation_kinds.sql](../src/server/db/migrations/0004_admin_operation_kinds.sql) | `91ecda0d2746ea6ab93bc19036fd0be163e613a54a19ca05119a898eb680346f` |
| [src/server/db/migrations/0005_mutable_entity_versions.sql](../src/server/db/migrations/0005_mutable_entity_versions.sql) | `3b65abb7de514c30940521f7d8008da6d4b314e14c07f8dd7917e69c5006be17` |
| [src/server/db/migrations/0006_immutable_ledger_guards.sql](../src/server/db/migrations/0006_immutable_ledger_guards.sql) | `aabe0cfd0666adf6ee0e27c2fd8c8b7c7c96884088b6244827708780c7b11e59` |
| [src/server/db/migrations/0011_generator_grant_claims.sql](../src/server/db/migrations/0011_generator_grant_claims.sql) | `ec33fdc8f9256984e59147bb3fa97e4b2f79d0dd5fcd5d7b6caca5663398a8c7` |
| [src/server/db/migrations/0012_platform_tenant_discovery.sql](../src/server/db/migrations/0012_platform_tenant_discovery.sql) | `6605711b09e1e7de5528de7c4ff5562d56dfafab7455a92183efd3f3f9bafe86` |
| [src/server/db/migrations/0016_migration_snapshots_immutable.sql](../src/server/db/migrations/0016_migration_snapshots_immutable.sql) | `6189311e83533d44a2f6fe32cb7f4fa08dfe5e7af06e448116c614e2f5f059a2` |
| [src/server/db/migrations/0020_bridge_producer_reservations.sql](../src/server/db/migrations/0020_bridge_producer_reservations.sql) | `467dbb54b693b83e77491c3891eec6ca8c089fd55a410f57bd1defc0c464e568` |
| [src/server/db/migrations/0022_freezing_producer_reservations.sql](../src/server/db/migrations/0022_freezing_producer_reservations.sql) | `e2649282e561b30a827f912e2e73042e5fcd37d95aa9609ecd1f8d267642487d` |
| [src/server/db/schema/operations.ts](../src/server/db/schema/operations.ts) | `14f56ccf0199268814f5e4ced1dd09bf890aec7013fe68d0a4f6b6dd50c6a9d1` |
| [src/server/db/schema/tenants.ts](../src/server/db/schema/tenants.ts) | `8bd94a6d1f8eccd334f2c9ed79c8a22cb1f9ba377dabf78ff263473bf1956204` |
| [src/server/db/transaction.ts](../src/server/db/transaction.ts) | `09170a8d427078c61d8e560b72542b9000d3d8177196760a2186550c19d1bfed` |
| [src/server/googleOAuth.ts](../src/server/googleOAuth.ts) | `5b7fe3c88cbc6bc35ce7da95aae4f16636d4ca5688d91f94f59804848ab743ac` |
| [src/server/migration/cutover.ts](../src/server/migration/cutover.ts) | `4b5fefeb5c8f41c7843c49fd1b78e602c88a1b664ff73554bf51091ad25deca7` |
| [src/server/migration/finalGeneration.ts](../src/server/migration/finalGeneration.ts) | `07e89f82351a3c59e5c0d167010fd818a23d1e32ee6e8c5eae3d2f6a5aedb08a` |
| [src/server/migration/freezingConsentProduction.ts](../src/server/migration/freezingConsentProduction.ts) | `c7d2d4931c1b761f5e67990f4245d7ed25544772ca9b0a6c1f2fc36ebd64c033` |
| [src/server/migration/freezingReacquisitionIntake.ts](../src/server/migration/freezingReacquisitionIntake.ts) | `73411a9efa894a2696afae6b18906aac1661579c07fd0aa44ab92ef6e8edf8b9` |
| [src/server/migration/importer.ts](../src/server/migration/importer.ts) | `c96aaf9d54ad7e324b3a4658ed10cebb4e0df9b005341f60654eb6fc065a4f40` |
| [src/server/migration/reconcile.ts](../src/server/migration/reconcile.ts) | `9ed4997849b72ae5988704a50d654ef3fbe0d3b90974170256a3a6d77e90e203` |
| [src/server/migration/startFreezing.ts](../src/server/migration/startFreezing.ts) | `85283e5bcf9b630f05f17fd7dfe496fada1841078b05af6eebbc51b451d388c3` |
| [src/server/repositories/configuredRepository.ts](../src/server/repositories/configuredRepository.ts) | `9080a87012a0f4f8fb14120e9e015d787fe47745e656e97a7773a18dd8033fea` |
| [src/server/repositories/context.ts](../src/server/repositories/context.ts) | `d1240a2e2efd5a24c17157c25d4c19cd52d05ba9b1aded3936b0fd8df8bec4b8` |
| [src/server/repositories/database/checkoutCommands.ts](../src/server/repositories/database/checkoutCommands.ts) | `90a938d26e6e4cc7e19fbf3121392d1a7fd2f64d4ba9ea5983989d6d94c5392d` |
| [src/server/repositories/database/studentQueries.ts](../src/server/repositories/database/studentQueries.ts) | `cceab8a390773f11aca3dea68a68699507750097ffafbecb8b1a2704dfc18ff1` |
| [src/server/repositories/database/tenantBootstrap.ts](../src/server/repositories/database/tenantBootstrap.ts) | `462e461b5826c4f091a77059b5c25b3e613a640afd1326645db54f29627c6447` |
| [src/server/repositories/factory.ts](../src/server/repositories/factory.ts) | `b77927c09fbb6c429929cd32e6693d6d94f61d3a20c29f9c4435f4a3b9259482` |
| [src/server/tenantAccess.ts](../src/server/tenantAccess.ts) | `767b836b2d30d9193ccc1c06a562f8126f430e9ef26435fbce20b55cad6457fe` |
| [src/server/tenantApiDispatcher.ts](../src/server/tenantApiDispatcher.ts) | `bd516c6ec6ada478cb19a0e5f20c59a6a0b8e8018834891116123bb39808906f` |
| [src/server/tenantAuth.ts](../src/server/tenantAuth.ts) | `9f99c84f79637b2400cbf2c9a99773517289e027fc7b656f7eb635a755d58a1a` |
| [src/server/tenantContext.ts](../src/server/tenantContext.ts) | `c11d34d49c324bccffb7c5929fbffc745306083aea2369764190568df4dedbcb` |
| [src/server/tenantLegacyAdminAuth.ts](../src/server/tenantLegacyAdminAuth.ts) | `c5d656064f174f2feffc489994206ecaa696f8be426be5be1dc9b979d467d647` |
| [src/server/trustedTenantRequestContext.ts](../src/server/trustedTenantRequestContext.ts) | `aa314786922526f688e67133a761d413f1d4374e859d23f6976288f4837f904c` |
