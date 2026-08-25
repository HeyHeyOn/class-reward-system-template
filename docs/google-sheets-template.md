# Google Sheets 템플릿

학급 보상 시스템 생성기는 신규 스프레드시트에 아래 **9개 시트**를 순서대로 만듭니다. 시트 이름과 헤더 이름은 대소문자를 포함해 그대로 사용해야 합니다.

1. `Students`
2. `Products`
3. `Transactions`
4. `Adjustments`
5. `Settings`
6. `Tasks`
7. `TaskAssignments`
8. `TaskCompletions`
9. `Recovery`

## Students

학생의 현재 잔액과 운영 상태를 저장합니다.

```text
studentId | name | balance | status
```

- `studentId`: 학생 고유 ID
- `name`: 표시 이름
- `balance`: 현재 잔액
- `status`: `ACTIVE` 또는 `INACTIVE`

## Products

매점 상품, 가격, 재고 및 노출 순서를 저장합니다.

```text
productId | name | price | stock | isActive | imageUrl | category | sortOrder
```

- `productId`: 상품 고유 ID
- `name`: 상품명
- `price`: 단가
- `stock`: 현재 재고
- `isActive`: 판매 활성 여부
- `imageUrl`: 상품 이미지 URL
- `category`: 상품 분류
- `sortOrder`: 표시 순서

## Transactions

구매와 관리자 조정을 포함한 잔액 변경 원장입니다.

```text
transactionId | timestamp | studentId | studentName | items | totalAmount | balanceBefore | balanceAfter | status | operator
```

- `transactionId`: 거래 고유 ID
- `timestamp`: 거래 시각(ISO 8601)
- `studentId`, `studentName`: 거래 대상 학생
- `items`: 거래 품목의 JSON 배열
- `totalAmount`: 거래 총액
- `balanceBefore`, `balanceAfter`: 거래 전후 잔액
- `status`: 거래 상태. 관리자 조정 원장은 `ADMIN_ADJUSTMENT`를 사용합니다.
- `operator`: 거래 수행자

`items`는 선택 컬럼이 아니라 **필수 원장 필드**입니다. 구매 거래는 다음과 같이 품목별 스냅샷을 기록합니다.

```json
[{"productId":"P001","name":"연필","price":300,"quantity":2,"subtotal":600}]
```

## Adjustments

과거 템플릿과의 비파괴 호환을 위해 유지하는 legacy/reserved 시트입니다. R1 런타임은 이 시트를 읽거나 쓰지 않으며, 현재 관리자 잔액 조정은 `Transactions`에 `status=ADMIN_ADJUSTMENT`로 기록합니다.

```text
adjustmentId | timestamp | studentId | amount | mode | operator
```

## Settings

인스턴스 설정과 스키마/시스템 버전을 key/value 행으로 저장합니다.

```text
key | value
```

신규 생성 시 포함되는 핵심 버전 값:

```text
schemaVersion | 2
systemVersion | 0.4.0-phase3
```

그 밖에 `systemName`, `appTitle`, `bankTitle`, `currencyUnit`, `classTimeZone`, `themeColor`, `qrManualInputEnabled` 등의 설정을 저장합니다. 신규 인스턴스의 `classTimeZone` 기본값은 `Asia/Seoul`입니다. `schemaVersion`은 시트 구조 호환성, `systemVersion`은 생성된 시스템 릴리스를 식별합니다.

## Tasks

과제 정의와 versioned recurrence rule을 저장합니다. `current`/`pending`은 저장 형식이며, 관리자 schedule·학급 시간대 변경으로 만든 `pending`은 변경 시각부터 즉시 유효합니다.

```text
taskId | title | description | reward | isActive | sortOrder | createdAt | updatedAt | allowedStudentIds | taskInstanceId | ruleVersion | scheduleEffectiveFrom | recurrenceTimeZone | recurrenceType | recurrenceTime | recurrenceWeekday | recurrenceDayOfMonth | resetCompletionOnCycle | resetAssignmentOnCycle | pendingRuleVersion | pendingEffectiveFrom | pendingTimeZone | pendingRecurrenceType | pendingRecurrenceTime | pendingRecurrenceWeekday | pendingRecurrenceDayOfMonth | pendingResetCompletionOnCycle | pendingResetAssignmentOnCycle
```

- `taskId`: 과제 고유 ID
- `title`, `description`: 제목과 설명
- `reward`: 성공 완료 보상
- `isActive`: 활성 여부
- `sortOrder`: 표시 순서
- `createdAt`, `updatedAt`: 생성/수정 시각
- `allowedStudentIds`: 참여 가능한 학생 ID 목록
- `taskInstanceId`, `ruleVersion`, `scheduleEffectiveFrom`: 과제 instance와 현재 스케줄 규칙 버전/적용 시점
- `recurrenceTimeZone`, `recurrenceType`, `recurrenceTime`, `recurrenceWeekday`, `recurrenceDayOfMonth`: 현재 반복 일정
- `resetCompletionOnCycle`, `resetAssignmentOnCycle`: cycle 전환 시 상태 초기화 정책
- `pending*`: `pendingEffectiveFrom`부터 해석되는 다음 규칙 버전. 관리자 변경은 현재 시각을 적용 시점으로 기록해 즉시 새 회차를 시작하며, 기존 미래 pending이 있으면 더 높은 버전으로 대체합니다.

신규 템플릿에는 레거시 컬럼 `maxCompletionsPerStudent`를 만들지 않습니다. 자세한 호환 정책은 [스키마 호환성 정책](architecture/schema-compatibility.md)을 참고하세요.

## TaskAssignments

반복 과제의 cycle별 학생 배정 원장을 저장합니다.

```text
assignmentId | taskId | taskInstanceId | cycleId | cycleStartsAt | cycleEndsAt | ruleVersion | timeZone | studentId | status | source | previousAssignmentId | createdAt | schemaVersion | note
```

- `assignmentId`: 배정 원장 고유 ID
- `taskId`, `taskInstanceId`, `cycleId`: 과제와 cycle 식별 정보
- `cycleStartsAt`, `cycleEndsAt`, `ruleVersion`, `timeZone`: 배정 당시의 cycle/rule 스냅샷
- `studentId`, `status`, `source`: 대상 학생, 배정 상태, 생성 출처
- `status`: `ASSIGNED`, `UNASSIGNED` 중 하나
- `source`: `ADMIN`, `QR`, `LEGACY_SEED`, `CARRY_FORWARD` 중 하나
- `previousAssignmentId`: 이전 cycle 배정과의 연결
- `createdAt`, `schemaVersion`, `note`: 감사 및 호환 메타데이터

## TaskCompletions

과제 완료 및 보상 반영 결과를 기록합니다.

```text
completionId | timestamp | taskId | studentId | studentName | reward | balanceBefore | balanceAfter | status | note | taskInstanceId | cycleId | cycleStartsAt | cycleEndsAt | ruleVersion | timeZone | source | assignmentId | schemaVersion
```

- `completionId`: 완료 기록 고유 ID
- `timestamp`: 처리 시각
- `taskId`, `studentId`, `studentName`: 과제와 학생 식별 정보
- `reward`: 지급 보상
- `balanceBefore`, `balanceAfter`: 지급 전후 잔액
- `status`: 완료 처리 상태
- `note`: 운영 메모
- `taskInstanceId`, `cycleId`, `cycleStartsAt`, `cycleEndsAt`, `ruleVersion`, `timeZone`: 완료 당시의 과제 cycle/rule 스냅샷
- `source`, `assignmentId`, `schemaVersion`: 완료 출처, 연결된 배정, 기록 스키마 버전
- `source`: `BANK`, `ADMIN`, `CARRY_FORWARD`, `ADMIN_RESET` 중 하나

동일한 과제 instance의 **같은 cycle**에서 학생별 보상 성공 완료는 한 번만 인정합니다. 다음 자연 cycle은 다시 완료할 수 있으며, 관리자 완료 표시는 잔액 보상 없이 별도 원장 이벤트로 기록됩니다.

## Recovery

관리자 복구 메타데이터를 key/value 행으로 저장하는 **신규 생성 필수 보안 시트**입니다.

```text
key | value
```

`recoveryCode` 값은 평문으로 저장됩니다. 보호된 탭은 열람 비밀 경계가 아니므로 **스프레드시트 전체 열람 권한을 관리자 전용으로 제한**해야 합니다. 학생 또는 외부인에게 공유하거나 코드 값을 로그, 오류 메시지, doctor 결과에 출력하면 안 됩니다. 일반 운영 저장소와 API route는 `Recovery`를 읽거나 쓰지 않습니다.

## 권한 및 호환성

- Google API로 접근하는 계정에는 필요한 범위의 스프레드시트 권한을 부여합니다.
- `Recovery`를 포함한 스프레드시트 전체 열람 권한을 관리자 전용으로 제한합니다.
- 기존 시트나 컬럼을 삭제·덮어쓰기·이름 변경하는 파괴적 자동 마이그레이션은 수행하지 않습니다.
- 일반 GET/query는 schema를 쓰지 않습니다. 반복 과제의 schedule·시간대·배정·완료 mutation 직전에는 additive migrator가 `Tasks`/`TaskCompletions`의 누락 canonical 컬럼을 뒤에 추가하고, 누락된 `TaskAssignments`를 race-safe하게 생성합니다. 기존 행과 알 수 없는 trailing column은 보존합니다.
- canonical 스키마로 전면 재작성하는 작업은 사용자 동의와 백업이 있는 별도 절차로만 수행합니다.
- 레거시 컬럼과 시트의 상세 원칙은 [스키마 호환성 정책](architecture/schema-compatibility.md)을 따릅니다.
