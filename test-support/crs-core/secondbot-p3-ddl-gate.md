# Secondbot P3 core — DDL 통합 게이트 인계

상태: BLOCKED_DDL_INTEGRATION. 기능 구현 완료나 REVIEW_READY가 아니다.
Task19 수용: 0/8. 실제 final import 연결: NOT_IMPLEMENTED. 운영 안전성: NOT_PROVEN.
소유자: secondbot. 통합/독립 검증: Sol, 아직 수행되지 않음.

## 이번 작업의 실행 범위

- 지정 감독 문서, 저장소 AGENTS.md, migration 핵심 코드 및 관련 DDL을 읽었다.
- 감독 문서의 실제 위치: /home/haeon/workhub-tasks/live/class-store-supervision/.
- cutover.ts 전체를 읽어 ABORT 서비스만 있는 것을 확인했다. 별도 읽기 전용 Python 조회에서도 export 함수는 createLegacyCutoverAbortService, SQL status 대입은 ABORTED만 추출됐다. 이는 코드 존재 확인이지 동적 안전성 시험이 아니다.
- DDL 변경이 필요하면 멈추라는 배정에 따라 구현 코드를 수정하지 않았다. 아래 설계는 제안이며 적용된 API/스키마가 아니다.
- 이번 작업의 신규 파일은 이 인계 파일과 secondbot-p3-source-inspection.json뿐이다. 기존 dirty/untracked 코드·테스트·DDL은 이번 작업의 변경이 아니며 보존했다.
- shared Vitest/tsc/lint/build/Docker/PG runner, 실제 Sheets/Redis writer, 운영 자원, 계정/권한, commit/push는 실행하지 않았다. 가짜 fence receipt나 진행 상태도 만들지 않았다.

읽기 전용 소스 조회:
- HEAD: fe0d13b37e87f34934787c68fd72c49cca35bd1d
- branch: feat/postgres-multitenant-migration
- 조회 시각: 2026-09-26T11:19:21.722618+00:00
- Python 조회 종료 코드: 0. 이 값은 테스트 PASS가 아니다.
- 실제 argv, 소스별 SHA-256, 조회 결과/시간은 secondbot-p3-source-inspection.json에 보존한다.
- 파일 일부의 조회용 fingerprint일 뿐, 수정 중인 공유 트리 전체의 고정 검증 스냅샷이 아니다. Sol이 통합 전에 현재 tracked/untracked 의존성까지 다시 고정해야 한다.

## 차단 근거: 단순 TypeScript 확장으로 닫을 수 없는 저장 계약

경로는 저장소 루트 기준이다.

1. src/server/migration/cutover.ts:41-45,83-94
   - 서비스는 ABORTED 기록/동일 트랜잭션 readback만 한다.
   - FREEZING→FINAL_IMPORT→ACTIVE 실행 경로와 외부 writer 해제는 없다.

2. src/server/db/migrations/0024_local_final_generation_stage.sql:31-48
   - migration_final_source_records.source_row_number는 NOT NULL이며 source_collection='Products' CHECK가 있다.
   - migration_final_targets는 target_table='products' CHECK와 (tenant_id,record_id) PK를 가진다. source record와 같은 record_id를 참조하므로 한 source record가 여러 targets를 가리키는 일반 관계를 표현하지 못한다.
   - Students→students/accounts, Transactions→transactions/items, Tasks→tasks/allowed_students와 Redis claim/tombstone을 해당 스키마 그대로 저장할 수 없다.
   - Redis pointer에는 Sheet row number가 없다. 임의 번호를 만들거나 Products로 위장해서 저장하면 provenance가 거짓이 된다.
   - :27 및 :83은 LOCAL_CANDIDATE / NOT_PROVEN을 강제한다. 이 라벨을 FINAL_FROZEN이나 권위 증명으로 바꾸면 안 된다.
   - :71-89의 집계 표는 category별 count/delta를 저장한다. count MATCH만으로 전량 target byte equality나 원본 completeness를 증명할 수 없다.

3. src/server/migration/localMultiAddedProductStage.ts:70-125
   - 실제 SQL stage/readback은 존재하지만 여러 ADDED Products만 쓰고 비교한다. 전체 최종 세대가 아니다.
   - 기존 세대가 있으면 children을 보충하지 않고 정확히 일치하는 retry만 허용하는 원칙은 유지할 가치가 있다.

4. src/server/migration/importer.ts:1324-1371,1695-1727
   - 기존 importer는 DRAFT/IMPORTING tenant와 VALIDATED/IMPORTING job, 고정 source_fingerprint/PREFLIGHT manifest만 허용한다.
   - 기존 target이 다르면 Target conflict로 거부한다. candidate 수정/삭제를 적용하는 importer가 아니다.
   - sourceId는 artifact digest 기반(:1787-1788)인데 migration_sources에는 (provider,external_source_id) 전역 unique가 있다(0003_operations_migrations.sql:182-185). 같은 Sheet 새 acquisition을 새 원본 소유자로 다시 등록하는 방식은 세대 저장 모델이 아니다.
   - global claims/operation bindings/tombstones는 deferred 상태로 남으며 importer의 operational publication 대상이 아니다. 재시도 조건이나 deferred 판정을 약화해 연결하지 않는다.

5. src/server/migration/finalGeneration.ts:30-33,80-91,96-138
   - 원본 inspector와 READY/version binding 이후 쓰는 것은 immutable audit envelope다. planner의 DIFF_VALIDATED는 실행 가능한 import SQL을 뜻하지 않는다.
   - mutable 범주 ADDED/REMOVED/MUTATED를 계획할 수 있으나 이력 변경/삭제는 APPEND_ONLY_HISTORY_CHANGED로 차단한다.
   - claim 재취득 provenance 예외는 :141-192의 제한된 비교일 뿐 저장 bytes/digest 변경 권한이 아니다.
   - localFullDeltaCheckedPreparation.ts:15-31,51-65와 localFullCategoryDeltaCoverage.ts:38-43,70-96은 더 엄격한 ADDED-only local 검사다. 이를 전량 persisted import로 부르거나 기존 거부 시험을 약화하면 안 된다.

6. src/server/db/migrations/0003_operations_migrations.sql:139-168
   - job 전환 guard는 UPDATE 상태 순서/버전 검사다. 이것만으로 generation/대조/승인/배제 결합이나 INSERT 진입 보호가 성립하지 않는다.
   - tenants ACTIVE 진입 및 동일 상태 증거 변경 보호도 Sol의 별도 P4 DB 통합 범위다. 이 작업은 해당 보호를 설치/검증하지 않았다.

검증 실패의 정확한 의미:
- 정적 저장 계약의 수용 불가를 확인한 것이다. 실행한 PostgreSQL에서 에러가 났다고 보고하는 것이 아니다.
- 현재 DDL에서 Products 외 source_collection 또는 products 외 target_table을 넣으면 CHECK 거부가 예상된다. 실제 SQLSTATE/로그는 NOT_RUN이다.
- PG 시험을 직접 우회 실행하거나 임시 trigger-disable, 새 권한, fake receipt를 사용하지 않았다.
- audit JSON에 전량 candidate를 보관하는 것만으로 위 row/관계/대상 저장 계약을 대신할 수 없다.

## Sol 독점 통합에 필요한 최소 DDL 설계 제안

결정 필요: 기존 Products-only 0024를 완화해 과거 증거 의미를 바꾸지 않고, 별도의 versioned full-generation 저장 구조를 additive migration으로 도입하는 방안을 권한다. 아래 명칭은 제안이며 현재 저장소에 없는 테이블이다. migration 번호·배포 정책·권한 부여는 Sol이 결정한다.

공통:
- generation 범위 키 G=(tenant_id uuid, job_id text, generation_id text).
- 모든 children의 FK와 UNIQUE/PK에 G를 포함한다. cross-tenant/cross-job reference 거부, FORCE RLS, immutable UPDATE/DELETE 및 TRUNCATE 거부를 유지한다.
- JSON shape는 nullable SQL CHECK 우회 없이 `(predicate) IS TRUE`로 검사한다. SHA-256 문자열은 64자리 소문자 hex, ordinal/count는 safe integer 범위다.
- SQL 길이 제한은 기존 입력 한계와 JSONB 직렬화 차이를 검토해 확정한다. 임의로 데이터 한계를 줄이거나 지원 외 이력을 버리지 않는다.
- runtime은 nonowner/NOSUPERUSER/NOBYPASSRLS, DDL/trigger-disable/TRUNCATE 금지. 실제 역할/권한 변경은 이번 작업에서 하지 않는다.

A. migration_full_generations — 세대 header
- PK G; original_source_id/original_snapshot_id/original_snapshot_phase='PREFLIGHT'는 기존 0024에 있는 composite snapshot FK와 같은 binding을 사용한다.
- original_manifest_digest, original_source_fingerprint, candidate_manifest_digest, candidate_source_fingerprint, candidate_sheet_digest, candidate_redis_digest를 각각 text NOT NULL로 보관한다. semantic fingerprint를 artifact digest 대신 사용하지 않는다.
- original_event_id/candidate_event_id/plan_event_id 및 expected_state_version을 고정한다. tenant별 audit FK만으로 event.job_id/종류/본문 binding은 증명되지 않으므로 같은 transaction에서 envelope를 전량 재검사한다.
- format_version과 projection_version을 고정하고 content address 계산에도 넣는다. 원본 source owner를 덮어쓰거나 같은 외부 원본을 새 owner로 등록하지 않는다.
- 비운영 stage는 LOCAL_CANDIDATE/NOT_PROVEN을 유지한다. 이 header에는 외부 배제나 activation capability가 없다. 이후 운영 최종 generation은 별도 승인된 acquisition과 P4 gate가 필요하다.

B. migration_full_generation_sources — 전량 normalized source rows
- PK (G, source_ordinal), source_ordinal은 해당 immutable manifest 배열의 순서다. 단순 sourceDigest Set으로 다중 contributor를 합치지 않는다.
- source_kind, artifact_digest, source_pointer jsonb, normalized_source jsonb, record_digest를 고정한다. SHEET pointer는 tab/rowNumber/rowHash, REDIS pointer는 provenance/sourceDigest의 서로 다른 shape를 검사한다. Redis에 임의 Sheet 번호를 부여하지 않는다.
- canonicalRecord=null인 source, warning, unmapped source도 원본의 일부로 보관/대조한다. QUARANTINED/지원 외 history가 있으면 stage 검증 통과를 내지 않는다.
- 원본 capture pointer 전량과 normalized source multiset의 관계를 별도로 검사한다. JSON 저장 건수가 같다는 것만으로 completeness를 인정하지 않는다.

C. migration_full_generation_targets — 전량 비활성 target rows
- PK (G, target_table, business_identity). business_identity는 identity tuple의 canonical JSON text로 고정해 복합 key 충돌/NUL 구분자 문제를 피한다.
- canonical_target jsonb와 target_digest, normalized mapping target ID를 보관한다. target은 source record PK에 종속시키지 않는다.
- 허용 catalog는 finalGeneration.ts IDENTITIES의 전체 범주: students, accounts, products, settings, tasks, task_allowed_students, promotions, promotion_products, transactions, transaction_items, adjustments, task_assignments, task_completions, legacy_operation_bindings, padlet_evidence_claims, padlet_claim_digest_tombstones.
- snapshot 전량을 넣는다. ADDED만 넣거나 원본 targets와 느슨하게 JOIN해 빠진 retained row를 가리지 않는다. 원본 generation은 불변으로 남긴다.
- canonical staging은 operational SQL projection/게시와 다르다. importer의 실제 projection/domain/FK/unique 검사와 연결하지 못한 범주는 NOT_IMPLEMENTED로 남긴다. 단순 JSON 적재 성공을 operational import 성공으로 보고하지 않는다.

D. migration_full_generation_mappings + migration_full_generation_contributors
- mappings PK (G,mapping_ordinal): 원래 sourceDigest/targetTable/targetId/status를 보존하고 실제 target FK로 연결한다.
- contributors PK (G,mapping_ordinal,source_ordinal): mapping FK와 source FK를 함께 가진다. source→target fan-out 및 claim의 다중 provenance를 별개로 표현한다.
- transaction_items의 source는 transaction row이고 claim/binding ID는 업무 identity와 다를 수 있다(finalGeneration.ts:166-192). 최초 source 임의 선택이나 Set dedup 대신 명시적 typed relation을 써야 한다. 모호하거나 고아인 관계는 거부한다.
- capture의 source, normalized source, mappings, contributor edges, targets 각각의 독립 multiset readback을 요구한다.

E. migration_full_generation_changes
- PK (G,target_table,business_identity); change_kind=ADDED/REMOVED/MUTATED, before_digest/after_digest를 저장한다.
- ADDED는 before NULL/after digest, REMOVED는 before digest/after NULL, MUTATED는 두 digest가 존재하며 다르도록 CHECK한다.
- 원본과 candidate 전체를 독립 diff하여 plan 누락/중복/기형 digest를 거부한다. retained row도 비교하므로 change가 없다는 거짓 계획으로 누락을 숨길 수 없다.
- mutable 변경/삭제는 새 비활성 generation의 상태로 표현한다. 원본 행을 DELETE/UPDATE하지 않는다. history/claim/binding/tombstone 변경·삭제는 기존 append-only 정책에 따라 BLOCKED이며, tombstone의 소거로 해석하지 않는다.
- 합법적 claim recapture provenance만 바뀐 경우도 두 capture bytes/digest는 보존한다. 기존 제한된 동등성 규칙을 재검증할 수 없는 경우 fail closed한다.

F. migration_full_generation_reconciliation
- PK (G,category). 0행 범주도 catalog에 명시한다. source/mapping/contributor/target/change별 expected_count/actual_count 및 canonical multiset digest를 저장한다.
- same-count substitution을 count MATCH로 통과시키지 않는다. byte-level readback/domain 검증 후에만 local 일치를 기록한다.
- reconciliation에는 generation header의 manifest/fingerprint/버전 binding을 결합한다. 기존 job-only reconciliation_results의 행을 재사용해 다른 generation 대조와 섞지 않는다.
- 이 표의 MATCH도 source writer exclusion, snapshot freshness, 운영 승인이나 ACTIVE 권한은 아니다.

## DDL 확정 이후 구현할 최소 수직 경로

1. 입력은 미신뢰 original/candidate acquisition이다. descriptor/shape/bounds/digest/지원 이력 검사와 exact normalization을 먼저 한다. 호출자가 manifest/report/checker/receipt/status를 교체하는 인자는 받지 않는다.
2. tenant→job 순서로 잠근 뒤 현재 lifecycle, READY 및 expectedStateVersion, 유일한 import owner를 검사한다. persisted original snapshot/source/fingerprint와 inspectLegacyImport 전량 증거를 결합한다. 이 원본 검사가 끝나기 전 candidate를 원본 importer에 넣지 않는다.
3. persisted immutable envelope를 다시 읽어 원본/candidate/plan content address와 binding을 검사한다. ADDED/REMOVED/MUTATED 전량 계획과 append-only policy를 독립 확인한다. 기존 ADDED-only wrapper의 계약은 유지하고, full stage에는 별도의 전량 검사를 연결한다.
4. 새 G에 header, source, mapping/contributor, full target, change를 같은 transaction으로 저장한다. projection/domain/관계 충돌이나 지원 불가 이력은 전체 rollback한다. 운영 targets/global claim registry는 건드리지 않는다.
5. G의 각 테이블 전체를 각각 SELECT하여 exact multiset을 대조한다. 기대 ID만 IN으로 읽거나 inner JOIN으로 누락/고아를 숨기지 않는다. claims/bindings/tombstones와 빈 범주까지 검사한다. 전량 대조가 끝난 후 같은 G에 reconciliation을 저장하고 그것도 readback한다.
6. G가 이미 있으면 정확한 header/children/대조의 읽기 전용 동일 retry만 허용한다. 부분 children 보충, upsert 덮어쓰기, 변경된 plan/capture의 재사용은 거부한다. callback 재시도마다 attempt-local evidence를 비운다.
7. commit 이전 강제 정지는 전량 rollback, commit 이후 응답 유실은 정확한 동일 retry로 readback한다. stopped/ABORTED/version 변경 후에는 재개하지 않는다. 오류 문자열은 원본/학생 정보/SQL payload를 누출하지 않는다.
8. 반환은 비권위 staged 검증임을 유지한다. importLegacyNormalizationManifest의 허용 상태를 넓히거나 원본 READY를 새 FINAL_IMPORT로 위조하지 않는다. operational projection→실제 DB 게시→권위 교체는 외부 gate와 P4 통합 전 NOT_IMPLEMENTED다.

## Sol 직렬 검증 큐 — 모두 NOT_RUN

이번 작업에서 RED/GREEN, 단위시험, PGlite, 실제 PG, 강제 프로세스 종료, tsc, ESLint, build를 실행하지 않았다. 테스트 수는 측정되지 않았으므로 PASS/FAIL/SKIP을 0으로 만들어 쓰지 않는다.

우선 재현할 schema/수직 경로 시험(새 구현/테스트 필요):
- 기존 DDL: 허용된 부모 fixture 아래 Students/non-product target과 REDIS source를 직접 넣는 반례. 현 스키마의 실제 constraint 실패를 수집한 뒤 새 DDL의 full typed graph로 RED→GREEN을 수행한다. fixtures 상태는 합성 setup이지 실제 전환 증거가 아니다.
- 전 범주 retained/ADDED와 mutable REMOVED/MUTATED를 한 generation에서 저장/대조. 이력/claim/tombstone 제거·변형은 강제 거부, 합법적 recapture만 별도 검증.
- saved snapshot/manifest/fingerprint 위조·누락, job/version/tenant/source 바꿔치기, candidate source revision 변동, 빈 capture와 누락 capture 구분.
- target/source/mapping/contributor/change 각 테이블의 1행 누락·추가·중복·동일 건수 치환, orphan claim, claim/tombstone 충돌, 중복 business identity, 의존 graph 위반.
- stage 중간 SQL 예외, write suppression, readback 불일치, callback 미실행/결과 대체를 거부하고 원본/운영/전역 claims 불변 확인.
- 실제 격리 PG에서 commit 전 backend/작성 프로세스 강제 종료 후 새 connection으로 0개 부분 세대 확인. commit 후 응답 유실 재시도는 동일 bytes/동일 IDs/추가 쓰기 0을 확인. 단순 throw 시험으로 프로세스 정지 증거를 대체하지 않는다.
- 두 PG connection에서 동일 G 재시도, 서로 다른 generation, ABORT/version race를 시험. 실제 stopped 상태와 다른 tenant가 막히는지 확인.
- P4: 동일 tenant 직접 DML UPDATE/INSERT, stale evidence, concurrent ACTIVE, 신규 tenant vs legacy 진입을 모두 거부/분리. 현재 guard prototype만 통과해서 ACCEPTED로 올리지 않는다.
- fixture에서의 fake fence 성공은 금지. writer exclusion은 전체 Sheet/Redis writer inventory와 외부 관찰/유지 증거가 없으면 NOT_PROVEN. 이 승인 범위에서 운영 writer 시험은 하지 않는다.

기존 회귀의 실행 후보(존재 확인됨; Sol이 자원/스냅샷 고정 뒤에만 실행):

    npm test -- src/server/migration/cutover.test.ts src/server/migration/finalGeneration.test.ts src/server/migration/importer.test.ts src/server/migration/importer.timestamps.test.ts src/server/migration/localFullDeltaCheckedPreparation.test.ts src/server/migration/localFullDeltaCheckedPreparation.captureBinding.test.ts src/server/migration/localFullCategoryDeltaCoverage.test.ts src/server/migration/localFullCategoryDeltaCoverage.compositeRetained.test.ts src/server/migration/localMultiAddedProductStage.test.ts --maxWorkers=1

기존 Products-only 실제 PG 회귀의 명시 opt-in(전체 P3 수용 시험이 아님):

    RUN_REAL_POSTGRES=1 npm test -- src/server/migration/localMultiAddedProductStage.postgres.test.ts --maxWorkers=1

- 위 PG 시험은 disposablePostgres/Docker를 사용하므로 VERIFICATION-ENV.md 사전조건, 무자격증명/외부 송신 차단/소유 자원/cleanup을 먼저 확인해야 한다. 여기서는 실행하지 않았다.
- pglite.ts의 기본 MIGRATIONS는 0008까지다(:17-26). 새 DDL의 실제 적용이 없는 harness 통과는 이 경로의 증거가 아니다. Sol이 테스트용 명시 migration 로딩/권한을 통합해야 한다. 다른 담당 소유 helper를 이 작업에서 수정하지 않았다.
- 새 full-generation 시험 파일/명령은 DDL 계약 확정 후 작성한다. 존재하지 않는 시험명이나 가상 실행 결과를 인계하지 않는다.
- 이후 Sol이 전체 Vitest→비증분 tsc→lint→build 및 독립 격리 PG를 직렬 실행하고 EVIDENCE-CONTRACT 필드를 실제 출력으로 채운다. NOT_RUN은 SKIP/PASS가 아니다.

## 닫히지 않은 단일 수용 경로

실제 fleet-wide writer 배제 및 대상별 승인 → 배제가 유지된 fresh Sheets+Redis 최종 취득 → 저장된 원본 snapshot/fingerprint에 묶인 전체 generation 적재(모든 변경·claims·tombstone) → 같은 generation persisted readback/독립 전량 대조 → 정지/멱등 retry와 복구 게이트 → 보호된 운영 projection/게시/단일 ACTIVE 전환.

이번에는 DDL 저장 계약에서 정지했다. 인계 파일 작성/소스 조회를 구현 완료나 수용 진척으로 집계하지 않는다. Sol의 독점 DDL 통합 전에는 실제 final import를 NOT_IMPLEMENTED, 외부 writer exclusion 및 활성화 안전성을 NOT_PROVEN으로 유지한다. Task19 수용은 0/8이다.
