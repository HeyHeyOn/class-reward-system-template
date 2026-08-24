# Google Sheets 템플릿

학급 보상 시스템 생성기는 신규 스프레드시트에 아래 **8개 시트**를 순서대로 만듭니다. 시트 이름과 헤더 이름은 대소문자를 포함해 그대로 사용해야 합니다.

1. `Students`
2. `Products`
3. `Transactions`
4. `Adjustments`
5. `Settings`
6. `Tasks`
7. `TaskCompletions`
8. `Recovery`

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

과거 템플릿과의 비파괴 호환을 위해 유지하는 legacy/reserved 시트입니다. R0 런타임은 이 시트를 읽거나 쓰지 않으며, 현재 관리자 잔액 조정은 `Transactions`에 `status=ADMIN_ADJUSTMENT`로 기록합니다.

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
schemaVersion | 1
systemVersion | 0.4.0-phase3
```

그 밖에 `systemName`, `appTitle`, `bankTitle`, `currencyUnit`, `themeColor`, `qrManualInputEnabled` 등의 설정을 저장합니다. `schemaVersion`은 시트 구조 호환성, `systemVersion`은 생성된 시스템 릴리스를 식별합니다.

## Tasks

과제 정의와 대상 학생을 저장합니다.

```text
taskId | title | description | reward | isActive | sortOrder | createdAt | updatedAt | allowedStudentIds
```

- `taskId`: 과제 고유 ID
- `title`, `description`: 제목과 설명
- `reward`: 성공 완료 보상
- `isActive`: 활성 여부
- `sortOrder`: 표시 순서
- `createdAt`, `updatedAt`: 생성/수정 시각
- `allowedStudentIds`: 참여 가능한 학생 ID 목록

신규 템플릿에는 레거시 컬럼 `maxCompletionsPerStudent`를 만들지 않습니다. 자세한 호환 정책은 [스키마 호환성 정책](architecture/schema-compatibility.md)을 참고하세요.

## TaskCompletions

과제 완료 및 보상 반영 결과를 기록합니다.

```text
completionId | timestamp | taskId | studentId | studentName | reward | balanceBefore | balanceAfter | status | note
```

- `completionId`: 완료 기록 고유 ID
- `timestamp`: 처리 시각
- `taskId`, `studentId`, `studentName`: 과제와 학생 식별 정보
- `reward`: 지급 보상
- `balanceBefore`, `balanceAfter`: 지급 전후 잔액
- `status`: 완료 처리 상태
- `note`: 운영 메모

동일한 과제 instance에서 학생별 성공 완료는 한 번만 인정합니다.

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
- 런타임 호환에 필요한 누락 시트 또는 헤더(예: `Tasks`, `TaskCompletions`)는 기존 데이터와 컬럼을 보존한 채 append될 수 있습니다.
- canonical 스키마로 전면 재작성하는 작업은 사용자 동의와 백업이 있는 별도 절차로만 수행합니다.
- 레거시 컬럼과 시트의 상세 원칙은 [스키마 호환성 정책](architecture/schema-compatibility.md)을 따릅니다.
