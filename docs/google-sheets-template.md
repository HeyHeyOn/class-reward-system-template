# Google Sheets 템플릿

## 생성기의 최신 템플릿 계약

새로 생성하는 시트는 최신 운영 템플릿용 schemaVersion `4`, systemVersion `0.4.1`입니다.
정확한 헤더/순서는 `src/generator/config/schema.ts`의 `REQUIRED_SHEETS`를 기준으로 합니다.

- 11개 탭: Students, Products, Transactions, Adjustments, Settings, Tasks, TaskAssignments, TaskCompletions, Promotions, PromotionProducts, Recovery.
- Students는 `studentId, name, balance, status` 4개 헤더입니다.
- Tasks는 33개 헤더(A:AG)를 사용하며 생성 요청에 열 수를 명시합니다.
- Settings 기본값에는 `classTimeZone=Asia/Seoul`, `qrManualInputEnabled=FALSE`가 포함됩니다.
- Recovery의 첫 행은 `key, value`이며 실제 복구 안내/메타데이터 행 수만큼 씁니다. 복구 코드는 Recovery에만 보관하고 Settings에는 해시를 기록합니다.
- 이 변경은 **새 시트 생성 전용**입니다. 기존 시트의 데이터를 삭제하거나 재생성/마이그레이션하지 않습니다.
- 이 분리된 생성기 배포에 포함된 구형 운영 앱/API를 최신 시트의 운영 템플릿으로 사용하지 마세요. 실제 학급 앱은 최신 템플릿을 별도 배포합니다.

## 이전 수동 템플릿 참고

아래는 구형 운영 앱의 수동 구성 기록이며 최신 생성기의 헤더 정의가 아닙니다.

학급 매점 스프레드시트에는 아래 시트가 필요합니다.

## Students

필수 컬럼:

```text
studentId | name | number | balance | qrValue | status | note
```

예시:

```text
S001 | 김민준 | 1 | 3500 | S001 | ACTIVE |
```

## Products

필수 컬럼:

```text
productId | name | price | stock | isActive | imageUrl | category | sortOrder
```

예시:

```text
P001 | 연필 | 300 | 50 | TRUE | | 문구 | 1
```

## Transactions

필수 컬럼:

```text
transactionId | timestamp | studentId | studentName | totalAmount | balanceBefore | balanceAfter | status | operator
```

권장 선택 컬럼:

```text
items
```

`items` 예시:

```json
[{"productId":"P001","name":"연필","price":300,"quantity":2}]
```

`items`가 없어도 결제 내역 페이지는 거래 총액/잔액 중심으로 표시됩니다.

## Settings

필수 컬럼:

```text
key | value
```

권장 기본값:

```text
currencyUnit | 원
className | 3학년 2반
storeName | 학급 매점
```

현재 앱에서 사용하는 값:

- `currencyUnit`: 금액 뒤에 붙는 학급 화폐 단위

## 권한

서비스 계정 이메일을 이 스프레드시트에 **편집자**로 공유해야 합니다.
