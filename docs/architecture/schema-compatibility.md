# 스키마 호환성 정책

이 문서는 신규 생성 스키마, 일반 런타임 접근 범위, 레거시 데이터 호환 정책을 분리해 정의합니다.

금전 작업의 다단계 쓰기 순서, 부분 실패 위험, idempotency 및 향후 outbox 목표는 [금전 작업 신뢰성 계약](./money-operation-contracts.md)을 참고합니다. 두 문서의 범위는 다음처럼 구분합니다.

- 이 문서는 시트/컬럼의 생성, 접근 범위, 레거시 데이터 보존과 마이그레이션 호환성을 정합니다.
- 신뢰성 계약은 여러 시트에 걸친 효과의 순서, operation 수명주기, 재시도·동시성·감사 완결성을 정합니다.
- R1에는 신뢰성 계약의 operation/outbox 저장소나 관련 신규 스키마가 없습니다. 향후 이를 추가하려면 이 문서의 비파괴 호환 원칙과 별도 스키마/API 마이그레이션 검토를 함께 충족해야 합니다.

## 스키마 범위

- **신규 생성 스키마(`GeneratedSheetName`)**: `Students`, `Products`, `Transactions`, `Adjustments`, `Settings`, `Tasks`, `TaskAssignments`, `TaskCompletions`, `Recovery`의 9개 시트입니다.
- **일반 운영 스키마(`OperationalSheetName`)**: 위 목록에서 `Recovery`를 제외한 8개 시트입니다. 기존 `SheetName` 타입 alias는 이 운영 범위를 뜻합니다.
- generator와 doctor는 생성 스키마의 시트 존재 여부와 canonical 헤더를 검사할 수 있습니다. 일반 운영 repository와 API route에는 `Recovery` 접근을 허용하지 않습니다.

신규 생성 스키마 버전은 `2`이며 Settings의 `classTimeZone` 기본값은 `Asia/Seoul`입니다. Google Sheets 생성 요청은 9개 시트 각각에 canonical 헤더 길이 이상의 명시적 `gridProperties.columnCount`를 설정합니다.

## Recurring task ledger (schema v2)

- `Tasks`는 기존 9개 컬럼 뒤에 현재/예약 recurrence rule 컬럼 19개를 더한 28개 canonical 컬럼을 사용합니다.
- `TaskAssignments`는 cycle별 학생 배정을 보존하는 15개 컬럼의 append-only 원장입니다.
- `TaskCompletions`는 기존 10개 컬럼을 그대로 앞에 유지하고 cycle/rule/assignment 스냅샷 컬럼 9개를 뒤에 추가합니다.
- 현재 cycle의 해석은 `taskInstanceId`, `cycleId`, `ruleVersion`, `timeZone` 스냅샷을 기준으로 합니다. schedule·학급 시간대 변경은 현재 시각부터 더 높은 rule version으로 즉시 적용되며, 직전 배정·완료 상태는 보상 없이 새 cycle로 승계됩니다. 이미 기록된 과거 cycle 원장은 소급 변경하지 않습니다.
- 신규 `Tasks`에는 `maxCompletionsPerStudent`를 생성하지 않습니다. 레거시 인스턴스에서는 아래 비파괴 호환 원칙을 유지합니다.

## Recovery

- `Recovery`는 신규 스프레드시트 생성 시 반드시 생성합니다.
- canonical 헤더는 `key | value`입니다.
- `recoveryCode`는 `value` 셀에 **평문**으로 저장됩니다. 따라서 스프레드시트 전체 열람 권한을 관리자 전용으로 제한해야 합니다.
- 일반 운영 repository 및 API route는 `Recovery`를 읽거나 쓰면 안 됩니다.
- doctor의 machine-readable 계약은 각 시트에 1행으로 제한된 A1 범위(예: `Recovery!1:1`)를 지정하며, `Recovery`는 존재와 헤더만 검사하고 데이터 셀은 읽지 않습니다.
- 현재 generator doctor는 Google Sheets 실행기가 아니라 `GeneratorPlan`/manifest 생성기입니다. 따라서 이 단계의 테스트는 실제 client 호출을 흉내 내지 않고, 향후 조회기가 그대로 사용해야 하는 header-only 범위가 plan/manifest에 보존되는지를 검증합니다.
- recovery code 또는 Recovery 데이터 값은 로그, 진단 결과, 오류 메시지에 출력하면 안 됩니다.
- 보호된 탭은 열람 비밀 경계가 아닙니다. `Recovery` 평문을 보호하려면 스프레드시트 전체 열람 권한을 관리자 전용으로 제한해야 합니다.

## Adjustments

- `Adjustments`는 **legacy/reserved** 시트입니다.
- R1 런타임은 `Adjustments`를 읽거나 쓰지 않습니다.
- 과거 템플릿과의 비파괴 호환을 위해 신규 생성 9개 목록에서는 제거하지 않습니다.
- 현재 관리자 잔액 조정의 canonical 원장은 `Transactions`이며 `status=ADMIN_ADJUSTMENT`로 기록합니다.
- 별도의 `Adjustments` 행으로 이중 기록하지 않습니다.

## Tasks.maxCompletionsPerStudent

- 신규 `Tasks` 스키마에는 `maxCompletionsPerStudent` 컬럼을 만들지 않습니다.
- 기존 스프레드시트에 이 컬럼이 있더라도 삭제하거나 이름을 바꾸지 않습니다.
- 런타임이 기존 과제를 읽을 때 이 값은 무시합니다.
- 레거시 헤더를 유지한 채 과제 행을 append할 때 해당 셀에는 호환 값 `1`을 기록합니다.
- 완료 규칙은 설정값이 아니라 과제 **instance당 학생별 성공 완료 1회**입니다. 과제를 재생성해 새 instance가 된 경우에만 별개의 완료 기회로 취급합니다.

## 기존 시트와 하위 호환 원칙

- 시트나 컬럼의 삭제·덮어쓰기·이름 변경 같은 파괴적 자동 마이그레이션은 수행하지 않습니다.
- 일반 GET/query는 migration을 호출하지 않으며 write-free입니다. schedule·시간대·배정·완료 mutation 직전의 명시적 additive migrator만 `Tasks`/`TaskCompletions` 뒤에 누락 canonical 컬럼을 추가하고, 누락된 `TaskAssignments`를 canonical header로 race-safe하게 생성합니다.
- 런타임은 필요한 canonical 컬럼을 이름으로 찾고, 알 수 없는 추가 레거시 컬럼은 가능한 한 보존하고 무시합니다.
- 신규 생성 계약의 변경이 기존 인스턴스의 즉시 전면 재작성을 의미하지 않습니다. canonical 스키마로 전면 재작성하는 작업은 명시적인 검토, 백업, 사용자 동의가 있는 별도 절차로만 수행합니다.
- 호환을 위해 남겨 둔 시트나 컬럼이 현재 런타임 기능에서 사용된다는 의미는 아닙니다.

## R1 compatibility verification matrix

| 계약 | 검증 |
| --- | --- |
| 신규 schema·canonical header·9개 시트 | `src/generator/config/schema.test.ts`, `src/generator/createSpreadsheet.test.ts`, `src/server/sheetsRows.test.ts` |
| legacy schema·누락 `TaskAssignments`·unknown trailing columns·first-create/header race | `src/server/repositories/sheets/recurringSchemaMigrator.test.ts`, `src/server/sheetsRepository.test.ts` |
| `NONE`/`DAILY`/`WEEKLY`/`MONTHLY`, 서울·DST·월말, 변경 직전·정각·직후 | `src/domain/taskRecurrence.test.ts`, `src/domain/taskSchedule.test.ts` |
| schedule/timezone 즉시 변경·무보상 carry·reset flag 조합 | `src/domain/taskCycleState.test.ts`, `src/server/repositories/sheets/taskScheduleCommands.test.ts` |
| legacy `allowedStudentIds`·cycle 없는 completion·다음 자연 cycle | `src/domain/taskCycleState.test.ts`, `src/server/repositories/sheets/taskAssignmentCommands.test.ts`, `src/server/repositories/sheets/taskCompletionCommands.test.ts` |
| 순차 중복·completion append 관찰/보상·canonical/mirror 실패 | `src/server/repositories/sheets/taskAssignmentCommands.test.ts`, `src/server/repositories/sheets/taskCompletionCommands.test.ts` |
| 같은 `taskId` 재생성·append-only reset/delete/history | `src/domain/taskCycleState.test.ts`, `src/server/repositories/sheets/taskHistoryQueries.test.ts`, `src/server/sheetsRepository.test.ts` |
| 관리자 dirty draft·이력·stale async, 은행 legacy DTO·stale fetch·targeted refresh | `src/components/AdminManagePage.test.tsx`, `src/components/BankApp.test.tsx` |
| 학생 공개 DTO 최소화·raw projection 관리자 인증 | `src/app/api/tasks/route.test.ts` |

## R1 recurring task compatibility contract

- `NONE`, `DAILY`, `WEEKLY`, `MONTHLY`를 지원하며 월 29~31일이 없는 달은 그 달 말일로 당깁니다. cycle 계산은 named timezone과 DST 전환을 포함해 Temporal 기반으로 수행합니다.
- 레거시 `allowedStudentIds`는 assignment 원장이 없을 때 초기 배정 fallback으로 읽습니다. cycle 정보가 없는 기존 `SUCCESS` completion도 현재 task instance의 legacy 완료로 투영하되 새 행으로 다시 쓰지 않습니다.
- assignment와 completion은 물리적 append 순서의 최신 이벤트로 투영합니다. reset은 `RESET`, 삭제는 lifecycle snapshot 이벤트를 append하며 기존 성공·배정 행을 삭제하지 않습니다.
- 같은 `taskId`를 삭제 후 재생성해도 새 `taskInstanceId`가 이전 lifecycle의 배정·완료를 격리합니다. 삭제된 lifecycle의 이력은 원장 snapshot으로 조회할 수 있습니다.
- process-local command queue와 완료 append 결과 재조회는 같은 프로세스의 순차 중복·일반 재시도를 방어합니다. 여러 서버 instance의 강한 exactly-once와 서로 다른 operation 사이 학생 balance resource race는 R1 보장이 아닙니다.
- 학생용 `/api/tasks?studentId=...`는 요청 학생의 상태와 cycle metadata만 공개합니다. 전체 목록 projection, 단건 raw projection, `includeInactive` 관리 조회는 관리자 인증이 필요합니다.
