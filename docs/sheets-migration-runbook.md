# Sheets → PostgreSQL 이전 운영 런북

> **2026-10-07 갱신:** TEST와 선정 운영 학급의 동결 전체 이전은 10월 5일 완료했다. 현행 구현은 `prepareFrozenFullCutover.ts` / `frozenFullCutover.ts`다. 새 학급의 Excel 가져오기는 현재 상태만 옮기며 과거 이력은 제외한다. 현행 상태·남은 일은 [README](../README.md)를 따른다. 아래 과거 Task19–24·bridge 기반 점검표와 당시 미구현 판단은 이력이며 완료된 학급의 재이전 지시가 아니다. 추가 학급 이전 시에는 새 대상과 현재 유효한 사용 중단 약속이 필요하다.

상태: **Task22 문서 초안 / 운영 전 검토 필요**. 2026-09-25 KST 작업 트리의 구현을 기준으로 작성했다. 병렬 작업 중인 코드나 테스트의 존재를 배포·운영 검증 완료로 간주하지 않는다. 이 문서는 동결, 데이터 적재, 권한 변경, 배포 또는 활성화 승인이 아니다.

## 1. 최우선 원칙과 적용 범위

- **개발 중 기존 Sheets/Redis 서비스를 계속 유지한다.** 문서 작성·로컬 검사 때문에 기존 writer를 중단하거나 `MIGRATION_READ_ONLY`를 설정하지 않는다. PostgreSQL 후보 데이터와 진단 결과를 학생 서비스의 권위 있는 데이터로 노출하지 않는다.
- **최종 전환 때는 모든 기존 writer와 사람의 직접 편집을 먼저 차단하고, 차단이 유지됨을 검증한 뒤 최종 수집한다.** 최종 대조 → PostgreSQL 활성화 → 기존 writer 차단 순서는 경쟁 조건을 만들므로 금지한다.
- PostgreSQL 트랜잭션은 외부 Sheets/Redis writer를 원자적으로 차단하지 못한다. 단일 제어 플래그, 재동의, 서명된 로컬 관찰, 상태 문자열, DB receipt 또는 `MATCH`만으로 외부 차단을 증명할 수 없다.
- 차단 범위·지속성·최종 수집·무손실 대조·복구 경로 중 하나라도 확인되지 않으면 **STOP**. 아직 활성화 전임이 확인된 경우 PostgreSQL shadow/비활성 상태에 머문다. 이미 활성화했거나 commit/authority가 불명확하면 아래 S2 경계를 적용하며 비활성이라고 추정해 되돌리지 않는다. 두 저장소를 동시에 쓰기 권위로 열지 않는다.
- 기준: [원 계획 Task17–24](plans/2026-08-28-postgres-multitenant-migration.md), [STOP / ABORT / rollback 안전 지침](cutover-rollback-runbook.md), [보관·내보내기 정책](data-retention-export.md). 감독 기록은 호스트 전용 `/home/haeon/workhub-tasks/live/class-store-supervision/ROADMAP.md`이며, 과거 통과 기록을 이번 작업 트리의 새 검증으로 재사용하지 않는다.

이하 `구현됨`은 소스에 존재한다는 뜻이고, `운영 전 선행 조건`은 실제 승인·환경·검증이 추가로 필요하다는 뜻이다. `미구현`에는 실행 명령을 제공하지 않는다.

## 2. 현재 구현과 실행 경계

| 항목 | 현재 확인한 기능 | 운영자가 오인하면 안 되는 범위 |
| --- | --- | --- |
| 기존 서비스 read-only 호환 모드 | [legacyDeploymentMode.ts](../src/server/legacyDeploymentMode.ts)가 기존 Sheets mutation을 503 / `MIGRATION_READ_ONLY`로 거부한다. [writer 목록](../src/server/testing/legacyWriteFreezeRoutes.json)과 [경로 검사](../src/server/legacyWriteFreezeRoutes.test.ts)가 있다. | 현재 실행 중인 모든 구배포에 적용되었다는 증거가 아니다. 직접 Sheet 편집·별도 스크립트·직접 Redis 접근을 차단하지 않는다. 테넌트 DB 경로의 동결 장치도 아니다. |
| 정규화 import | [importer.ts](../src/server/migration/importer.ts)의 `importLegacyNormalizationManifest`는 원본 manifest와 source/checkpoint에 결합된 배치 import 및 동일 입력 재시도를 구현한다. | 내부 함수이며 운영 CLI가 아니다. 결과는 `IMPORTING`; final delta·자동 활성화가 아니다. 변경된 manifest를 같은 checkpoint에 덮어쓰지 않는다. |
| preflight 대조와 READY | [reconcile.ts](../src/server/migration/reconcile.ts)가 실제 저장 데이터와 정규화 입력을 검사하고, `prepareLegacyImportReady`가 결합된 대조 결과를 감사 기록에 저장·읽기 검증한다. | [report.ts](../src/server/migration/report.ts)는 `PREFLIGHT`, `SHEETS_AND_REDIS`, `cutoverAllowed: false`를 반환한다. READY는 준비 상태이며 live freeze 증명이 아니다. |
| 역사적 preflight 보고서 조회 | [GET/HEAD 경로](../src/app/api/migrations/status/[slug]/preflight/route.ts)인 `GET/HEAD /api/migrations/status/<slug>/preflight`와 [report reader](../src/app/api/migrations/status/readPreflightReport.ts)는 명시적 `jobId`·`reportId`, Google 인증·현재 OWNER/ADMIN, canonical tenant/job/event 결합을 확인하여 저장된 감사 보고서의 제한된 projection을 조회한다. HEAD는 동일 권한·상태 검사를 거치되 본문이 없다. | GET 200도 [projection](../src/app/api/migrations/status/preflightReportProjection.ts)의 `scope: HISTORICAL_ONLY`, `verification: INTEGRITY_ONLY`다. `originalBinding: NOT_VERIFIED`, `currentFreshness: NOT_VERIFIED`, `currentPreflight: NOT_EVALUATED`, `operationalAuthority: UNKNOWN`, `cutoverAllowed: false`는 저장된 `MATCHED_PREFLIGHT`에도 유지된다. digest 일치는 원 출처 인증이 아니다. 원본 수집·현재 preflight 재실행, 최종 보고서 exporter·CSV/XLSX·지속 백업·post-cutover delta 또는 활성화 승인 기능이 아니다. |
| FREEZING 시작 | [시작 ceremony](architecture/migration-freezing-start.md), [관리자 컴포넌트](../src/components/MigrationFreezingPage.tsx), [startFreezing.ts](../src/server/migration/startFreezing.ts)에 인증·확인·새 동의와 등록된 로컬 writer disable 흐름이 있다. | 사전 등록·배포·운영 승인이 별도 필요하다. 로컬 disable 성공은 모든 배포·Redis·직접 편집의 지속 차단이 아니다. `freeze_verified_at`나 최종 활성화를 대신하지 않는다. |
| FREEZING 진단 재수집 | [중앙 intake](architecture/migration-freezing-reacquisition-intake.md)가 수집 승인·후보 보관·archival 상태 조회를 구현한다. | 후보는 `NONAUTHORITY`, `NOT_PROVEN`, `finalImportEligible: false`. 나중에 차단이 증명되어도 이 후보를 `FINAL_FROZEN`으로 승격할 수 없다. 별도 최종 목적의 새 동의·수집이 필요하다. |
| 로컬 최종 세대 실험 | [finalGeneration.ts](../src/server/migration/finalGeneration.ts), [단일 UPDATED](../src/server/migration/localUpdatedProductStage.ts), [다중 ADDED](../src/server/migration/localMultiAddedProductStage.ts)가 준비/격리된 후보 적재 경계를 갖는다. | `UNTRUSTED_PREPARATION` / `LOCAL_CANDIDATE` / `NOT_PROVEN`은 실제 final import가 아니다. 일부 상품의 검증을 전체 잔액·원장·claims 대조로 확대하지 않는다. |
| ABORT | [cutover.ts](../src/server/migration/cutover.ts)의 내부 `createLegacyCutoverAbortService`가 결합된 상태를 ABORTED로 바꾸고 감사/readback을 수행한다. | 이 파일은 forward cutover를 구현하지 않는다. 반환값 `externalCleanup: NOT_PERFORMED`; 외부 writer·grant·배포·import 정리는 수행하지 않는다. 운영 ABORT CLI/API가 있다고 가정하지 않는다. |
| 내보내기 | [reconciliationSummary.ts](../src/server/exports/reconciliationSummary.ts)에 allowlist 기반 요약이 있다. | 복원 가능한 export, 최종 불변 보고서 다운로드 또는 rollback delta export가 아니다. 자세한 미충족 조건은 [보관 문서](data-retention-export.md)에 있다. |

후속 소스 확인 기준으로 `/c/<slug>/admin/migrations/status` [페이지](../src/app/c/[slug]/admin/migrations/status/page.tsx)와 `GET /api/migrations/status/<slug>` [상태 API](../src/app/api/migrations/status/[slug]/route.ts)는 [공유 상태 reader](../src/app/api/migrations/status/readStatus.ts)를 사용한다. 유효한 canonical 경로의 정상 GET에서 미인증은 401 / `AUTHENTICATION_REQUIRED`, 인증된 비회원·membership 불일치·권한 미달은 403 / `ACCESS_DENIED`다. 정상적인 상태 조회는 Google 인증, canonical tenant 해석, 현재 OWNER/ADMIN membership 검사를 통과해야 한다. selector 유효성 검사와 접근 검사를 포함한 API 응답은 다음과 같다.

- `jobId`가 없고 접근 검사를 통과하면 기존 503 / BLOCKED, `TRUSTED_STATUS_READER_UNAVAILABLE`, `migrationStatus: UNKNOWN`, `authority: UNKNOWN`을 유지한다.
- 유효한 명시적 `jobId`가 있으면 [저장 job reader](../src/app/api/migrations/status/readJobStatus.ts)가 해당 tenant의 job을 읽는다. 조회 성공은 200 / `availability: AVAILABLE` 및 저장된 `migrationStatus`지만, 저장된 `ACTIVE`를 포함한 모든 상태에서 `authority: UNKNOWN`, `OPERATIONAL_AUTHORITY_UNVERIFIED`다. 같은 조회 statement에서 canonical tenant·현재 membership을 다시 검사한다.
- 없는 job은 404 / `JOB_NOT_FOUND`, 저장 job 조회 불가는 503 / `JOB_STATUS_UNAVAILABLE`, 잘못된 selector는 400 / `INVALID_STATUS_REQUEST`다. 접근 확인 중 일반 예외 등의 503 / `ACCESS_CHECK_UNAVAILABLE`는 no-selector BLOCKED 및 저장 job 조회 불가와 구분한다.

저장 job 상태 조회는 연결되었지만 실제 운영 권위 확인, live freeze 판정, 활성화·재개 기능이 제공된 것은 아니다. 이는 기존 FREEZING UI의 attempt별 archival 조회와도 다르다. 여기서는 위 상태 조회와 역사적 보고서 조회의 소스만 읽었으며 DB/API·브라우저 실행이나 배포는 검증하지 않았다. 병합 후 실제 인증·라우팅·읽기 전용 동작을 확인해야 하며, 이 화면이나 조회가 추가되어도 cutover 권한은 생기지 않는다.

## 3. 지금 수행 가능한 읽기 전용 문서 검사

저장소 루트에서 다음 명령은 DB·Sheets·Redis 접속, 설치, 스테이징, 배포를 하지 않는다. `npm run`은 인자 없이 사용하여 실제 등록 script 목록만 읽는다.

```sh
cd /home/haeon/workspace/projects/class-store
npm run
git --no-optional-locks status --short
git --no-optional-locks diff --check
git --no-optional-locks diff --cached --check
git --no-optional-locks diff --no-index --check /dev/null docs/sheets-migration-runbook.md
git --no-optional-locks diff --no-index --check /dev/null docs/data-retention-export.md
```

마지막 두 검사는 새 문서가 untracked여도 공백 오류를 검사하기 위한 것이다. 이 환경의 `--no-index` 검사는 `/dev/null`과 새 파일이 달라 공백 오류 없이도 종료 코드 1을 반환하므로, 각각 독립 실행하고 공백 오류 출력과 종료 코드를 함께 확인한다. 이를 `&&`로 연결해 뒤 검사를 생략하지 않는다. 일반 `git diff --check`의 종료 코드와도 구분한다. 공유 작업 트리의 전체 diff 오류가 다른 파일에서 발생하면 파일·위치를 담당자에게 알리고 임의 수정하지 않는다. LF/CRLF 변환 경고는 whitespace 오류가 아니다.

[package.json](../package.json)에는 `test`, `build`, `lint` 등이 있지만 migration/cutover/export 전용 npm script는 없다. 존재하지 않는 `npm run migrate`, `npm run cutover`, export CLI 또는 임의 SQL 상태 변경을 실행 절차로 만들지 않는다.

원 계획 Task23의 `npm test`, `npx tsc --noEmit --pretty false`, `npx eslint .`, `npm run build`는 별도 검증 담당자가 승인된 격리 작업 환경에서 수행할 항목이다. 해당 npm script와 저장소의 설치된 `vitest`/`tsc`/`eslint`/`next` 실행 파일이 먼저 존재해야 한다. 의존성이 없으면 STOP하고 설치 승인·절차를 별도로 확인하며 `npx`의 자동 다운로드로 대체하지 않는다. 캐시·빌드 산출물 및 로컬 테스트 DB를 만들 수 있으므로 **이 문서 작업의 읽기 전용 검사에는 포함하지 않았다**. 테스트 성공도 운영 freeze·실데이터 복원 증거를 대신하지 않는다.

### 새 status GET 경로 목록·exhaustive 시험 확인 (A-02)

- [x] 감사 시 `GET /api/migrations/status/[slug]`가 두 inventory에서 누락되었으나, 후속 작업에서 [legacy inventory](../src/server/testing/legacyWriteFreezeRoutes.json)와 [tenant inventory](../src/server/repositories/routeInventory.ts)에 `GET /migrations/status/[slug]`를 등록했다. 감독자가 변경 후 [exhaustive 시험](../src/server/legacyWriteFreezeRoutes.test.ts) 및 인접 inventory·권한·freeze·[status route 테스트](../src/app/api/migrations/status/[slug]/route.test.ts)를 독립 재실행하여 7개 파일 238/238 통과, TypeScript 전체 검사·변경 파일 ESLint·`git diff --check` 통과를 확인했다(2026-09-25 KST, 당시 작업 트리). **당시** inventory의 실제 export 대조는 67개, 기존 writer는 28개였다. 이 결과는 **코드 경로 목록·격리 시험**의 검증이지 모든 외부 writer의 운영 차단, 실서비스 인증/브라우저, 실제 PostgreSQL 이전 또는 cutover의 증거가 아니다. 이후 경로가 변경되면 재검증해야 한다.

후속 소스/JSON 정적 확인에서는 역사적 preflight GET/HEAD 두 항목이 추가되어 현재 inventory는 69개(고유 method/route 쌍 69개), 기존 writer 분류(`effect`가 `-write`로 끝나는 항목)는 28개다. [exhaustive 시험 소스](../src/server/legacyWriteFreezeRoutes.test.ts)의 기대값도 69/28이지만, 이번 확인은 inventory 정적 검사이며 해당 시험을 재실행한 결과가 아니다. 이전 238/238을 현재 작업 트리의 새 시험 결과로 재사용하지 않는다. 코드 경로 목록은 모든 외부 writer의 전수 목록이 아니다.

## 4. 운영 전 준비 체크리스트 — 기존 서비스는 계속 유지

다음은 이후 운영 승인을 받기 위한 확인 항목이지, 지금 시스템을 변경하라는 명령이 아니다.

- [ ] 책임 운영자·독립 확인자·중단 연락처·승인된 점검 시간·복구 책임자를 지정한다. 승인에는 정확한 tenant, 원본 Sheet, Redis claim source, migration job과 허용 행위를 명시한다.
- [ ] 인증된 Google 사용자와 현재 OWNER/ADMIN membership, canonical slug → tenant 매핑을 서버에서 재확인한다. 요청 본문의 tenantId나 호환 관리자 비밀번호만으로 이전을 승인하지 않는다.
- [ ] 원본 Sheet 식별자·소유권·source_id, job 상태와 `state_version`, 의미 fingerprint와 acquisition digest, 원본 PREFLIGHT snapshot, Redis bridge의 배포/등록 세대를 묶어 기록한다. 각 digest 종류는 [fingerprint binding](migration-fingerprint-bindings.md)에 따라 구분한다.
- [ ] 전체 writer 목록을 작성한다: 모든 구배포 URL/인스턴스/버전, 재배포·자동 확장 경로, 학생·키오스크·은행·관리자 mutation, 직접 Redis 클라이언트/자격증명/예약 작업, Sheet 사람 편집자·공유 권한·서비스 계정·Apps Script/외부 자동화, 진행 중 요청·재시도 큐. 코드의 route inventory만으로 이 목록을 닫지 않는다.
- [ ] [보관 문서](data-retention-export.md)에 따라 민감 staging/완전한 acquisition/백업의 보관 기간·접근 권한·삭제 예외를 **최초 실제 import 전** 결정한다. 암호화된 복원 자료와 실제로 복원 가능한 키 관리 및 독립 복구 리허설을 마련한다.
- [ ] runtime DB role이 비소유자·NOSUPERUSER·NOBYPASSRLS이며 DDL/trigger-disable/TRUNCATE 권한을 갖지 않는지 검증한다. migration role을 runtime에 쓰지 않는다. DB 테넌트 분리뿐 아니라 export 파일과 감사 조회의 접근 경계도 검증한다.
- [ ] preflight 읽기와 import를 구분한다. preflight 수집/비교는 원본을 변경하지 않아야 한다. import·READY 기록은 DB 쓰기이므로 별도 승인 및 정확한 대상 환경이 필요하다. 현재 연결 정보나 실제 데이터를 이 문서에 붙이지 않는다.
- [ ] 복사된 승인 원본의 import 및 대조, 실제 격리 PostgreSQL 제약·트랜잭션·실패 복구·교차 테넌트 음성 검사, 브라우저 경로, 전체 Task23 검사를 검증한다. 로컬 합성 데이터 통과를 실원본 통과로 표기하지 않는다.

### 4.1 최초 실제 import 전 보관·복구 게이트

운영 데이터를 담은 복사본도 실제 데이터다. 최초 실제 import 승인 전에 [보관 결정과 승인 기록](data-retention-export.md#2-데이터-분류와-보관-결정)을 확정한다. preflight라는 이름으로 원문을 파일·staging·불변 audit에 영속 저장한다면 **그 저장 전**에도 같은 보관 승인이 필요하다. 다음을 확인하지 못하면 새 실제 데이터 수집·보관·import를 진행하지 않고 기존 서비스를 유지한다.

- 민감 raw/staging뿐 아니라 완전한 acquisition을 담은 immutable audit, 생성 export/백업, 전달·복제 사본까지 종류별 목적·기간의 시작/끝·접근자·저장소·삭제/예외 보존 책임자를 승인 기록에 포함한다. 집계 감사의 지속 보존과 원문 최소화를 구분한다.
- 현재 append-only 제약과 승인된 삭제 기한이 양립하는지 검토한다. 필요한 예외 삭제 절차가 없거나 키 파기가 필수 증거/복원성을 함께 잃게 한다면, 단순히 기간을 적은 것으로 통과시키지 않는다. 일반 tenant 삭제·TTL로 정리된다고 약속하지 않는다.
- 최초 import용 원본/증거의 보호·복구 경로, 접근이 제한된 저장 백업과 별도 키 복구 수단, 비활성 격리 대상에서의 복호화·복원·readback 증거를 마련한다. 실제 데이터 시험 자체도 보관/처리 승인을 먼저 받아야 한다. 합성 리허설과 승인된 실원본/복사본 리허설을 구분한다.
- 이후 최종 활성화 직전에는 최종 세대/시점에 맞춘 백업·복원 및 post-cutover delta 복구 경로를 다시 검증한다. 초기 import 승인이 이 마지막 복구 게이트까지 면제하지 않는다. 복구 기준(RPO/RTO, 허용 손실·중단 범위)은 승인자가 정하며 이 문서는 달성을 주장하지 않는다.

### 4.2 운영자용 STOP 증거표

아래 표는 **실제 운영 전 작성해야 할 기록 양식**이지 확인 완료 표가 아니다. 각 행에 `tenant/job/source/세대·버전`, 증거 위치와 digest, 수집자/독립 확인자, 관찰 시각(시간대 포함), 유효 시작·만료 또는 재검토 기한과 무효화 조건, 결과, 미해결 담당자, 재승인 참조를 남긴다. 시간 제한 증거에 유효기간이 없거나 대상/버전이 바뀌면 유효로 추정하지 않는다. 각 단계 직전에 원본 증거와 현재 상태를 다시 확인한다. 문서 수정·시험 통과·과거 ROADMAP 기록은 운영 승인이나 현재 상태의 대용물이 아니다.

공통 실패 규칙: **미확인(증거 없음·조회 실패·범위 누락), 기한만료(시간 경과·세대/권한 변경으로 무효), 불일치(대상·digest·데이터·readback 차이)는 모두 STOP**이다. N/A를 쓰려면 해당 단계에 적용되지 않는 이유와 승인자를 기록하며 필수 게이트를 면제하지 않는다.

안전 상태는 다음과 같이 구분한다. 이는 앞으로 승인된 사고 대응의 경계이며, 이번 문서 검증에서 동결/권한/서비스를 조작하라는 지시가 아니다.

- **S0 — 아직 동결/활성화하지 않음:** 현 Sheets/Redis 서비스를 유지하고 새 import·동결·활성화만 보류한다. PostgreSQL 후보는 비활성/비권위다.
- **S1 — 이미 동결했으며 활성화 전임이 확인됨:** 기존 writer 차단을 유지하고 다음 이전 단계를 중단한다. ABORT/오류/증거 만료만으로 차단을 풀지 않는다. 레거시 운영 재개는 비활성 상태와 source 무결성을 독립 확인하고 별도 명시적 승인을 받은 경우에만 검토한다.
- **S2 — 활성화됨 또는 활성화 시도 이후 commit/authority 불명:** 구 writer를 계속 차단한다. PostgreSQL 권위가 확인되면 이를 유지하며 forward repair를 검토한다. 권위가 불명확하면 어느 쪽도 새로 열지 않고, 승인된 사고 대응 경로로 안전을 확인할 수 없는 쓰기를 보류한다. S0로 되돌려 추정하지 않는다.

아직 동결·활성화를 시도하지 않았다는 운영 이력이 확인되는 개발 단계에서는 Task20 상태 화면의 `UNKNOWN`만으로 S2나 서비스 중단으로 전환하지 않는다. S0에서 다음 이전 단계를 보류한다. 반대로 활성화 시도 여부/결과 자체가 불명확하면 S0로 추정하지 않고 S2의 별도 사고 확인이 필요하다.

승인 역할은 운영 전에 실명/연락처로 지정하되 제한된 승인 기록에만 둔다. **테넌트 승인권자**는 서버에서 확인된 현재 OWNER/ADMIN 중 해당 행위를 위임받은 사람이고, **기관 데이터 승인권자**는 개인정보 보관/제공/삭제를 결정할 권한이 있는 사람이다. **운영 변경 승인권자**는 배포·writer 차단·활성화/복구 변경 권한을 별도로 가진 사람이다. 키 보관자·복구 담당자와 독립 확인자는 검증 책임자이며 그 지위만으로 변경 승인권을 갖지 않는다. 한실장 감독 또는 일반 개발 위임을 이 승인으로 대신하지 않는다. 역할 미지정도 STOP이다.

| 게이트 / 확인할 증거 | 미확인·기한만료·불일치 시 금지 사항과 안전 상태 | 재검증·재개 승인권자 |
| --- | --- | --- |
| 대상·권한·행위 승인: canonical tenant, 정확한 Sheet/Redis source/job, 현재 membership, 상태/version/fingerprint와 행위별 승인 | stale intent·다른 source 승인 재사용 금지. 현재 단계에 따라 S0/S1/S2; 활성화 시도 여부/결과 불명은 S2 | 독립 확인자 재조회 후 테넌트 승인권자; 운영 변경이면 운영 변경 승인권자도 필요 |
| 최초 실제 import 전 보관: 종류별 기간·저장/접근·immutable payload·삭제 예외·복구/키 정책 | 새 실제 데이터 영속 수집/import 금지. 미동결이면 S0, 이후 발견되면 S1/S2에서 추가 처리 보류; 이미 저장한 증거를 임의 삭제하지 않음 | 기관 데이터 승인권자와 테넌트 승인권자; 구현 불일치는 수정·검증 후 재승인 |
| 저장 백업·키·복원: 저장본의 정확한 artifact/시점/schema binding, 키 복구, 독립 복원과 업무/RLS/권한 readback | 키 없음·인증 실패·부분 복원·검증 만료는 복구 불가/미검증. import 또는 활성화의 해당 복구 게이트에서 STOP; S0/S1/S2, 마지막 정상본 보존 | 복구 담당자·키 보관자·독립 확인자 검증 후 기관 데이터/운영 변경 승인권자 및 테넌트 승인권자 |
| preflight/import: 원본 manifest/source/checkpoint, 지원 이력·격리 충돌, 정확한 비활성 대상, 실행 경로 | 임의 SQL 상태 승격·수정 입력 덮어쓰기·unsupported history 누락 금지. S0 또는 이미 동결했다면 S1 | 테넌트 승인권자, DB 작업은 운영 변경 승인권자; 이력 지원 변경은 별도 설계 승인 |
| 전체 writer exclusion: 구배포/세대·Redis·직접 Sheet 편집/자동화 전수 목록, drain·정상 권한 probe·유효기간·지속 관찰 | freeze 값 하나/401 응답만으로 통과 금지. 미동결이면 S0; 동결 후 만료/새 writer 발견은 S1/S2, 새 최종 수집·활성화 금지 및 사고 대응 요청 | 각 writer/권한 관리자의 재검증, 독립 확인자, 운영 변경 승인권자 |
| 최종 수집: 최종 목적 fresh consent·Sheet snapshot·Redis manifest와 유지된 exclusion/시각/세대 결합 | 진단 후보 승격·과거 수집 재명명 금지. S1, commit 여부가 불명확하면 S2; 증거 회복 후 새 승인/수집 필요 | 테넌트 승인권자와 source 소유자, 운영 변경 승인권자 |
| full delta/독립 최종 대조: 모든 필수 범위·무손실·quarantine 해소·최종 불변 보고서/readback | 일부 상품 MATCH/합계 일치로 누락을 면제하지 않음. S1/S2; 차이 원본과 실패 증거 보존 | 독립 데이터 검증자 확인 후 테넌트/운영 변경 승인권자 |
| 원자적 활성화/commit: 정확한 최종 binding·승인·tenant/job/claim 권위·감사 readback | 응답 유실/불일치는 UNKNOWN(S2). 무작정 재시도·구 URL/구 writer 재개 금지 | 신뢰 가능한 상태 reader와 독립 확인자의 판정 후 운영 변경 승인권자 및 테넌트 승인권자 |
| export·rollback·삭제/종료: 실제 저장본·delta 경계·복원/대조·잔류 사본·grant 정리와 각 행위 승인 | READY/EXPIRED 행만으로 생성/삭제 완료 금지. 미동결이면 S0, 이후에는 S1/S2 유지; 새 공유·파기·저장소 rollback 보류 | 제공/삭제는 기관 데이터 및 테넌트 승인권자; 저장소/배포 변경은 운영 변경 승인권자도 필요 |

현재는 위 표에 넣을 live 증거·승인·완성된 final cutover/export 경로를 이 검증에서 확보하지 않았다. **모든 운영 게이트는 미충족/미검증 상태**다. 미구현을 승인만으로 우회할 수 없으며 구현·독립 시험·유효한 운영 증거와 재승인이 모두 필요하다.

## 5. 최종 동결 게이트 — 구현·운영 증거가 없으면 STOP

**운영 전 선행 조건:** 유지되는 외부 writer 배제 수단과 검증 가능한 운영 경로가 있어야 한다. 현재 로컬 제어/진단 코드만으로 이 게이트를 충족했다고 선언할 수 없다.

1. 승인 화면/기록에서 정확한 source Sheet와 target tenant/job, 현재 버전·fingerprint, 동결 범위·영향을 다시 확인한다. READY 이후 원본이 바뀌었으면 기존 승인·수집 결과를 그대로 재사용하지 않는다.
2. 모든 구 writer와 직접 편집을 차단하고 진행 중 쓰기·재시도를 drain한다. 호환 업데이트를 설치할 수 없는 배포도 예외가 아니다. 기존 배포 중지 또는 쓰기 권한 회수와 직접 편집 제한이 별도로 승인·구현·검증되어야 한다. 이 문서는 그런 서비스/권한 변경 명령을 제공하지 않는다.
3. 모든 알려진 mutation과 직접 편집 경로의 실패를 검증한다. 비인가 요청의 401/403만으로 정상 권한 writer 차단을 증명하지 않는다. 소스에 손상이 날 수 있는 무작정 쓰기 시도 대신 사전 검증된 안전한 probe·권한 검사 절차가 필요하다. 읽기 유지 여부도 확인한다.
4. writer별 식별자·세대·배제 수단·독립 관찰 시각·시작/만료·drain 결과·probe 결과·증거 위치를 기록한다. 직접 편집이 막혔는지 확인하지 못했거나 어떤 writer가 목록에서 빠졌으면 STOP한다.
5. 차단 상태를 최종 수집 전부터 delta 적용·최종 대조·활성화와 **불확실한 commit 복구가 끝날 때까지 계속 유지**한다. 세대/권한/인스턴스 변화나 차단 증거 만료는 재검증 사유다. DB commit 이후에도 구 writer를 열지 않는다.

`MIGRATION_READ_ONLY=true`는 호환 코드가 있는 기존 Sheets 경로의 거부 설정일 뿐이다. 이 값의 설치/배포도 별도 승인 대상이며, 개발 단계에서 미리 켜지 않는다. `MIGRATION_CENTRAL_TARGET_URL`은 안내용 canonical HTTPS `/c/<slug>` URL이지 데이터 권위나 안전한 rollback 증거가 아니다.

## 6. 최종 수집·무손실 대조·원자적 활성화

**미구현/운영 전 선행 조건:** 완결된 운영 final-delta 적용·전체 대조·권위 전환 경로는 아직 제공하지 않는다. 아래는 앞으로 충족해야 할 게이트이며, 내부 함수를 직접 호출하거나 SQL로 상태를 올리는 절차가 아니다.

### 6.1 최종 수집과 적용

- 검증·유지되는 차단 아래에서 최종 목적에 결합된 새로운 Google 동의와 Sheet snapshot, 새로운 Redis bridge manifest를 취득한다. 과거 PREFLIGHT 또는 진단 reacquisition 후보를 최종 snapshot으로 이름만 바꾸지 않는다.
- Sheet와 Redis의 실제 수집 출처·시각·등록 세대·권한·digest를 함께 확인한다. 둘 중 하나라도 변화·누락·불완전하면 STOP. 인증된 수집과 digest 일치는 서로 다른 검증 항목이다.
- 모든 full claim, orphan/race-lost 후보, V1 digest tombstone, operation binding을 포함한다. Redis를 생략하거나 “없는 것 같다”는 주장으로 빈 결과를 만들지 않는다. 완전한 빈 수집과 수집 실패를 구분한다.
- 원본 source/checkpoint/PREFLIGHT와 이전 실패 증거를 그대로 보존하고, 별도의 phase-bound 최종 세대에 delta와 provenance를 저장해야 한다. 재시도 중 변경·삭제·취소·append-only 이력의 처리 의미를 검증해야 한다. 현재 상품 일부 LOCAL_CANDIDATE를 operational target의 전체 갱신으로 간주하지 않는다.

### 6.2 최종 무손실 대조의 필수 범위

최종 수집의 기대값과 실제 저장된 PostgreSQL 값을 **독립적으로 재계산**한다. 다음 전체 범위에 필요한 행·관계·금액·정규화 내용 차이가 없어야 한다. 단순 행 수 또는 총합이 같은 것만으로 통과시키지 않는다.

| 범위 | 반드시 대조할 내용 |
| --- | --- |
| 학생·잔액 | 학생 식별 및 매핑, 학생별 최종 잔액, 전체 잔액 합계, 허용 학생/계정 연결 |
| 상품·재고 | 정의·가격·상태·식별자, 상품별 재고와 재고 이동, 삭제/tombstone 의미, 누락·추가·변경 |
| 거래·조정·취소 | 전체 원장/상세 항목, 금액·balance delta, before/after 잔액, 시간·순서·고유 ID, 취소 원거래/역거래 및 중복 지급 방지 |
| 과제·보상 | 과제, 배정, 완료, 반복 규칙/비교 시각 및 시간대에 따른 운영 projection, 승격/상품 연결·설정 |
| Redis/Padlet | full claims, operation binding, orphaned claim, race-lost 보존 대상, digest tombstone, 전역 중복/다른 테넌트 충돌 |
| 이전 증거 | source/snapshot/세대 binding, 원본 행 해시·provenance, 모든 checkpoint, quarantine/경고/진단, unsupported history |

- 최종 보고서는 tenant/job/final generation, Sheet·Redis fingerprint, 비교 시각·버전·writer 배제 증거와 결합되어야 한다. immutable 저장 후 정확한 원문/요약을 읽어 검증해야 한다.
- 미해결 quarantine, 중복·잘못된 금융 행, source conflict, 의미 불명확한 history, 진단 누락·잘림, 미검사 범위는 통과가 아니다. 기록을 삭제하거나 합계를 맞춰 무손실로 만들지 않는다.
- `MATCHED_PREFLIGHT`, `DIFF_VALIDATED`, `complete=true`, `MATCH` 또는 상품 delta=0은 위 최종 전체 대조를 대체하지 않는다.

### 6.3 활성화

- 최종 source/tenant와 제로 차이 보고서에 결합된 **명시적 관리자 활성화 승인**을 받아야 한다. preflight/import 허용이나 FREEZING 시작 승인은 활성화 승인이 아니다.
- 외부 차단을 유지한 상태에서 하나의 잠긴 DB 트랜잭션으로 현재 tenant/job/버전·membership·최종 binding·승인·유효성·대조 증거를 재검증하고, 검증된 최종 세대와 claim 권위만 발행하며 tenant/job을 ACTIVE로 바꿔야 한다. 부분 활성화는 허용하지 않는다.
- commit 응답만으로 완료하지 않는다. 정확한 대상과 authority 상태·최종 fingerprint·감사 기록을 다시 읽어 확정한다. 응답 유실/상충 상태는 UNKNOWN으로 취급하고 writer를 열지 않는다.
- 그 이후에도 구 Sheet/Redis writer 배제를 유지하고, grant revoke/clear 및 구배포 폐기는 별도 승인된 수단으로 수행·확인한다. 전환 후 관리자 자격 회전, 소스 read-only 보관, canary 관찰은 원 계획에 따른 별도 검증 대상이다.

## 7. 중단·ABORT·재실행·rollback

[기존 안전 지침](cutover-rollback-runbook.md)이 우선이다.

| 상황 | 처리 원칙 |
| --- | --- |
| 활성화 전 차단/소스/대조/승인 실패 | STOP하고 원본·후보·실패 시각·차이·현재 authority를 보존한다. 개발 때부터 서비스가 정상 운영 중인 경우를 제외하고, 이미 동결한 writer는 실패만으로 자동 재활성화하지 않는다. |
| 내부 ABORT | tenant lifecycle DRAFT/IMPORTING/READY와 정확한 job 상태/버전/fingerprint, 현재 OWNER/ADMIN을 확인하는 내부 트랜잭션만 존재한다. ACTIVE/FAILED/ABORTED는 대상이 아니다. ABORTED 감사와 readback이 성공해도 외부 cleanup은 `NOT_PERFORMED`다. |
| import 중단 후 재시도 | importer가 허용하는 IMPORTING 경계와 동일 source/manifest/checkpoint를 재검증하는 경우에만 동일 입력의 idempotent 재시도를 검토한다. 충돌·빠진 원본을 임의로 채우거나 다른 원본으로 이어서 실행하지 않는다. 공개 resume CLI가 있다는 뜻은 아니다. |
| 상태/소스가 달라짐 | stale intent를 재사용하지 않는다. 새 job/세대·재승인·재수집 설계와 기존 전역 source 소유권 충돌을 먼저 검토한다. 임의 job 생성, 기존 증거 삭제, 상태 되감기 SQL은 금지한다. FAILED/ABORTED는 현재 DDL상 terminal이며 자동 재개되지 않는다. |
| FREEZING/진단 요청 응답 유실 | 기존 UI의 해당 attempt archival 조회로 저장 사실을 확인한다. UNKNOWN·후보 없음은 “아무 동작도 없었다”는 증거가 아니다. 자동 재전송, 승인 재사용, writer auto-enable을 하지 않는다. |
| 활성화 commit이 불확실 | 차단 유지 → 저장된 job/tenant/claim 권위·감사 readback → 독립 확인. commit 유실을 일반 네트워크 재시도로 처리하지 않는다. |
| 활성화 후 장애 | 기본은 PostgreSQL을 권위로 유지하는 forward repair 또는 호환 애플리케이션 버전 rollback이다. 구 URL로 사용자를 보내거나 구 writer를 여는 것은 금지한다. |
| 저장소를 Sheets로 되돌림 | 별도로 승인·구현된 DB 전체 writer 동결 → 전환 이후 모든 DB delta export/apply → 잔액·재고·원장·과제·claims/tombstones 재대조 → 원자적 authority 변경 → 그 뒤에만 legacy writer 재개가 필요하다. **현재 실행 가능한 저장소 rollback 절차는 없다.** |

## 8. 테넌트 분리와 종료 판정

[tenant transaction](../src/server/db/transaction.ts)은 트랜잭션별 `app.tenant_id`를 설정한다. [migration DDL](../src/server/db/migrations/0003_operations_migrations.sql)은 tenant-scoped RLS/FORCE RLS와 복합 참조를 제공하지만, 임의 tenantId를 신뢰하거나 privileged role로 실행해도 된다는 뜻은 아니다.

- canonical directory, 현재 Google 로그인·membership, 원본 소유권, source/job/snapshot/세대의 동일 tenant binding을 각각 확인한다.
- 다른 tenant/job/source/generation의 ID 교체, 비회원·권한 회수·세션 만료, 전역 source 재사용, Padlet digest 전역 충돌이 거부되는지 검증한다. 플랫폼 전역 digest registry를 일반 tenant export에 포함하지 않는다.
- 전환 후 새 쓰기가 PostgreSQL만 사용하는지 검증하고 기존 writer가 계속 거부되는지 관찰한다. source drift나 이상 잔액이 있으면 종료 판정을 보류한다.
- 완료 보고에는 승인자/검증자, 제한된 증거 위치, 정확한 대상·버전·최종 fingerprint, 모든 게이트 결과, 미해결 항목, 외부 차단 유지 및 grant 정리 결과를 남긴다. 개인정보·토큰·원본 데이터는 일반 보고서에 첨부하지 않는다.

**현재 결론:** 문서·로컬 준비 구현이 존재해도 운영 cutover 완료가 아니다. 유지되는 전체 writer 배제, 최종 목적의 수집, full delta 적용·독립 무손실 대조·원자적 활성화, 운영 백업/복원, 명시적 운영 승인·실배포 검증이 충족될 때까지 활성화하지 않는다.
