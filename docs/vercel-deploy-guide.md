# Vercel 배포 가이드

> 배포 준비 문서입니다. 실제 provider 설정·DB 권한 설치·배포·이전 완료를 증명하지 않습니다. 기존 학급은 Sheets 권위를 유지하며 자동 cutover하지 않습니다. 최종 이전 서비스가 완성되지 않은 상태에서 환경변수만 바꿔 운영을 전환하지 마세요.

## 1. 먼저 배포 역할을 나누세요

| 역할 | 구성 / 운영 경계 |
|---|---|
| 기존 학급 Sheets | 사용자 → Vercel Next.js 앱/API → Google Sheets. `CLASS_STORE_STORAGE=sheets`를 명시하고 기존 Sheet ID·인증값을 보존합니다. |
| 생성기 | `NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT=generator`를 정확히 설정한 별도 배포. identity 로그인과 별도 생성 동의 후 새 Sheets 운영 배포의 설정을 안내합니다. 생성 grant의 일회 사용 기록에는 PostgreSQL도 필요합니다. |
| 중앙 PostgreSQL 준비 | `CLASS_STORE_STORAGE=postgresql`, 검토된 DB 연결/ACL, URL 기반 tenant 및 membership을 사용합니다. 기존 Sheets 배포의 storage를 바꾸는 작업과 다릅니다. |

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

## 4. 중앙 PostgreSQL 준비 — 아직 live 이전 아님

### 검토 후에만 provision

[Task24 요구사항](plans/2026-08-28-postgres-multitenant-migration.md)에 따라 **schema/transaction 독립 검토 통과 후에만 Vercel을 통한 Neon provisioning**을 별도 승인으로 수행합니다. 이 문서는 현재 Vercel 화면 위치, provider 버전, provision 성공을 주장하지 않습니다.

- Preview와 Production은 분리된 DB 환경·runtime 계정·비밀을 사용합니다. Preview에 Production credential이나 실제 학급 데이터를 그대로 복제하지 마세요.
- runtime `DATABASE_URL`은 pooled 연결 운영 계약으로 준비하되 **nonowner, NOSUPERUSER, NOBYPASSRLS** 최소 권한 계정을 사용합니다. 필요한 schema USAGE/DML/lock 권한만 검토하고 DDL, trigger-disable, TRUNCATE 권한을 주지 마세요.
- schema migration용 직접 연결은 별도 실행 환경의 `DIRECT_DATABASE_URL`로 분리합니다. **migration credential을 runtime DATABASE_URL에 넣지 마세요.** runtime에 불필요한 migration 비밀도 배포하지 마세요.
- 실제 parser는 URL trim 후 `postgres:`/`postgresql:`과 hostname을 검사합니다. `DIRECT_DATABASE_URL`이 비면 `DATABASE_URL`로 fallback하고, runtime config는 설정된 direct 값도 검증합니다. Drizzle config도 direct→runtime 순입니다. 따라서 변수 이름만으로 pooled/direct endpoint나 실제 DB 역할/ACL이 설치·격리되지는 않습니다. [DB config](../src/server/db/config.ts) · [Drizzle config](../drizzle.config.ts)
- migration 0012 실행자/SECURITY DEFINER 함수 owner는 **superuser 또는 BYPASSRLS**가 필요합니다. FORCE RLS 아래 일반 table owner만으로 부족합니다. 이것은 migration owner 요구이지 runtime 우회 권한을 주라는 뜻이 아닙니다.
- runtime discovery는 `platform_find_tenant_by_slug(text)`, `platform_find_membership_by_tenant_and_google_subject(uuid,text)`, `platform_list_memberships_by_google_subject(text)`의 정확한 signature에 필요한 EXECUTE를 별도 부여하는 계약입니다. migration은 PUBLIC 실행권한을 revoke하며 주석의 GRANT 지시는 실제 설치 증거가 아닙니다. [0012](../src/server/db/migrations/0012_platform_tenant_discovery.sql)

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
2. 작업 writer와 suite가 정지한 별도 검증 시점에 기존 로컬 script를 사용합니다. [package.json](../package.json)에 있는 명령은 `npm test`(vitest run), `npm run lint`(eslint), `npm run build`(next build), `npm run dev`(개발), `npm run start`(빌드 후 실행)입니다. 이 문서에는 임의 migration script를 만들지 않습니다.
3. 위 명령만으로 충분하지 않습니다. [Task23](plans/2026-08-28-postgres-multitenant-migration.md)의 타입/정적 검사, secret/diff 검사, 독립 리뷰, 격리된 실제 PostgreSQL migration·constraint·transaction rehearsal, 복사한 승인 Sheet import와 필수 delta 0 정합성, route inventory·RLS cross-tenant 음성 검사, Redis claim rehearsal를 별도 완료해야 합니다.
4. 검토된 저장소를 Vercel Next.js 프로젝트로 연결하고 역할별 환경변수를 해당 범위에 등록한 후 승인된 Preview를 배포합니다. 기존 Sheets ID·설정·credential을 보존하고 변경된 환경값은 재배포에 반영합니다. 현재 provider UI 단계/버전은 이 문서의 검증 대상이 아닙니다.
5. 실제 브라우저에서 페이지뿐 아니라 연결된 API 응답·화면 데이터·권한 거절을 확인합니다. HTML 200만으로 성공 판정하지 마세요. 아래 확인은 승인된 격리 환경에서 하며 생성/금전/이전 동작은 데이터 쓰기 승인이 필요합니다.

| 역할 | 실제 확인할 경로와 결과 |
|---|---|
| Sheets | `/`, `/bank`, `/admin/login`, `/admin`, `/admin/student-qrs`, `/admin/transactions`: Sheet 데이터, 암호 로그인/로그아웃·비인증 거절, 설정 load 오류를 빈 값으로 저장하지 않는지 확인 |
| 생성기 | `/`, `/admin/generator`: identity와 별도 생성 동의, 만료/소비 grant 거절. `/bank`, `/admin/login`, 일반 운영 API 차단 확인. 실제 Sheet 생성은 별도 승인 후 수행 |
| 중앙 | `/classes`, `/c/{slug}`, `/c/{slug}/bank`, `/c/{slug}/admin/login`, `/c/{slug}/admin` 및 해당 `/api/c/{slug}/…`: URL tenant 바인딩, 다른 tenant 거절, kiosk/bank/admin, QR·Padlet 상태 확인. 미활성 tenant를 억지로 ACTIVE 처리하지 않음 |

확인 실패 시 승격하지 않습니다. Production 승격 후에도 실제 대상 도메인이 의도한 프로젝트/revision을 가리키는지와 동일 경로/API를 다시 확인한 증거를 남깁니다. 비밀 원문 대신 비식별 결과만 기록하세요.

## 6. live canary·중단·보존 경계

- DB-capable 코드 배포 후에도 기존 tenant는 Sheets에 남습니다. 첫 실제 이전 대상은 **현재 관리 중인 학급 한 곳**이며, 명시적인 live canary/freeze/activation 승인이 먼저 필요합니다. 성공 관찰과 재정합성 확인 **이후에만** 다른 기존 배포를 초대합니다.
- 현재 preparatory READY는 bound snapshot 검증이지 live freeze 증명이 아닙니다. final-generation의 `UNTRUSTED_PREPARATION`/`DIFF_VALIDATED`도 실행 가능한 최종 SQL delta가 아닙니다.
- 구현된 FREEZING start는 READY→FREEZING 및 `NOT_PROVEN`, `automaticRetry:false`, `automaticEnable:false`를 반환합니다. 진단 재취득은 `NONAUTHORITY`, `NOT_PROVEN`, `finalImportEligible:false`입니다. maintained writer exclusion, final-purpose fresh consent/acquisition, FINAL_IMPORT·최종 정합성·전역 claim publication·activation은 지원 완료로 취급하지 않습니다. enum/상태 이름이나 빈 환경변수를 채우는 것만으로 이 경계를 넘을 수 없습니다.
- `MIGRATION_READ_ONLY`는 빈 값/정확히 `false`만 해제이고 그 외 nonempty 값(공백이나 `0` 포함)은 freeze 요청입니다. 기존 Sheets 쓰기 거절 스위치일 뿐 외부 writer 배제 증명이 아닙니다. `MIGRATION_CENTRAL_TARGET_URL`은 최대 2048자의 canonical HTTPS `/c/slug` 안내 주소만 허용하며 query/fragment/userinfo/끝 slash는 안 됩니다. 안내 URL은 auth/cutover 권한이 아닙니다.
- abort는 `ABORTED`와 `externalCleanup:NOT_PERFORMED`만 기록합니다. 로컬 transaction rollback이나 UNKNOWN 결과는 이미 수행된 외부 disable을 되돌리지 않으며 자동 resend/enable 허가도 아닙니다.
- **앱 버전 rollback은 PostgreSQL 권위를 유지합니다.** Sheets 복귀는 DB write freeze → post-cutover delta 전체 export/apply → 전체 정합성 → authority 전환 → legacy writer 재개라는 별도 승인 migration입니다. storage 값을 sheets로 바꾸거나 오래된 URL로 돌아가는 shortcut은 금지합니다. 이 순서는 요구사항이며 현재 실행 가능한 복귀 서비스 완료 주장이 아닙니다.
- 원본 Sheets는 **자동 삭제하지 않습니다**. 승인된 freeze 이후 기본은 무기한 read-only 보존이며 관리자가 export/retention 정책을 선택합니다. 옛 배포 URL 은퇴·구 QR 종료·원본 삭제는 각각 별도 결정입니다. 민감한 raw staging/backup export 보존 기간은 첫 실제 import 전에 결정하고 aggregate 정합성/audit는 durable하게 유지합니다.

[현재 구현/한계](database-architecture.md) · [start](../src/server/migration/startFreezing.ts) · [진단 재취득](../src/server/migration/freezingReacquisitionIntake.ts) · [abort](../src/server/migration/cutover.ts)

## 7. 기존 Sheets BANK 과제 완료 장애 확인

- 같은 `operationId`로 재확인하고 `TaskCompletions`의 `PENDING → BALANCE_APPLIED → SUCCESS` checkpoint와 결정적 보상 transaction을 대조합니다. SUCCESS 전에는 완료로 단정하지 마세요.
- `task_operation_stage` JSON은 event 식별자 외에 `requestId`, `operationId`, `stage`, `durationMs`, `resultCode`, `retryCount`만 내보냅니다. QR·학생 ID/이름·잔액·Sheet ID·provider 원문·인증정보를 추가로 기록하지 마세요.
- `queue_wait`의 `SLOW`는 process-local 대기 1초 이상, `safe_projection`은 완료 후 학생 safe projection 생성 시간입니다. 여러 Vercel instance의 unrelated balance race까지 exactly-once라는 뜻이 아닙니다.
- `COMPLETION_STATUS_UNKNOWN`은 같은 operation으로 재확인하는 상태이며 `COMPLETION_RECONCILIATION_REQUIRED`는 자동 판단을 멈추고 수동 확인하는 상태입니다. trace 없이 OAuth/quota/gateway 하나를 간헐 장애의 단일 원인으로 단정하지 마세요.

[telemetry](../src/server/operationTelemetry.ts) · [Sheets 구현](../src/server/sheetsRepository.ts) · [완료 route](../src/app/api/tasks/[taskId]/complete/route.ts)
