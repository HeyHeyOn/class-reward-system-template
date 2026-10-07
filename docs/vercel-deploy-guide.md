# Vercel 배포 가이드

> 2026-10-07 기준 중앙 운영 앱은 `crs-postgresql`이며 `/classes`에서 시작한다. 선정 학급의 실제 이전은 완료됐고 운영 DB도 새 앱 운영 계정 소유의 Neon으로 옮겼다. 아래 절차는 새 환경 설정·후속 배포를 위한 가이드이며 완료된 이전을 다시 실행하는 지시가 아니다. 현재 수용 범위는 [README](../README.md)를 따른다.

## 1. 먼저 배포 역할을 나누세요

| 역할 | 구성 / 운영 경계 |
|---|---|
| 기존 학급 Sheets | 사용자 → Vercel Next.js 앱/API → Google Sheets. `CLASS_STORE_STORAGE=sheets`를 명시하고 기존 Sheet ID·인증값을 보존합니다. |
| 생성기 | `NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT=generator`를 정확히 설정한 별도 배포. identity 로그인과 별도 생성 동의 후 새 Sheets 운영 배포의 설정을 안내합니다. 생성 grant의 일회 사용 기록에는 PostgreSQL도 필요합니다. |
| 중앙 PostgreSQL 서비스 | `CLASS_STORE_STORAGE=postgresql`, 검토된 DB 연결/ACL, URL 기반 tenant 및 membership을 사용합니다. 기존 Sheets 배포의 storage를 바꾸는 작업과 다릅니다. |

[환경변수 예시](../.env.example)에서 필요한 역할만 비공개로 설정하고 [DB 아키텍처](database-architecture.md)를 함께 읽으세요. 빈 예시는 준비 완료가 아닙니다. `NEXT_PUBLIC_*`에는 비밀을 넣지 마세요. 비밀·학생 QR·실제 학급 식별자·연결 문자열은 문서, 채팅, 공개 로그, 커밋에 남기지 마세요.

storage selector는 **정확히** `sheets` 또는 `postgresql`만 허용합니다(공백 포함 값도 거절). 예시의 `sheets`는 안전한 명시 설정이지 코드의 자동 기본값이 아닙니다. 선택한 adapter의 오류를 다른 저장소로 fallback하지 않습니다. 중앙 trusted request context가 있으면 그 tenant의 PostgreSQL authority가 우선하며, context가 없을 때만 호환 환경 설정을 읽습니다. [소비자](../src/server/repositories/configuredRepository.ts)

## 2. 기존 Sheets 운영 배포

### 서버 Sheets 인증

공통으로 `CLASS_STORE_STORAGE=sheets`, 기존 `GOOGLE_SHEET_ID`, 강한 `AUTH_SECRET`, `ADMIN_PASSWORD`를 설정합니다. 서버를 별도 PC에서 계속 켜둘 필요는 없습니다.

- **지속 refresh token 방식:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`을 함께 설정합니다. 토큰 발급 계정은 대상 Sheet 편집 권한과 필요한 API 범위가 있어야 합니다. 학생 키오스크와 `/admin/login` 암호 로그인은 개별 Google 로그인 없이 서버 인증으로 Sheets를 사용합니다.
- **서비스 계정 방식:** refresh token을 설정하지 않고 `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`를 설정합니다. 해당 이메일에 Sheet **편집자** 권한을 공유합니다. private key의 실제 줄바꿈 또는 문자 그대로의 `\n`은 소비자가 처리합니다.
- 실제 우선순위는 **trim한 refresh token이 있으면 OAuth client를 요구하고 그 경로를 선택**, 없으면 서비스 계정입니다. client ID/secret만 있다고 서비스 계정보다 Sheets 인증이 우선하는 것이 아닙니다. refresh token이 있는데 client가 빠졌거나 토큰이 실패하면 서비스 계정으로 자동 복구하지 않습니다. [Sheets 인증](../src/server/googleSheets.ts) · [OAuth](../src/server/googleOAuth.ts)

identity 로그인 callback은 `{배포 origin}/api/google/callback`입니다. 승인된 redirect URI는 사용할 배포 origin과 정확히 맞추세요. **현재 일반 Google 로그인은 online `openid/email/profile`이며 Sheets 권한이나 durable refresh token 발급 흐름이 아닙니다.** 기존 토큰의 발급 client를 유지하고, 재발급이 필요하면 별도 승인된 목적별 절차를 사용하세요. 로그인 쿠키를 Sheets credential로 사용하지 않습니다.

### ADMIN_PASSWORD를 생략하면 어떻게 되나요?

“비밀번호가 없으면 언제나 보호가 꺼진다”는 설명은 정확하지 않습니다.

- legacy 서버 auth는 trim한 `ADMIN_PASSWORD` **또는** `AUTH_SECRET`이 있으면 enabled입니다. 환경 비밀번호 일치가 먼저 허용되고, 이후 Settings의 `adminPasswordHash` 또는 `recoveryCodeHash`도 검사합니다.
- `AUTH_SECRET`만 있고 환경 비밀번호가 없어도 보호는 enabled입니다. 이 경우 유효한 저장 암호/복구 코드가 필요하며, 없으면 암호 검증은 거절됩니다. Settings 읽기 실패도 거절합니다. reader 자체가 없을 때는 enabled 여부에 따라 판정합니다.
- 둘 다 없으면 서버 session 검사가 열린 개발용 경로가 있으므로 운영에 사용하지 마세요. 페이지 proxy는 또 별도로 OAuth client pair/암호/쿠키를 판단합니다. 화면이 열리는 것만으로 API 인증을 검증했다고 보지 마세요.
- 운영에서는 무작위 `AUTH_SECRET`과 추측하기 어려운 `ADMIN_PASSWORD`를 모두 설정하세요. 저장 암호를 바꿔도 기존 환경 암호는 계속 유효할 수 있으므로 함께 검토합니다. 중앙 tenant 암호·membership은 이 전역 legacy 암호와 별개입니다.

[서버 auth](../src/server/adminAuth.ts) · [로그인 route](../src/app/api/admin/login/route.ts) · [proxy](../src/proxy.ts)

`AUTH_SECRET`은 공백 없는 무작위 32~1024자로 통일하는 것을 권장합니다. 일반 identity 쿠키는 `AUTH_SECRET → GOOGLE_CLIENT_SECRET → ADMIN_PASSWORD` fallback이 있고 동일 강도 검사를 강제하지 않습니다. 생성기는 trim 후 32~1024자, FREEZING 세션은 원문 trim 일치와 32~1024자를 요구합니다. 약한 fallback에 의존하지 마세요.

### 설정·업데이트 보존

Sheets 모드의 영구 설정은 로컬 `data/settings.json`이 아니라 Sheet의 `Settings`를 사용합니다. `currencyUnit` 등 기존 값을 유지하세요. `GOOGLE_SHEET_ID`는 trim하며 누락 시 빈/unset 설정이 될 수 있습니다. 화면 기본값 표시를 실제 연결 성공으로 오인하지 마세요. Sheet를 의도적으로 바꿀 때는 환경값 변경 후 재배포하며, 일반 코드 업데이트에서는 기존 ID를 바꾸지 않습니다.

서명 QR을 사용하는 경로에는 `STUDENT_QR_ACTIVE_KEY_ID`와 `STUDENT_QR_SIGNING_KEYS`가 필요합니다. ID는 `[A-Za-z0-9_-]` 1~24자, JSON은 최대 2048자·키 1~8개·활성 ID 포함, 값은 각각 32바이트 키의 padding 없는 canonical base64url 43자입니다. 키 교체와 구 QR 지원 종료는 별도 검토하세요. `PADLET_API_KEY` 미설정/공백은 해당 기능의 구성 오류이며 전체 앱의 자동 대체 모드가 아닙니다. 수동 QR 입력 허용은 환경변수가 아니라 Settings 값(기본 false)입니다.

## 3. 생성기 별도 배포

1. `NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT`를 공백 없이 정확히 `generator`로 설정합니다. 서버 helper는 trim하지만 HomePage는 exact 비교합니다. `NEXT_PUBLIC_CLASS_STORE_TEMPLATE_REPO`는 검토된 템플릿 저장소 안내용이며 미설정이면 일반 새 프로젝트 안내로 연결됩니다.
2. identity용 `GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET`, 생성 동의용 `GENERATOR_GOOGLE_CLIENT_ID/GENERATOR_GOOGLE_CLIENT_SECRET`, 강한 `AUTH_SECRET`을 구분합니다. 두 client의 callback 경로는 `/api/google/callback`입니다. 변수 이름만 다르게 두었다고 실제 client가 격리되는 것은 아닙니다.
3. 생성 동의는 identity + `drive.file`, offline/consent입니다. identity와 같은 계정의 목적별 grant가 필요합니다. identity만으로 생성 권한을 얻지 않으며 소유 증명이나 이전 승인도 대체하지 않습니다.
4. **현재 생성기는 DB 없이 완성되지 않습니다.** `claimGeneratorGrant`가 `DATABASE_URL` pool의 `generator_grant_claims`에 일회 사용을 기록합니다. 검토된 schema와 이 query에 필요한 최소 권한을 따로 준비하세요. 이 전역 grant 저장소를 tenant RLS만으로 보호된다고 가정하거나 migration 계정을 runtime에 넣지 마세요. DB 준비가 없다면 생성 성공을 주장하지 마세요.
5. 생성 응답은 동의한 사용자의 새 운영 배포에 생성기 client를 `GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET`으로, grant를 `GOOGLE_REFRESH_TOKEN`으로 전달합니다. 출력에는 `CLASS_STORE_STORAGE=sheets`, Sheet ID, AUTH_SECRET도 포함됩니다. 이 전달은 해당 사용자 배포용이며 공개 공유용이 아닙니다. 현재 초기 `ADMIN_PASSWORD`는 로그인 email이므로 강한 별도 운영 암호로 바꾸세요. 생성기 모드 변수를 새 학급 앱에 복사하지 마세요.

[생성 route](../src/app/api/generator/create/route.ts) · [grant DB 소비자](../src/server/repositories/configuredGeneratorGrantClaims.ts)

## 4. 중앙 PostgreSQL 환경·권한 설정

### TEST와 운영 환경을 구분한 provisioning

현재 개발 기준은 2026-09-29 A–F 파일럿 계획이며, 이전 Task 1–24의 배포 승인 대기는 현행 절차가 아닙니다. 사용자가 위임한 `crs-test` 범위에서 TEST DB와 Preview를 구성하고 검증합니다. 실제 운영 학급의 전환 대상·담당자·중단 창은 F 단계에서 확정합니다. 개별 실행 결과는 `class-store-supervision/codex-development-20261005.json`에 기록합니다.

- Preview와 Production은 분리된 DB 환경·runtime 계정·비밀을 사용합니다. Preview에 Production credential이나 실제 학급 데이터를 그대로 복제하지 마세요.
- runtime `DATABASE_URL`은 pooled 연결 운영 계약으로 준비하되 **nonowner, NOSUPERUSER, NOBYPASSRLS** 최소 권한 계정을 사용합니다. 필요한 schema USAGE/DML/lock 권한만 검토하고 DDL, trigger-disable, TRUNCATE 권한을 주지 마세요.
- 일반 중앙 앱의 ACL은 [runtimeGrants.sql](../src/server/db/provisioning/runtimeGrants.sql)에 명시합니다. 역할은 SQL로 별도 생성하며 role membership을 주지 않습니다. 이 ACL은 generator·이관·bootstrap 실행 권한을 포함하지 않습니다. [관리형 DB 검사](../src/server/db/provisioning/managedRuntime.postgres.test.ts)는 명시적으로 지정한 TEST runtime 연결만 사용하고, 검증용 업무 자료는 외부 트랜잭션에서 모두 롤백합니다. 이 검사는 실제 Google 로그인 검증을 대신하지 않습니다.
- schema migration용 직접 연결은 별도 실행 환경의 `DIRECT_DATABASE_URL`로 분리합니다. **migration credential을 runtime DATABASE_URL에 넣지 마세요.** runtime에 불필요한 migration 비밀도 배포하지 마세요.
- 실제 parser는 URL trim 후 `postgres:`/`postgresql:`과 hostname을 검사합니다. `DIRECT_DATABASE_URL`이 비면 `DATABASE_URL`로 fallback하고, runtime config는 설정된 direct 값도 검증합니다. Drizzle config도 direct→runtime 순입니다. 따라서 변수 이름만으로 pooled/direct endpoint나 실제 DB 역할/ACL이 설치·격리되지는 않습니다. [DB config](../src/server/db/config.ts) · [Drizzle config](../drizzle.config.ts)
- migration 0012 실행자/SECURITY DEFINER 함수 owner는 **superuser 또는 BYPASSRLS**가 필요합니다. FORCE RLS 아래 일반 table owner만으로 부족합니다. 이것은 migration owner 요구이지 runtime 우회 권한을 주라는 뜻이 아닙니다.
- runtime discovery는 `platform_find_tenant_by_slug(text)`, `platform_find_membership_by_tenant_and_google_subject(uuid,text)`, `platform_list_memberships_by_google_subject(text)`의 정확한 signature에 필요한 EXECUTE를 별도 부여하는 계약입니다. migration은 PUBLIC 실행권한을 revoke하며 주석의 GRANT 지시는 실제 설치 증거가 아닙니다. [0012](../src/server/db/migrations/0012_platform_tenant_discovery.sql)

- 새 학급 생성은 [0030 migration](../src/server/db/migrations/0030_class_creation.sql)의 `platform_create_draft_class(uuid,text,text,text)`에 대한 runtime `EXECUTE`도 필요합니다. 함수는 migration/BYPASSRLS 소유권과 고정 `search_path`를 유지하고, `class_creation_operations` 직접 접근 권한은 runtime에 주지 않습니다. 학급·OWNER·요청 식별자를 한 트랜잭션으로 저장하며 `DRAFT`만 생성합니다. 같은 요청 재전송은 동일 학급을 반환하고, 다른 계정이나 바뀐 내용으로 요청을 재사용하면 거부합니다.
- 새 빈 학급의 사용 시작에는 [0031 migration](../src/server/db/migrations/0031_new_class_start.sql)의 `platform_get_new_class_setup(text,text)`, `platform_start_new_class(uuid,text,text)` 정확한 signature에 대한 runtime EXECUTE가 필요합니다. 새 학급 생성 기록과 현재 OWNER를 확인하고, 이전 job이나 업무 자료가 있는 학급은 거부합니다. 기본 설정·변경 불가능한 시작 기록·ACTIVE가 한 거래로 확정되며 동일 요청 재시도는 다시 활성화하거나 설정을 덮어쓰지 않습니다. `new_class_start_operations` 직접 접근 권한은 주지 않습니다.
- 중앙 학급의 설정 화면은 Sheets ID 없이 화폐 단위·제목·테마·글꼴·수동 QR 입력 여부를 PostgreSQL에 저장합니다. `tenant_settings`/`operations`/`audit_events`에 필요한 runtime 권한을 설치하세요. 저장 버전 충돌 시 다시 불러오기를 요구하며, 응답이 유실된 재시도는 동일 요청을 재사용합니다. 공개 설정 응답에는 이관 원본 ID와 API 비밀을 포함하지 않습니다.
- 과거 schema-4 이력 이관 코드는 [0032](../src/server/db/migrations/0032_legacy_transaction_origins.sql)·[0033](../src/server/db/migrations/0033_legacy_task_origins.sql)·[0034](../src/server/db/migrations/0034_legacy_task_event_guards.sql)를 모두 적용한 DB가 필요합니다. runtime에는 `legacy_task_origins` SELECT를 부여해야 과거 보상 요청 번호의 재사용을 거부할 수 있습니다. 원본 보관 테이블 INSERT는 신뢰된 이관 실행자에게만 부여하며 UPDATE/DELETE/TRUNCATE는 허용하지 않습니다. 과거 관리자·BANK 기록은 원본 증거로 보관하며 현대 `operations` 인증 기록을 생성하지 않습니다. 이관 함수는 비공개 학급만 대상으로 하며 원본 획득·쓰기 중단·claim 게시·활성화는 별도의 전체 이관 절차가 담당합니다.
- 전체 Sheets 스냅샷 이관에는 [0035](../src/server/db/migrations/0035_legacy_full_snapshot_archives.sql)의 비공개 원본 보관 테이블도 필요합니다. 실행자는 학생·잔액·재고·과제·프로모션·이력을 빈 학급에 한 트랜잭션으로 넣고 양방향 대조합니다. 동일 원본 재시도는 대조만 수행하며, 현재 데이터가 바뀌었거나 대상이 비어 있지 않으면 덮어쓰지 않습니다. 원본 아카이브에는 개인정보와 과거 설정이 포함되므로 이관 실행자 외의 SELECT 권한과 공개 API를 부여하지 않습니다. 이 단계만으로 Redis claim 또는 실서비스 전환이 검증되지는 않습니다.

- 과거 거래 취소에는 tenant RLS 아래 `legacy_transaction_origins`, `legacy_task_origins`, `migration_sources` SELECT가 필요합니다. 원본 행과 이관된 거래·과제 연결을 대조하는 내부 읽기이며, 전체 원본 아카이브나 Redis 보관 테이블의 runtime 접근은 필요하지 않습니다. 과거 원장을 덮어쓰거나 현대 인증 이력을 소급 생성하지 않습니다. 2026-10-05 확정 정책에 따라 과거·신규 거래 모두 취소로 잔액이 음수가 될 수 있고, 이미 초기화된 보상 취소는 새 과제 완료를 되돌리지 않습니다.

- Redis 과거 claim 보존에는 [0036](../src/server/db/migrations/0036_legacy_redis_archives.sql)을 적용합니다. 비공개 스냅샷의 v1/v2 소유권과 연결 정보를 보존하고, 최종 활성화 트랜잭션에서 사용된 게시물의 전역 중복 방지 기록을 게시합니다. 연결되지 않은 claim, 다른 소유자, job 버전·원본 지문 불일치는 거부합니다. 일반 runtime에는 게시물 선택에서 중복을 숨기기 위한 `padlet_claim_digest_tombstones` SELECT가 필요합니다. `legacy_redis_snapshot_archives`와 `legacy_claim_publications` SELECT/INSERT는 이관 실행자에게만 부여하세요. 내부 게시 함수만 호출하는 것은 전체 이관이 아니며, 호출자가 실제 쓰기 중단·진행 요청 종료·최종 원본 대조·현재 관리자 권한을 확인하고 활성화와 함께 커밋해야 합니다.

실제 적용 migration, 함수 owner, role flags·membership, ACL, FORCE RLS 음성 검사, 연결 재사용 시 tenant 누출, transaction session 기본 isolation, backup 복원을 검증한 증거가 있어야 합니다. 기본 runner는 `READ COMMITTED` 옵션 분기에 일반 BEGIN을 보내므로 DB session default를 확인해야 합니다. 상세 schema/transaction 계약은 [DB 아키텍처](database-architecture.md)를 따르며 여기서 재작성하지 않습니다.

### URL tenant와 호환 환경을 혼동하지 마세요

중앙 `/c/{slug}`, `/api/c/{slug}/…`는 canonical 경로와 서버 DB directory로 tenant를 결정합니다. 관리자 identity에는 그 tenant의 OWNER/ADMIN membership이 필요합니다. 제한된 기존 tenant session 호환은 별도 검사이며 전역 `ADMIN_PASSWORD`로 대체하지 않습니다. 모든 read가 관리자 전용이라는 뜻도 아닙니다.

`CLASS_STORE_CENTRAL_TENANT_ID/STATUS`는 request context 없는 명시적 PostgreSQL 호환 경로용입니다. 일반 중앙 배포에서는 비우고, 사용 시 유효 UUID와 정확히 `ACTIVE`가 필요합니다. 환경에 ACTIVE를 적는 것으로 DB tenant를 활성화하지 않습니다. `CLASS_STORE_DEFAULT_TENANT_SLUG`는 기존 `/`, `/bank`, `/admin` 계열 redirect용이지 권한이나 tenant 선택의 전역 cookie가 아닙니다.

### 이전 동의·companion은 별도 승인 영역

`MIGRATION_GOOGLE_CLIENT_ID/SECRET`은 identity/생성기/기존 refresh와 분리합니다. FREEZING 동의는 `spreadsheets.readonly + drive.file + openid/email`, online/consent, `include_granted_scopes=false`; callback은 `/api/migrations/google-sheets/callback`입니다. production은 `CLASS_STORE_STORAGE=postgresql`, 경로·끝 슬래시 없는 canonical HTTPS `MIGRATION_GOOGLE_OAUTH_ORIGIN`, 명시적 `MIGRATION_GOOGLE_SHEET_REGISTRATIONS`를 요구합니다. 등록 JSON은 최대 128000바이트, 1~256행, 정확히 tenantId/sourceId/spreadsheetId 필드이며 소문자 UUID, trim 동일 sourceId 1~1024자·spreadsheetId 1~512자, tenant+source 중복 금지입니다. 등록이나 Sheet ID 입력은 동의·실제 source 제어권 증명을 대신하지 않습니다.

중앙 start/재취득 등록과 기존 Sheets companion 등록은 서로 다른 설정입니다. 상세 필드는 [환경변수 예시](../.env.example) 및 [production 소비자](../src/server/migration/bridgeProducerProduction.ts)를 검토하고 승인 전 키/등록을 채우거나 writer 제어를 호출하지 마세요.

companion은 독립 `CLASS_STORE_BRIDGE_PRODUCER_DATABASE_URL`을 요구하고 중앙 DATABASE_URL로 fallback하지 않습니다. DB username은 등록 deploymentId와 일치해야 합니다. 별도 **NOSUPERUSER NOBYPASSRLS NOINHERIT** login에 필요한 schema USAGE와 replay 관계 SELECT/INSERT만 부여하며 membership/SET ROLE 권한을 주지 않습니다. tenant runtime과 credential을 공유하지 마세요. replay RLS는 tenant GUC가 아니라 `current_user` deployment를 검사하며 tombstone을 자동 삭제하지 않습니다. companion은 기존 durable refresh credential이 필수라서 일반 Sheets 서비스 계정 fallback과도 다릅니다. [0020 계약](../src/server/db/migrations/0020_bridge_producer_reservations.sql)

## 5. 검증 후 배포 순서

아래는 **실행 전 체크리스트**이며 이 문서 작성 중 통과한 결과가 아닙니다.

1. 승인된 소스 revision, 대상 프로젝트/역할, Preview·Production 범위, 기존 실제 서비스 도메인과 배포 연결을 확인합니다. 생성기·학급 템플릿·기존 복사본은 서로 다른 배포이므로 하나의 업데이트로 전부 바뀐다고 가정하지 마세요.
2. 작업 writer와 suite가 정지한 별도 검증 시점에 기존 로컬 script를 사용합니다. [package.json](../package.json)에 있는 명령은 `npx vitest run --config test-support/release-unit.config.mts`(애플리케이션 검사), `npm run lint`(eslint), `npm run build`(next build), `npm run dev`(개발), `npm run start`(빌드 후 실행)입니다. 이 문서에는 임의 migration script를 만들지 않습니다.
3. 위 명령만으로 충분하지 않습니다. [현행 A–F 기준](../README.md)의 타입/정적 검사, secret/diff 검사, 독립 리뷰, 격리된 실제 PostgreSQL migration·constraint·transaction rehearsal, 승인 원본의 동결 전체 import와 전량 정합성, route inventory·RLS cross-tenant 음성 검사, Redis claim rehearsal를 별도 완료해야 합니다.
4. 검토된 저장소를 Vercel Next.js 프로젝트로 연결하고 역할별 환경변수를 해당 범위에 등록한 후 승인된 Preview를 배포합니다. 기존 Sheets ID·설정·credential을 보존하고 변경된 환경값은 재배포에 반영합니다. 현재 provider UI 단계/버전은 이 문서의 검증 대상이 아닙니다.
5. 실제 브라우저에서 페이지뿐 아니라 연결된 API 응답·화면 데이터·권한 거절을 확인합니다. HTML 200만으로 성공 판정하지 마세요. 아래 확인은 승인된 격리 환경에서 하며 생성/금전/이전 동작은 데이터 쓰기 승인이 필요합니다.

| 역할 | 실제 확인할 경로와 결과 |
|---|---|
| Sheets | `/`, `/bank`, `/admin/login`, `/admin`, `/admin/student-qrs`, `/admin/transactions`: Sheet 데이터, 암호 로그인/로그아웃·비인증 거절, 설정 load 오류를 빈 값으로 저장하지 않는지 확인 |
| 생성기 | `/`, `/admin/generator`: identity와 별도 생성 동의, 만료/소비 grant 거절. `/bank`, `/admin/login`, 일반 운영 API 차단 확인. 실제 Sheet 생성은 별도 승인 후 수행 |
| 중앙 | `/classes`, `/c/{slug}`, `/c/{slug}/bank`, `/c/{slug}/admin/login`, `/c/{slug}/admin` 및 해당 `/api/c/{slug}/…`: URL tenant 바인딩, 다른 tenant 거절, kiosk/bank/admin, QR·Padlet 상태 확인. 미활성 tenant를 억지로 ACTIVE 처리하지 않음 |

확인 실패 시 승격하지 않습니다. Production 승격 후에도 실제 대상 도메인이 의도한 프로젝트/revision을 가리키는지와 동일 경로/API를 다시 확인한 증거를 남깁니다. 비밀 원문 대신 비식별 결과만 기록하세요.

## 6. 현재 운영·후속 이전·복구

- 중앙 운영 앱의 최초 진입은 <https://crs-postgresql.vercel.app/classes>다. 기존 Sheets 배포·생성기와 별도 프로젝트이며, 새 앱 수정으로 기존 프로젝트를 덮어쓰지 않는다.
- 최신 확인 운영 배포는 `dpl_Dc39E98LPdA4GQ5dzCYwRJ2UiVNU`(10월 7일, Singapore)다. 운영 DB도 새 계정으로 이전됐다. 연결값과 계정 식별 상세는 비공개 운영 기록에만 둔다.
- 현재 SQL migration은 `0038_class_dashboard.sql`까지 존재한다. 새 DB 준비 시 migration 파일과 [provisioning](../src/server/db/provisioning)을 함께 확인한다. SQL 파일이 존재한다는 이유만으로 실제 ACL 설치를 가정하지 않는다.
- 과제는 장부 모델, 은행은 학생별 세션 모델이다. AUTH_SECRET 및 STUDENT_QR 설정은 현재 운영값과 호환되어야 한다. QR 서명 키 교체 시 기존 QR의 검증 가능 여부를 별도로 확인한다.
- 추가 Sheets 학급을 이전할 때는 대상·원본 쓰기 경로·현재 중단 약속을 확인하고 동결 전체 이전을 수행한다. 완료된 TEST/운영 학급을 반복 이전하지 않는다. 과거 중단 약속을 새 유지보수 창으로 재사용하지 않는다.
- Excel 셀프 가져오기는 현재 데이터만 옮긴다. 거래·과제 이력 전체 보존이 필요하면 해당 기능과 혼동하지 않는다.
- **롤백 후보는 현재 DB와 과제 장부를 모두 지원해야 한다.** 이전 DB 주소가 저장된 Vercel 배포를 승격하거나 옛 DB 쓰기 권한을 다시 여는 것은 최신 기록을 분리시킬 수 있다. 우선 현재 DB를 유지한 수정 배포를 준비한다. 데이터 복귀가 꼭 필요하면 전환 이후 전체 변경분 대조를 포함하는 별도 이전으로 다룬다.
- 원본 Sheets와 옛 DB는 보관 대상이다. 관찰 후 보관·폐기를 결정하며 이 문서 정리는 삭제나 쓰기 재개를 수행하지 않는다.

[동결 이전 코드](../src/server/migration/frozenFullCutover.ts) · [아키텍처](database-architecture.md) · [복구 주의](cutover-rollback-runbook.md)

## 7. 기존 Sheets BANK 과제 완료 장애 확인

- 같은 `operationId`로 재확인하고 `TaskCompletions`의 `PENDING → BALANCE_APPLIED → SUCCESS` checkpoint와 결정적 보상 transaction을 대조합니다. SUCCESS 전에는 완료로 단정하지 마세요.
- `task_operation_stage` JSON은 event 식별자 외에 `requestId`, `operationId`, `stage`, `durationMs`, `resultCode`, `retryCount`만 내보냅니다. QR·학생 ID/이름·잔액·Sheet ID·provider 원문·인증정보를 추가로 기록하지 마세요.
- `queue_wait`의 `SLOW`는 process-local 대기 1초 이상, `safe_projection`은 완료 후 학생 safe projection 생성 시간입니다. 여러 Vercel instance의 unrelated balance race까지 exactly-once라는 뜻이 아닙니다.
- `COMPLETION_STATUS_UNKNOWN`은 같은 operation으로 재확인하는 상태이며 `COMPLETION_RECONCILIATION_REQUIRED`는 자동 판단을 멈추고 수동 확인하는 상태입니다. trace 없이 OAuth/quota/gateway 하나를 간헐 장애의 단일 원인으로 단정하지 마세요.

[telemetry](../src/server/operationTelemetry.ts) · [Sheets 구현](../src/server/sheetsRepository.ts) · [완료 route](../src/app/api/tasks/[taskId]/complete/route.ts)
