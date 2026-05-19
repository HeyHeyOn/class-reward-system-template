# Google Sheets 템플릿 만들기

스프레드시트 하나를 만들고 아래 시트를 생성합니다.

## 1. Students

`templates/students.csv` 내용을 가져오기/붙여넣기 합니다.

필수 컬럼:

- `studentId`: QR 코드 값과 동일한 학생 고유 ID
- `name`: 학생 이름
- `number`: 번호
- `balance`: 현재 잔액
- `qrValue`: QR에 넣을 값, 기본은 studentId와 동일
- `status`: `ACTIVE` 또는 `INACTIVE`
- `note`: 비고

## 2. Products

`templates/products.csv` 내용을 가져오기/붙여넣기 합니다.

필수 컬럼:

- `productId`: 상품 고유 ID
- `name`: 상품명
- `price`: 가격
- `stock`: 재고
- `isActive`: 판매 여부, `TRUE`/`FALSE`
- `imageUrl`: 상품 이미지 URL, 선택
- `category`: 카테고리
- `sortOrder`: 표시 순서

## 3. Transactions

첫 행에 아래 헤더를 넣습니다.

```csv
transactionId,timestamp,studentId,studentName,itemsJson,totalAmount,balanceBefore,balanceAfter,status,operator
```

## 4. Adjustments

첫 행에 아래 헤더를 넣습니다.

```csv
adjustmentId,timestamp,studentId,amount,reason,balanceBefore,balanceAfter,operator
```

## 운영 규칙

- QR 코드에는 이름/잔액을 넣지 말고 `S001` 같은 학생ID만 넣습니다.
- 앱은 이름이 아니라 `studentId` 기준으로 결제합니다.
- 서비스 계정 방식을 쓸 경우 스프레드시트를 서비스 계정 이메일에 편집자로 공유해야 합니다.
