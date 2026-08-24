# 스키마 호환성 정책

이 문서는 신규 생성 스키마, 일반 런타임 접근 범위, 레거시 데이터 호환 정책을 분리해 정의합니다.

## 스키마 범위

- **신규 생성 스키마(`GeneratedSheetName`)**: `Students`, `Products`, `Transactions`, `Adjustments`, `Settings`, `Tasks`, `TaskCompletions`, `Recovery`의 8개 시트입니다.
- **일반 운영 스키마(`OperationalSheetName`)**: 위 목록에서 `Recovery`를 제외한 7개 시트입니다. Task 3의 저장소 타입 이동 전까지 기존 `SheetName` 타입 alias는 이 운영 범위를 뜻합니다.
- generator와 doctor는 생성 스키마의 시트 존재 여부와 canonical 헤더를 검사할 수 있습니다. 일반 운영 repository와 API route에는 `Recovery` 접근을 허용하지 않습니다.

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
- R0 런타임은 `Adjustments`를 읽거나 쓰지 않습니다.
- 과거 템플릿과의 비파괴 호환을 위해 신규 생성 8개 목록에서는 제거하지 않습니다.
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
- 런타임 호환에 필요한 누락 시트 또는 헤더(예: `Tasks`, `TaskCompletions`)는 기존 데이터와 기존 컬럼을 보존한 채 append될 수 있습니다.
- 런타임은 필요한 canonical 컬럼을 이름으로 찾고, 알 수 없는 추가 레거시 컬럼은 가능한 한 보존하고 무시합니다.
- 신규 생성 계약의 변경이 기존 인스턴스의 즉시 전면 재작성을 의미하지 않습니다. canonical 스키마로 전면 재작성하는 작업은 명시적인 검토, 백업, 사용자 동의가 있는 별도 절차로만 수행합니다.
- 호환을 위해 남겨 둔 시트나 컬럼이 현재 런타임 기능에서 사용된다는 의미는 아닙니다.
