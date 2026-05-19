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

## 현재 구현된 읽기 API

관리자 설정에서 시트 ID를 저장하고 서비스 계정 환경변수를 설정하면 아래 API가 시트를 읽습니다.

```text
GET /api/students/S001
GET /api/products
```

필수 조건:

- `/admin/settings`에서 Google Sheets 주소 또는 시트 ID 저장
- `.env.local`에 `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY` 설정
- 해당 스프레드시트를 서비스 계정 이메일에 편집자 또는 뷰어 이상으로 공유
- 시트 이름과 헤더명을 문서와 동일하게 유지
