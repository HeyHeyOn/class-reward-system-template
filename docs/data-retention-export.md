# 데이터 보관·내보내기·삭제와 복구 경계

> **2026-10-07 상태 구분:** 선정 학급의 이전과 운영 DB 소유 계정 이전은 완료됐다. 원본 Sheets·옛 DB·비공개 증거의 보관과 삭제는 별도 작업이다. 아래 정책·과거 구현 한계는 완료된 이전을 미완료로 되돌리는 근거가 아니다. Git 정리에서도 개인 실행 설정·운영 원본·로컬 증거는 삭제하지 않고 버전 관리에서 제외한다. 현재 진행 상태는 [README](../README.md)를 따른다.

상태: **Task22 문서 초안 / 운영 전 검토 필요**. 2026-09-25 KST 작업 트리의 코드와 실제 감독 스크립트를 기준으로 작성했다. 이 문서는 개인정보 처리, 외부 공유, 삭제, 백업 실행 또는 저장소 전환 승인이 아니다. 학교·기관의 적용 규정에 따른 기간과 승인권자는 별도로 정해야 하며, 임의의 법정 보관 기간을 제시하지 않는다.

관련 문서: [Sheets 이전 런북](sheets-migration-runbook.md), [STOP / ABORT / rollback](cutover-rollback-runbook.md), [원 계획 Task21–24와 관리자 결정 사항](plans/2026-08-28-postgres-multitenant-migration.md), [snapshot append-only 계약](migration-snapshot-retention.md).

## 1. 현재 제공하는 것과 미구현 기능

| 구분 | 현재 확인한 구현 | 한계 / 운영 전 선행 조건 |
| --- | --- | --- |
| 대조 요약 | [reconciliationSummary.ts](../src/server/exports/reconciliationSummary.ts)의 allowlist 기반 category/count/status 출력, tenant/job 일치 검사, `activationAllowed: false` | 일반 업무 데이터 export나 복원 백업이 아니다. `complete`/`blocked`는 제한된 요약 상태이고, 누락 행·전체 무손실·최종 세대 provenance·활성화를 증명하지 않는다. |
| preflight 보고서 | [report.ts](../src/server/migration/report.ts)와 [reconcile.ts](../src/server/migration/reconcile.ts)가 진단을 제한하고, `prepareLegacyImportReady`가 `MIGRATION_RECONCILIATION_PREFLIGHT` 감사 이벤트를 저장/readback한다. | 결합된 snapshot 비교 기록이지 실시간 freeze 또는 최종 전환 보고서가 아니다. 요약 다운로드와 동일하지 않다. |
| 역사적 preflight 보고서 조회 | [GET/HEAD 경로](../src/app/api/migrations/status/[slug]/preflight/route.ts)인 `GET/HEAD /api/migrations/status/<slug>/preflight`와 [report reader](../src/app/api/migrations/status/readPreflightReport.ts)는 명시적 `jobId`·`reportId`, Google 인증·현재 OWNER/ADMIN, canonical tenant/job/event 결합을 확인하여 저장된 감사 보고서의 제한된 projection을 조회한다. HEAD는 동일 권한·상태 검사를 거치되 본문이 없다. | GET 200도 [projection](../src/app/api/migrations/status/preflightReportProjection.ts)의 `scope: HISTORICAL_ONLY`, `verification: INTEGRITY_ONLY`다. `originalBinding: NOT_VERIFIED`, `currentFreshness: NOT_VERIFIED`, `currentPreflight: NOT_EVALUATED`, `operationalAuthority: UNKNOWN`, `cutoverAllowed: false`는 저장된 `MATCHED_PREFLIGHT`에도 유지된다. digest 일치는 원 출처 인증이 아니다. 원본 수집·현재 preflight 재실행, 최종 보고서 exporter·CSV/XLSX·지속 백업·post-cutover delta 또는 활성화 승인 기능이 아니다. |
| export 저장 스키마 | [0003 DDL](../src/server/db/migrations/0003_operations_migrations.sql)에 `exports`, artifact digest/path, 상태·만료 필드 및 CSV/XLSX/SHEETS_COMPATIBLE/MIGRATION_REPORT/ROLLBACK_DELTA 종류가 있다. | 스키마는 구현 완료가 아니다. 이 종류에 대응하는 완성된 생성·다운로드·만료/삭제 worker 및 운영 API를 확인하지 못했다. 자동 생성·삭제된다고 안내하지 않는다. |
| 원본/후보 증거 | [importer](../src/server/migration/importer.ts), [최종 세대 준비](architecture/migration-final-generation-preparation.md), [0016 snapshot 불변성](../src/server/db/migrations/0016_migration_snapshots_immutable.sql) | redacted 데이터에도 학생·이력과 지원되는 자격 hash가 남을 수 있다. 일부 완전한 acquisition은 불변 audit 안에 있으므로 단순 staging 만료로 삭제되지 않는다. |
| 합성 PostgreSQL 백업/복구 리허설 | 호스트의 `/home/haeon/workhub-tasks/live/class-store-supervision/isolated-backup-restore.py` | 운영 백업 서비스가 아니다. 합성 fixture, 폐기형 독립 컨테이너, 메모리 전용 키/임시 파일만 검사한다. 아래의 범위와 실행 승인을 따른다. |
| 운영 데이터 내보내기/삭제 | 완결된 CSV/XLSX/Sheets-compatible exporter, post-cutover delta export/apply, 예외 삭제 절차는 **미구현/운영 전 선행 조건** | 존재하지 않는 메뉴·URL·npm script·SQL 삭제 명령을 제공하지 않는다. Task20 상태 화면 또는 보고 요약 추가는 이 기능들의 완료를 뜻하지 않는다. |

## 2. 데이터 분류와 보관 결정

**최초 실제 import 전에** 민감 원문·staging·완전한 acquisition·생성 백업의 보관 기간, 목적, 접근자, 저장 위치, 암호화와 키 복구, 파기 방식 및 감사 예외를 정한다. “나중에 지우겠다”만으로 immutable evidence에 실제 데이터를 저장하지 않는다.

원 계획의 기본값은 **원본 Sheets를 자동 삭제하지 않고, 최종 전환 후 관리자가 보관 정책을 정할 때까지 무기한 read-only 유지**이다. 이는 법적 의무를 대신하거나 모든 다른 데이터의 무기한 보관을 승인하는 뜻이 아니다. 개발 중에는 기존 서비스가 운영 중이므로 이 기본값을 이유로 원본을 미리 동결하지 않는다. 보관 정책 충돌·삭제 요구가 있으면 승인권자가 판단하고 필요한 절차가 구현될 때까지 새 민감 원문 적재를 보류한다.

| 자료 | 위험과 필요한 보관 범위 | 삭제/만료 경계 |
| --- | --- | --- |
| 원본 Sheets와 Redis 자료 | 학생·거래·과제·claims와 변환 provenance. 검증된 원자적 PostgreSQL 권위 전환 전에는 쓰기를 동결하더라도 기존 Sheets/Redis를 이전의 권위 있는 원본으로 보존한다. **동결 자체는 권위 전환이 아니다.** 전환·readback을 확인한 뒤에도 제한된 read-only 복구 자료로 유지한다. commit/권위가 불명확하면 어느 쪽도 새로 열지 않고 [런북 S2](sheets-migration-runbook.md#42-운영자용-stop-증거표)를 따른다. | 활성화 성공만으로 삭제하지 않는다. rollback window와 검증된 대체 복구 자료, 관리자 보관 결정이 필요하다. Redis 자료도 claims/tombstones 복구 검증 전 일괄 flush하지 않는다. |
| raw snapshot, `canonical_record`, 정규화/staging | 학생 식별·잔액·과제/거래 이력 및 원본 문자열 등이 남을 수 있다. 목적상 필요한 최소 범위, 제한된 접근 | 자동 TTL/파기 구현을 가정하지 않는다. 원본 행 hash만 남기는 변경도 provenance·재대조에 미치는 영향을 검토한다. |
| 준비/진단 후보 및 불변 audit envelope | 완전한 Sheet/Redis acquisition과 지원되는 credential hash가 audit에도 들어갈 수 있다. 이름이 `redacted`라고 익명 자료가 아니다. | 현재 append-only 경계에서는 일반 삭제 불가. 최초 보관 승인에 audit 내 민감 payload까지 포함한다. |
| 집계 대조·승인/중단·감사 증거 | tenant/job/세대·source binding·digest·버전·시각·집계·실패 코드·승인 관계를 장기 유지한다. 식별자·hash도 민감할 수 있다. | 원문 파기 후에도 무손실 판정/중단/삭제 이력을 설명할 최소 증거를 보존한다. 현 스키마를 임의 수정하여 마스킹하지 않는다. |
| full Padlet claims·operation binding·digest tombstones | 중복 보상/재사용 방지와 orphan/race-lost 이력 보존에 필요하다. 전역 digest registry는 tenant 간 비공개 충돌 제약이다. | 학생/tenant 삭제와 함께 무조건 지우지 않는다. 중복 방지 불변성과 다른 tenant에 미치는 영향을 포함한 별도 설계가 필요하다. |
| 업무용 CSV/XLSX/Sheets-compatible export | 배포 가능한 업무 항목만 allowlist. 승인된 수신자와 최소 행/열 범위로 제한한다. | 저장/수신 사본의 만료·재공유·파기 조건을 정한다. DB export 행을 EXPIRED로 바꾸는 것만으로 실제 파일이 삭제되지는 않는다. |
| 장애 복구용 전체 DB 백업 | 업무용 export와 구분한다. 복원에 필요한 schema/제약/증거 및 secret hash까지 포함할 수 있는 고위험 자료 | 암호화·분리 키 관리·최소 접근·복원 검증·보관 기간이 필요하다. 백업에서 과거 삭제 자료가 복원될 때의 재삭제/비노출 정책도 필요하다. |
| Google 일시 grant/토큰·운영 비밀 | 업무 export·공개 감사·문서·로그에 포함하지 않는다. 토큰/키는 복구 데이터와 별도 비밀 관리 | 새 동의/취득 완료·실패 경로의 revoke/clear를 확인한다. 저장된 `grant_deleted_at`만으로 provider revoke를 증명하지 않는다. |

### 필요한 승인 기록

- 정확한 tenant/job/source, 목적, 데이터 종류와 범위, 실제 승인권자 및 처리 담당자.
- 보관 시작 기준·종료/검토 시점·rollback window, 예외 보존 사유와 재검토일. 숫자는 승인자가 정하며 이 문서가 임의로 기본 기간을 만들지 않는다.
- 원문/집계/백업/지원용 요약의 접근 그룹과 tenant 분리, 암호화 저장소·키 보관/복구 책임자, 제공 수신자·전송 경로.
- 삭제 요청/사고 조사 등 보존 충돌 처리, 파기 증거와 복구 후 삭제 재적용, 승인된 리허설 결과.

승인서에는 학생 원문·비밀 값을 붙이지 않고 제한된 저장소의 참조와 digest를 사용한다. 참조·digest 자체도 공개하지 않는다. 장기 에이전트 기억이나 일반 작업 로그에 학생 개인정보를 저장하지 않는다.

### 최초 실제 import 전 통과 조건

위 승인 기록은 단순 체크리스트가 아니라 **첫 실제 import의 진입 게이트**다. 실데이터 복사본도 대상이며 preflight/리허설이라는 이름으로 영속 수집하는 raw 파일·staging·불변 audit에도 저장 전에 적용한다. 기관 데이터 승인권자와 테넌트 승인권자가 종류별 기간·목적·접근·삭제 예외를 승인하고, 복구 담당자/키 보관자와 독립 확인자가 실제 사용할 보호·복원 경로를 검증해야 한다. 역할 정의와 중단 안전 상태는 [런북 STOP 증거표](sheets-migration-runbook.md#42-운영자용-stop-증거표)를 따른다.

- 기간의 시작/종료·재검토일, 저장 위치와 사본 목록, 삭제 담당자, 기관 보존 의무/사고 조사 hold 충돌이 미정이면 새 실제 데이터 영속 수집·import를 보류한다. 학생 서비스는 현재 Sheets/Redis에서 유지한다.
- 현재 immutable payload를 승인된 기한 안에 처리할 수 없는 경우, 예외 보존을 정당하게 승인하거나 그 정책을 충족할 별도 절차를 구현·검증하기 전에는 적재하지 않는다. `expires_at` 필드, 장래 TTL 계획, 원본 Sheets 무기한 read-only 기본값은 이 충돌을 해결하지 않는다.
- 최초 import용 원본/증거를 복구할 수 있는 제한된 저장본, 분리 보관한 키/필수 메타데이터, 승인된 격리 환경의 독립 복호화·복원·내용/접근 경계 readback이 필요하다. 실제 데이터 리허설에도 먼저 처리·보관 승인을 받는다. 합성 fixture 통과만으로 실원본 복원 가능을 서명하지 않는다.
- 최종 활성화 전에는 최종 세대에 맞는 Task21 백업/export와 전환 이후 delta 복구 경로를 다시 검증한다. 초기 증거가 오래되었거나 schema·키·정책·데이터 범위가 바뀌면 재시험/재승인한다. 최초 import 승인과 최종 활성화 승인을 합치지 않는다.

이 문서는 어떤 기관의 실제 기간·키 담당자·복원 목표(RPO/RTO)·운영 승인도 확정하지 않는다. 미지정은 `미확인 → STOP`이며 임의 값으로 채우지 않는다.

## 3. 테넌트 격리와 내보내기 보안

- 인증된 Google 사용자와 현재 OWNER/ADMIN 권한 및 서버의 canonical tenant 해석을 사용한다. 요청 본문/URL ID나 호환 관리자 비밀번호만으로 다른 tenant의 export/삭제를 허용하지 않는다.
- [transaction.ts](../src/server/db/transaction.ts)의 트랜잭션별 `app.tenant_id`, tenant 복합 FK 및 RLS/FORCE RLS를 유지한다. runtime은 owner/superuser/BYPASSRLS가 아니어야 하며 migration용 특권 계정을 재사용하지 않는다.
- 생성·다운로드·폐기 때마다 해당 tenant/job/export의 binding과 현재 권한을 다시 검사해야 한다. DB RLS는 디스크 파일·object storage·공유 URL의 접근을 자동으로 막지 않는다.
- 지원용 요약은 allowlist로 만들어 학생 이름·QR·원본 진단·토큰·Sheet 내용·credential hash를 제외한다. [redaction 코드](../src/server/migration/sensitiveRedaction.ts)는 비밀 제거 경계를 제공하지만 익명화 보증은 아니다. hash·서명·암호화도 개인정보 공개 허가가 아니다.
- 업무용 파일에는 인증/QR/복구 코드·비밀키·OAuth/Redis 자격증명·credential hash를 넣지 않는다. 반면 DR 백업에서 복원상 필요한 secret hash를 임의 누락하면 복원성이 깨질 수 있으므로 **분리된 고위험 백업 정책**으로 처리한다. 평문 비밀을 백업 안에 넣어도 된다는 뜻은 아니다.
- 생성 파일에는 최소 tenant-scoped 데이터만 포함한다. 플랫폼 전역 registry, 다른 tenant의 충돌 자료 또는 다른 tenant/job/generation의 진단을 그대로 반환하지 않는다. 권한 거절 응답도 존재 유무·개인정보를 누설하지 않아야 한다.
- CSV/XLSX의 수식 실행 문자, 인용/개행/인코딩, 큰 정수·ID·날짜/시간대 손실을 방지하고 재가져오기 의미를 검증해야 한다. 안전한 업무 표시용 escape와 무손실 복구 포맷은 구분한다. **이는 exporter 구현·테스트에 필요한 조건이며 현재 제공 기능이 아니다.**
- 공개 링크, 이메일·메신저·공유 Sheets로 전달은 별도 명시적 승인 대상이다. 비밀이 포함된 URL·로그·원본을 외부 분석 도구에 보내지 않는다.

## 4. 내보내기 완료를 인정할 조건

**미구현/운영 전 선행 조건:** 다음 계약을 충족하는 exporter/복구 경로가 생기기 전에는 아래를 운영 명령으로 실행하지 않는다.

1. 요청자의 현재 권한과 목적·범위를 확인하고 정확한 tenant/job/export 식별자 및 포맷을 고정한다.
2. 일관된 snapshot/세대 또는 명시적 delta 경계를 사용한다. 이전/복구 export는 source·target fingerprint, 코드/schema 버전, 수집/대조 시각과 기준점을 결합한다. 작동 중인 DB에서 서로 다른 시각의 표를 묶어 일관된 백업이라고 하지 않는다.
3. 업무 데이터와 복구용 자료를 분리한다. 복구 대상에는 잔액·재고·전체 원장/조정/취소·과제/반복·claims/operation bindings/tombstones·source provenance와 audit가 빠지지 않아야 한다.
4. artifact를 제한된 암호화 저장소에 저장하고 실제 저장 바이트를 다시 읽어 digest·크기·포맷·범위·행/관계·민감정보 유출을 검증한다. 메타데이터의 READY만으로 파일 존재·완전성을 인정하지 않는다.
5. 다운로드도 현재 권한으로 재검증하고 비공개/no-store 경계를 유지한다. 만료·권한 회수·다른 tenant ID·변조 파일·잘린 파일에 대한 음성 검사가 필요하다.
6. 복구 목적이면 독립된 격리 환경에서 복원해 실제 데이터/제약/RLS/권한/trigger 및 업무 불변성을 검사한다. 총행 수만 비교하지 않는다. 승인된 실제 원본/복사본과 합성 자료를 구분한다.
7. 제한된 감사 기록에 생성·다운로드/전달·실패·만료/삭제 결과와 artifact digest·승인 참조를 남긴다. 원문이나 토큰을 기록하지 않는다.

전환 이후 DB delta의 경계·삭제/취소 의미·재적용 순서와 idempotency가 없는 export는 저장소 rollback에 사용할 수 없다. CSV만 확보해 구 Sheet URL로 돌아가는 것은 허용되지 않는다.

## 5. 실제 합성 백업 스크립트: 확인한 명령과 제한

저장소 [package.json](../package.json)에는 운영 backup/export npm script가 없다. 감독용 파일은 저장소 밖 호스트 경로에만 있으므로 다른 환경에서 존재한다고 가정하지 않는다. 이 문서 작업은 스크립트를 읽고 아래 `--help`만 실행했다. **백업/복원 본 실행은 하지 않았다.**

### 부작용 없는 명령/경로 확인

```sh
python3 -B /home/haeon/workhub-tasks/live/class-store-supervision/isolated-backup-restore.py --help
sha256sum /home/haeon/workhub-tasks/live/class-store-supervision/isolated-backup-restore.py
```

실제 parser가 제공하는 옵션은 `--encrypt`, `--encrypt-stored`, `--help`다. `--help`는 컨테이너 생성 전에 종료한다. digest는 실행/검토한 스크립트 버전을 기록할 때 사용하며, 과거 ROADMAP의 digest를 현재 파일 값으로 재사용하지 않는다.

### 별도 승인된 격리 리허설에서만 실행할 실제 명령

다음은 존재하는 스크립트의 실행 방식이지 이번 문서 작업의 실행 내역이 아니다. 컨테이너·임시 파일·로컬 DB를 생성/제거하므로 허용 범위를 먼저 확인한다.

```sh
python3 /home/haeon/workhub-tasks/live/class-store-supervision/isolated-backup-restore.py --encrypt-stored
```

스크립트를 읽어 확인한 전제와 동작:

- 호스트의 고정 저장소 경로 `src/server/db/migrations/*.sql`과 스크립트 옆 `pg-local-rehearsal.sql`을 읽는다. 병렬 변경이 끝난 검토 대상 revision을 먼저 정해야 한다.
- Docker 사용 권한과 **이미 설치된** `postgres:17-alpine` 이미지가 필요하다. `--pull never`, `--network none`, 외부 포트/volume 연결 없는 별도 원본·복구 컨테이너를 쓴다. `POSTGRES_HOST_AUTH_METHOD=trust`는 이 폐기형 격리 fixture에만 해당하며 운영 설정으로 복사하지 않는다.
- `--encrypt-stored`에는 Python `cryptography`가 필요하다. 없으면 BLOCKED로 종료하며 설치나 평문 fallback을 하지 않는다.
- 모든 현 migration과 합성 LOCAL_CANDIDATE fixture를 적재하고 custom `pg_dump -Fc`를 독립 클러스터에 `pg_restore`한다. 스크립트의 `TABLES` 목록에 한해 전체 행 JSON 정렬/digest·수를 원본과 복구본 사이에서 비교한다. 모든 업무 표/권한의 전수 복원 검증은 아니다.
- 원본·복구 두 클러스터에서 `migration_final_generations`, `migration_final_source_records`, `migration_final_targets`, `migration_local_generation_reconciliation`을 대상으로 RLS/FORCE RLS가 함께 설정된 catalog 행 수가 4인지 검사한다. trigger 검사는 같은 네 테이블의 non-internal·enabled(`tgenabled='O'`) trigger **합계가 4 이상인지**만 확인하며, 테이블별 기대 trigger 이름·개수의 일치나 UPDATE/DELETE/TRUNCATE 거부 동작을 검사하지 않는다.
- 실제 tenant별 행 필터링 검사는 합성 `local_probe` role의 `migration_final_generations` **단일 테이블 SELECT**에 한정한다(다른 tenant 0행, 자기 tenant 1행; 원본·복구 양쪽). 별도로 양쪽에서 `tenant_auth_secrets.secret_hash` SELECT의 권한 거부를 검사한다. 이를 다른 테이블의 RLS 동작이나 전체 업무 쓰기·권한 검증으로 확대하지 않는다.
- AES-256-GCM의 메모리 전용 새 키, 잘못된 키/변조 거부, 복호화 바이트 일치를 검사한다. `--encrypt-stored`는 암호문만 임시 디렉터리 0700/파일 0600에 쓴 뒤 읽어 메모리에 가져오고 **임시 경로를 삭제한 다음** 음성 검사·복호화·복원을 진행한다. 키·nonce·AAD를 지속 복구용 envelope로 저장하지 않는다. 같은 Python 프로세스가 가진 키/메타데이터를 쓰므로 프로세스 종료·키 상실 뒤의 복구 시험이 아니다. 키/덤프/암호문을 출력하지 않는다.
- `finally`에서 컨테이너별 `docker rm -f`를 **시도**하지만 반환 코드를 확인하지 않고 출력을 버린다. 완료 문구도 실제 제거 확인 전에 출력되므로 로그의 “removed”만으로 정리 성공을 선언하지 않는다. 격리 리허설 담당자가 해당 실행에서 생성한 정확한 컨테이너/임시 경로의 부재를 별도로 확인해야 한다. 다른 worker의 자원은 손대지 않는다. 임시 파일 unlink는 **안전 삭제 증거가 아니며**, Python 메모리의 모든 복사본 소거도 보장하지 않는다.

**이 리허설로 주장할 수 없는 것:** 운영 데이터 백업, 지속 보관/운영 키 복구, 실원본 완전성, 모든 표·역할·업무 불변성, PITR, RPO/RTO 달성, live writer 동결, cutover 또는 Sheets rollback. 메모리 전용 키가 사라지는 이 스크립트는 장기 보관 백업 생성기가 아니다. 실제 복구 준비에는 별도 운영 저장소·키 관리와 승인된 데이터 복원 시험이 필요하다.

### 저장 백업과 키의 운영 경계 — 아직 충족해야 할 계약

`--encrypt-stored` 통과와 **나중에 다시 열어 복원할 수 있는 운영 백업**은 다르다. 후자에는 다음이 필요하며 이 스크립트/현재 export 스키마가 제공한다고 주장하지 않는다.

- 지속 artifact와 분리 보호된 키의 정확한 연결: backup ID, tenant/범위, source/job/generation 또는 snapshot/시점, 코드/schema·dump 포맷/도구 버전, 암호화 방식·키 ID/버전, nonce·인증 tag·AAD 등 복호화 필수 메타데이터, 실제 저장 바이트의 크기/digest, 보관 기한과 복구 책임자. 비밀 키는 문서/로그/일반 manifest나 암호문 옆에 평문으로 두지 않는다. 인증 tag의 저장 방식은 승인된 포맷에 따른다.
- 키와 백업을 독립된 권한 경계로 보관하고 유효한 이전 키 버전/복구 수단도 필요한 보관 기간 동안 유지한다. 키 회전·폐기는 연결된 백업과 보존 의무를 확인한 별도 승인 행위다. 복구 사본 없이 키를 잃으면 암호문이 있어도 복원할 수 없다. 새 키 생성은 기존 암호문의 복구 수단이 아니다.
- 별도 프로세스/격리 환경에서 **지속 저장된** artifact·메타데이터와 승인된 키 복구 경로만으로 읽기→인증 복호화→복원→독립 내용/권한 검증을 해야 한다. 테스트 직전 메모리 평문이나 현 프로세스의 원키에만 의존해서는 안 된다. 실패하면 원본/정상 백업을 덮어쓰거나 삭제하지 않는다.
- digest는 승인된 별도 증거와 비교한다. 암호문과 함께 놓인 digest도 함께 바뀔 수 있으며 digest 일치만으로 출처·최신성·tenant binding을 증명하지 못한다. 암호 인증 통과도 누락된 표/업무 관계, 올바른 시점, 전체 복원 성공을 보장하지 않는다.

### 운영자용 저장 백업·복원 STOP 증거표

각 행에 정확한 artifact/키 **식별자**(비밀 값 제외), tenant/source/job/세대·버전, 제한된 증거 위치/digest, 관찰 시각·유효/재검토 기한·무효화 조건, 실행자/독립 확인자, 실패 코드/영향 범위, 승인 참조를 남긴다. **미확인·기한만료·불일치는 모두 STOP**이며, 기존 PASS는 대상 artifact/schema/키/권한/정책이 바뀐 뒤 재사용하지 않는다. 아래 S0/S1/S2와 승인 역할은 [이전 런북](sheets-migration-runbook.md#42-운영자용-stop-증거표)의 정의와 같다. 표는 미완료 운영 양식이며 이번 작업의 성공 기록이 아니다.

| 증거 / 실패 경계 | 유지할 안전 상태와 금지 사항 | 재개에 필요한 검증·승인권자 |
| --- | --- | --- |
| 저장본/포맷·범위·보관 승인/접근 기록 없음, 기한 경과, artifact/tenant/시점 불일치 | 해당 백업 사용·공유·파기 및 의존하는 import/활성화 보류. 마지막 정상본과 원본을 유지. 미동결 S0; 이미 동결/활성화·불명 상태는 S1/S2 | 복구 담당자와 독립 확인자의 저장 바이트/범위 재검증, 기관 데이터 및 테넌트 승인권자; 운영 변경은 운영 변경 승인권자 |
| 키 상실/권한 회수/키 버전·nonce·AAD 누락 또는 불일치 | **복구 불가 또는 미검증**으로 기록. 임의 새 키·평문 fallback·인증 생략 금지. 승인된 키 복구 경로가 없으면 진행 불가; S0/S1/S2 유지 | 키 보관자의 분리 복구 수단 및 정확한 binding 복구, 독립 복호화/복원 시험 후 기관 데이터·운영 변경 승인권자와 테넌트 승인권자 |
| 인증 tag 실패, 잘림·변조 의심, digest 불일치 | artifact를 복원/배포하지 않고 접근 제한해 증거 보존. 실패만으로 잘못된 키/메타데이터와 공격을 단정하지 않음. 바이트 수선·재암호화로 정상 처리하지 않음. S0/S1/S2 유지 | 복구 담당자·보안/데이터 담당자의 원인 확인, 별도 신뢰 원본/정상본 재확보·시험 후 기관 데이터·운영 변경 승인권자 및 테넌트 승인권자 |
| 복호화 성공이나 `pg_restore` 오류·중단, role/extension/schema 불일치, 제약/trigger/RLS 누락, 행/관계/금액/claims 차이 | **복원 실패/부분 복원**이며 서비스 투입 금지. 격리 실패 대상·정상본과 오류 증거를 분리하고 운영 대상에 덮어쓰지 않음. 오류 무시·제약/RLS 해제·특권 runtime으로 통과시키지 않음. S0/S1/S2 유지 | 복구 담당자 원인 수정 및 별도 깨끗한 격리 대상에서 전체 재시험·독립 대조, 운영 변경 승인권자와 테넌트 승인권자; 데이터 범위 변경은 기관 데이터 승인권자 |
| 복원 시험 없음/기한만료, 최종 세대나 post-cutover delta 누락, 실제 데이터 대신 합성 결과만 있음 | “복원 가능”·RPO/RTO 달성·무손실 rollback 판정 금지. import/활성화/저장소 rollback의 해당 게이트 STOP; S0/S1/S2. stale Sheet로 돌아가지 않음 | 복구 담당자와 독립 확인자의 승인 범위 전체 시험 후 운영 변경/테넌트 승인권자; 실제 데이터 시험은 기관 데이터 승인 필요 |
| 임시 자원 정리/백업 만료/삭제 readback 없음 또는 파기·감사 보존 충돌 | 완료 문구나 EXPIRED만으로 제거 완료 처리 금지. 잔류 사본 접근 제한, 다른 worker 자원 제거·마지막 정상본/키의 임의 폐기 금지 | 처리 담당자의 정확한 대상 재확인 후 기관 데이터 승인권자; 자원/서비스 변경이면 운영 변경 승인권자도 필요 |

복원 시험 실패는 **실패 대상만 격리**하는 것이 기본이며 현재 정상 Sheets 서비스를 중단하거나 DB로 전환할 이유가 아니다. 이미 동결한 상태라면 자동 해제하지 않고, 활성화 이후라면 PostgreSQL 권위를 유지한 forward repair 경계에서 별도 승인된 복구를 설계한다. 응답 유실로 실제 복원/commit 결과가 불명확한 경우에는 성공·실패 어느 쪽도 추정하지 말고 정확한 대상 readback 전까지 서비스 연결/재시도를 보류한다. 재개 승인만으로 미구현 복구 경로나 누락된 무손실 증거가 채워지지는 않는다.

## 6. grant 수명과 기존 서비스 보호

[googleSheetsConsent.ts](../src/server/migration/googleSheetsConsent.ts)는 일시적 브라우저 결합 grant와 revoke 경계를 두며 durable background grant는 타입/조건만 있고 저장 기능은 의도적으로 미구현이다.

- migration OAuth client/project는 기존 배포 grant와 격리되어야 한다. 동일 Google authorization project에서 revoke가 연관 grant에 영향을 줄 수 있으므로, 개발 중 기존 서비스 중단을 일으키는 자격 재사용/회수를 하지 않는다.
- fresh consent는 해당 목적·tenant/job/source·사용자·세션·시각에 결합되어야 한다. 재동의 자체는 writer 차단 또는 내보내기/삭제 승인이 아니다.
- 성공/실패 뒤 revoke/clear 실패를 숨기거나 `grant_deleted_at`을 임의로 채워 완료 처리하지 않는다. provider 결과와 로컬 정리 결과를 구분해 제한된 감사 증거로 남긴다.
- 토큰·refresh token·암호화 키·등록 비밀은 업무 파일, 보고서, 캡처, 문서, 코드 저장소에 넣지 않는다. 이 문서는 어떤 자격증명도 변경하거나 회수하도록 승인하지 않는다.

## 7. 삭제·만료·증거 보존

### 현재 삭제 경계

[0016 migration](../src/server/db/migrations/0016_migration_snapshots_immutable.sql)은 snapshot의 UPDATE/DELETE와 TRUNCATE를 막는다. FK에 ON DELETE CASCADE가 있어도 보존 snapshot에 도달하는 source/job/tenant 삭제는 실패한다. [snapshot 계약](migration-snapshot-retention.md)은 이를 의도된 보존으로 명시한다. 감사·claims/tombstones 및 로컬 후보 증거에도 불변 제약이 있으므로 일반적인 tenant 삭제나 일괄 cascade로 해결할 수 있다고 안내하지 않는다.

운영 계정으로 trigger를 끄거나 owner/superuser로 우회하지 않는다. 테스트 fixture의 tampering helper를 운영에 쓰지 않는다. 법적/기관상 삭제 의무가 있다면 접근을 제한하고 승인권자에게 충돌을 알린 뒤 **별도 승인·검토·구현된 보관 예외 절차**로 해결해야 한다. 현재 그 운영 절차는 없다.

### 이후 예외 삭제 절차가 갖추어야 할 조건

- [ ] 현재 처리 권한·정확한 tenant/source/자료 종류·삭제 사유와 범위를 확인한다. 원문 보관 목적 종료, 감사/사고 조사 hold, 기관 규정과 충돌 여부를 판단한다.
- [ ] rollback/재대조/중복 방지 의존성을 검토하고 삭제 후에도 필요한 최소 증거를 유지할 방법을 승인받는다. 보관 연장도 근거·기한·재검토가 필요하다.
- [ ] 원본, staging, immutable audit의 민감 payload, export 파일·object version, 전달 사본, 캐시/로그, 백업·복제본·키에 대한 적용 범위와 지연 만료를 구분한다. 하나를 지운 사실을 “모든 사본 삭제”라고 보고하지 않는다.
- [ ] 승인된 방법으로 처리하고 정확한 대상의 접근 불가/부재·작업 실패·잔류 사본·예외 보존을 readback한다. 파일 경로 삭제/DB 상태 EXPIRED/키 삭제가 실제 내용 소거와 같은지 따로 검증한다.
- [ ] 요청/승인 참조, 처리자·시각·대상 범위·방법·결과·잔류 사본의 종료 예정과 제한된 artifact digest를 감사 증거로 유지한다. 삭제한 학생 원문을 파기 보고서에 다시 복사하지 않는다.
- [ ] 이전 백업 복원으로 삭제 자료가 다시 서비스에 노출되지 않도록 복원 후 삭제/비노출 정책을 적용·검증한다.

모든 불변 증거를 영구 공개 보관하자는 뜻이 아니다. 최소 집계/결정 증거의 지속성과 민감 원문 최소화를 함께 만족할 구조가 먼저 필요하다. 현재 불변 payload를 익명화했다고 주장하거나 재기록하지 않는다.

## 8. 전환·rollback·종료 승인과의 관계

- 최초 실제 import 전의 보관·키/원본 복구 게이트와, Task21의 데이터 보존 가능한 backup/export·독립 복원 리허설을 갖춘 **최종 활성화 전 복구 게이트**를 각각 통과해야 한다. 후자의 존재를 이유로 민감정보 보관/복구 결정을 초기 import 이후로 미루지 않는다. UI 편의 기능은 나중에 보완할 수 있어도 복구 가능성을 생략할 수 없다.
- 활성화 이후 애플리케이션 버전을 되돌려도 PostgreSQL이 권위다. 저장소 rollback은 DB의 모든 writer 차단, 전환 후 전체 delta 적용과 독립 대조, 원자적 authority 교체 뒤에만 기존 writer를 여는 별도 이전이다. 미구현 상태에서 stale Sheet로 돌아가지 않는다.
- 기존 Sheets read-only 보관 종료·구 URL 폐기·Redis 원본 폐기·export 만료·tenant 삭제는 서로 다른 결정이다. 하나의 승인을 나머지 승인으로 확대하지 않는다.
- 보고서에는 `문서/코드 확인`, `합성 격리 리허설`, `승인된 실제 데이터 복원`, `운영 적용`을 분리하고 각 실행자·버전·증거·미검증 범위를 적는다. 이번 문서 작성은 첫 번째 범위이며 실제 데이터 처리·복원·삭제가 아니다.

**현재 남은 필수 조건:** 실제 데이터 보관/접근 승인, 지속적인 암호화 백업·키 복구, tenant-scoped exporter 및 검증된 다운로드/만료, 최종 불변 보고서와 post-cutover delta 복구, 삭제 예외/백업 재삭제 정책, 승인된 실원본의 독립 복원 검증. 이 조건들이 없는 상태에서 복구 가능·자동 삭제·운영 이전 완료라고 선언하지 않는다.
