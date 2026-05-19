# Google Sheets 템플릿

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
