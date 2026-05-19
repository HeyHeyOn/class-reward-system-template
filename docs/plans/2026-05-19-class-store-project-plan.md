# 학급 매점 프로젝트 기획서 및 구현 계획

> **For Hermes:** 구현 단계에서는 `subagent-driven-development` 또는 직접 TDD 방식으로 작업한다. Google Sheets 수정/생성, 배포, 인증 설정 등 외부 변경 작업은 관리자님 승인 후 진행한다.

**작성일:** 2026-05-19  
**프로젝트명:** 학급 매점  
**목표:** 초등학교 학급에서 학급 화폐를 기반으로 운영하는 매점/키오스크 웹 앱을 만든다.

**핵심 아이디어:**  
학생 QR 코드를 스캔하면 학생의 학급 화폐 잔액을 불러오고, 매점 상품을 장바구니에 담아 결제하면 Google Sheets에 잔액, 재고, 거래 기록을 실시간 반영한다.

---

## 1. 프로젝트 개요

### 1.1 문제 정의

학급에서 학급 화폐를 운영할 때 다음 문제가 생긴다.

- 학생별 잔액을 수기로 관리하기 번거롭다.
- 매점 구매 내역이 누락되거나 계산 실수가 발생할 수 있다.
- 상품 가격/재고 관리가 분산되기 쉽다.
- 학생들이 직접 확인 가능한 키오스크 경험을 제공하기 어렵다.

### 1.2 해결 방향

웹 앱을 키오스크처럼 구성하고, Google Sheets를 간이 데이터베이스 겸 장부로 사용한다.

- 학생 정보와 잔액: Google Sheets
- 상품 정보와 가격/재고: Google Sheets
- 거래 내역: Google Sheets 로그
- 화면: 태블릿/PC용 웹 키오스크 UI
- 학생 식별: QR 코드

### 1.3 주요 사용자

- **교사/관리자:** 학생 잔액, 상품, 거래 내역을 관리한다.
- **학생:** QR 코드를 스캔하고 상품을 선택해 학급 화폐로 구매한다.
- **운영 도우미:** 매점 운영 시 결제를 보조한다.

---

## 2. 핵심 기능

### 2.1 학생 QR 인식

- 웹캠/태블릿 카메라로 QR 코드 인식
- QR 값은 학생ID만 담는다. 예: `S001`
- 학생ID로 Google Sheets의 학생 정보를 조회한다.
- 이름, 번호, 현재 잔액, 상태를 화면에 표시한다.

### 2.2 학급 화폐 잔액 관리

- 학생별 현재 잔액 조회
- 결제 시 총액만큼 차감
- 잔액 부족 시 결제 차단
- 모든 잔액 변경은 거래 로그에 기록

### 2.3 매점 품목 관리

- 상품명, 가격, 재고, 판매 여부, 이미지 URL 관리
- 판매 여부가 `TRUE`인 상품만 키오스크에 표시
- 재고가 0이면 품절 표시 또는 선택 차단

### 2.4 장바구니

- 상품 선택 시 장바구니 추가
- 수량 증감
- 상품 삭제
- 총액 계산
- 현재 잔액 대비 결제 가능 여부 표시

### 2.5 결제

- 결제 전 서버에서 최신 잔액/상품 정보를 다시 조회
- 잔액 부족, 품절, 판매 중지 상품 여부 검증
- 학생 잔액 차감
- 상품 재고 차감
- 거래 로그 기록
- 완료 화면 표시

---

## 3. 추천 기술 스택

### 3.1 MVP 권장안

- **프레임워크:** Next.js
- **언어:** TypeScript
- **UI:** Tailwind CSS 또는 shadcn/ui
- **QR 인식:** `html5-qrcode` 또는 `@zxing/browser`
- **서버 API:** Next.js Route Handlers
- **데이터 연동:** Google Sheets API
- **배포:** Vercel 또는 로컬 PC 실행

### 3.2 구조

```text
Browser / Tablet Kiosk
  ↓
Next.js Frontend
  ↓
Next.js API Routes
  ↓
Google Sheets API
  ↓
Google Spreadsheet
```

웹 클라이언트가 Google API 키를 직접 들고 있으면 위험하므로, Google Sheets 접근은 반드시 서버 API에서 처리한다.

---

## 4. Google Sheets 설계

스프레드시트 하나 안에 최소 4개 시트를 둔다.

### 4.1 `Students` 시트

| 컬럼 | 예시 | 설명 |
|---|---|---|
| studentId | S001 | 고유 학생ID. QR 코드 값과 동일 |
| name | 김민준 | 학생 이름 |
| number | 1 | 번호 |
| balance | 3500 | 현재 학급 화폐 잔액 |
| qrValue | S001 | QR 코드에 들어가는 값 |
| status | ACTIVE | ACTIVE/INACTIVE |
| note |  | 비고 |

규칙:

- `studentId`는 절대 중복되면 안 된다.
- 결제는 이름이 아니라 `studentId` 기준으로 처리한다.
- 잔액은 숫자로만 저장한다.

### 4.2 `Products` 시트

| 컬럼 | 예시 | 설명 |
|---|---|---|
| productId | P001 | 고유 상품ID |
| name | 연필 | 상품명 |
| price | 300 | 가격 |
| stock | 20 | 재고 |
| isActive | TRUE | 판매 여부 |
| imageUrl |  | 상품 이미지 URL |
| category | 문구 | 카테고리 |
| sortOrder | 1 | 표시 순서 |

규칙:

- `productId`는 절대 중복되면 안 된다.
- `isActive=TRUE`이고 `stock>0`인 상품을 기본 판매 가능으로 본다.
- 재고를 쓰지 않는 상품이면 추후 `stock=-1` 같은 무제한 규칙을 둘 수 있으나 MVP에서는 재고 기반으로 간다.

### 4.3 `Transactions` 시트

| 컬럼 | 예시 | 설명 |
|---|---|---|
| transactionId | T202605190001 | 거래ID |
| timestamp | 2026-05-19T09:10:00+09:00 | 거래 시각 |
| studentId | S001 | 학생ID |
| studentName | 김민준 | 거래 당시 이름 |
| itemsJson | [{"productId":"P001","qty":1}] | 구매 품목 JSON |
| totalAmount | 800 | 총액 |
| balanceBefore | 3500 | 결제 전 잔액 |
| balanceAfter | 2700 | 결제 후 잔액 |
| status | COMPLETED | 거래 상태 |
| operator | kiosk | 처리자 |

규칙:

- 결제가 성공하면 반드시 한 줄 추가한다.
- 나중에 환불 기능을 추가할 경우 `REFUNDED` 또는 별도 `Refunds` 시트를 둔다.

### 4.4 `Adjustments` 시트

수동 충전/차감 기록용이다. MVP에서는 관리자 기능까지 만들지 않더라도 시트 구조는 미리 잡아두는 편이 좋다.

| 컬럼 | 예시 | 설명 |
|---|---|---|
| adjustmentId | A202605190001 | 조정ID |
| timestamp | 2026-05-19T09:00:00+09:00 | 조정 시각 |
| studentId | S001 | 학생ID |
| amount | 1000 | 증감액. 차감은 음수 |
| reason | 과제 보상 | 사유 |
| balanceBefore | 2500 | 조정 전 잔액 |
| balanceAfter | 3500 | 조정 후 잔액 |
| operator | teacher | 처리자 |

---

## 5. 화면 설계

### 5.1 대기 화면

목적: 학생이 QR 코드를 스캔하도록 유도한다.

구성:

- 큰 제목: “학급 매점”
- 안내 문구: “QR 코드를 카메라에 보여 주세요”
- 카메라 프리뷰
- 관리자 진입 버튼 또는 PIN 버튼

### 5.2 학생 확인 화면

목적: QR 인식 후 학생 정보를 확인한다.

구성:

- 학생 이름/번호
- 현재 잔액
- “상품 고르기” 버튼
- “다시 스캔” 버튼

예외:

- 학생ID 없음: “등록되지 않은 QR 코드입니다.”
- 비활성 학생: “현재 이용할 수 없는 학생입니다.”

### 5.3 상품 선택 화면

목적: 키오스크처럼 상품을 장바구니에 담는다.

구성:

- 상단: 학생 이름, 현재 잔액, 장바구니 총액
- 상품 카드 목록
  - 상품명
  - 가격
  - 재고
  - 이미지
  - 담기 버튼
- 우측/하단: 장바구니 영역

### 5.4 장바구니 화면

목적: 구매 목록과 결제 가능 여부를 확인한다.

구성:

- 상품명, 수량, 단가, 소계
- 수량 + / - 버튼
- 삭제 버튼
- 총액
- 결제 후 예상 잔액
- 결제 버튼

상태:

- 잔액 충분: 결제 버튼 활성화
- 잔액 부족: 결제 버튼 비활성화, 부족 금액 표시
- 재고 부족: 해당 상품 표시 및 결제 차단

### 5.5 결제 완료 화면

목적: 결제 결과를 명확하게 보여준다.

구성:

- “결제 완료!”
- 구매 총액
- 남은 잔액
- 3~5초 후 자동으로 대기 화면 복귀

### 5.6 관리자 화면 — 2차 기능

MVP 이후 추가한다.

- 학생 잔액 조회
- 학생별 거래 내역 조회
- 상품 목록 조회
- 오늘 매출/거래 건수
- QR 코드 출력 기능

---

## 6. API 설계

### 6.1 학생 조회

`GET /api/students/:studentId`

응답 예시:

```json
{
  "studentId": "S001",
  "name": "김민준",
  "number": 1,
  "balance": 3500,
  "status": "ACTIVE"
}
```

### 6.2 상품 목록 조회

`GET /api/products`

응답 예시:

```json
[
  {
    "productId": "P001",
    "name": "연필",
    "price": 300,
    "stock": 20,
    "isActive": true,
    "imageUrl": "",
    "category": "문구",
    "sortOrder": 1
  }
]
```

### 6.3 결제

`POST /api/checkout`

요청 예시:

```json
{
  "studentId": "S001",
  "items": [
    { "productId": "P001", "quantity": 1 },
    { "productId": "P002", "quantity": 2 }
  ]
}
```

처리 순서:

1. 학생 최신 정보 조회
2. 상품 최신 정보 조회
3. 상품 판매 가능 여부 확인
4. 재고 확인
5. 총액 계산
6. 잔액 확인
7. 학생 잔액 차감
8. 상품 재고 차감
9. 거래 로그 추가
10. 결과 반환

성공 응답:

```json
{
  "transactionId": "T202605190001",
  "studentId": "S001",
  "totalAmount": 800,
  "balanceBefore": 3500,
  "balanceAfter": 2700,
  "items": [
    { "productId": "P001", "name": "연필", "quantity": 1, "subtotal": 300 }
  ]
}
```

실패 응답 예시:

```json
{
  "error": "INSUFFICIENT_BALANCE",
  "message": "잔액이 부족합니다.",
  "currentBalance": 500,
  "requiredAmount": 800
}
```

---

## 7. 보안/운영 원칙

### 7.1 인증 정보 보호

- Google API 서비스 계정 키 또는 OAuth 토큰은 서버 환경변수/비공개 파일로만 보관한다.
- 클라이언트 번들에 인증키를 넣지 않는다.
- Git 저장소에 `.env`, 키 JSON 파일을 커밋하지 않는다.

### 7.2 권한

- MVP에서는 운영 기기만 접근한다는 전제하에 단순 PIN 정도로 시작 가능하다.
- 공개 배포 시에는 관리자 인증을 붙인다.
- 결제 API는 최소한 간단한 세션/PIN/토큰 보호가 필요하다.

### 7.3 데이터 무결성

- 거래 성공 시 반드시 로그 기록
- 이름이 아닌 ID 기준으로 처리
- 결제 직전 최신 잔액/재고 재조회
- 잔액 부족/재고 부족이면 절대 차감하지 않음

### 7.4 개인정보 최소화

- QR 코드에는 학생ID만 넣는다.
- QR에 이름, 잔액, 개인정보를 넣지 않는다.
- 화면에는 필요한 정보만 표시한다.

---

## 8. MVP 개발 단계표

### Phase 0: 프로젝트 초기화

목표: Next.js 프로젝트 뼈대를 만든다.

작업:

1. `class-store` 프로젝트 생성
2. TypeScript 설정
3. Tailwind CSS 설정
4. 기본 레이아웃 구성
5. 환경변수 샘플 파일 작성

완료 기준:

- 로컬에서 웹앱 실행 가능
- 첫 화면 표시

### Phase 1: Google Sheets 데이터 계층

목표: Sheets에서 학생/상품을 읽고 거래 로그를 쓸 수 있게 한다.

작업:

1. Google Sheets API 인증 방식 결정
2. `Students`, `Products`, `Transactions`, `Adjustments` 시트 생성
3. 학생 조회 함수 작성
4. 상품 목록 조회 함수 작성
5. 거래 로그 추가 함수 작성
6. 잔액/재고 업데이트 함수 작성

완료 기준:

- 테스트 데이터로 학생 조회 성공
- 상품 목록 조회 성공
- 거래 로그 추가 성공

### Phase 2: API 구현

목표: 프론트엔드가 사용할 서버 API를 만든다.

작업:

1. `GET /api/students/:studentId`
2. `GET /api/products`
3. `POST /api/checkout`
4. 결제 검증 로직
5. 오류 코드 정리

완료 기준:

- API만으로 학생 조회, 상품 조회, 결제 가능
- 잔액 부족/재고 부족 오류가 정상 반환됨

### Phase 3: 키오스크 UI 구현

목표: 실제 사용 가능한 화면 흐름을 만든다.

작업:

1. 대기 화면
2. QR 스캔 화면
3. 학생 확인 화면
4. 상품 선택 화면
5. 장바구니 화면
6. 결제 완료 화면
7. 자동 초기화

완료 기준:

- QR 스캔부터 결제 완료까지 한 흐름으로 동작

### Phase 4: 운영 안정화

목표: 실사용 중 오류를 줄인다.

작업:

1. 중복 결제 방지 버튼 잠금
2. 결제 중 로딩 상태
3. 네트워크 오류 처리
4. 결제 실패 메시지 개선
5. 거래 로그 확인
6. 기본 관리자 PIN 추가

완료 기준:

- 결제 버튼 연타 시 중복 결제되지 않음
- 오류 메시지가 학생/운영자가 이해하기 쉬움

### Phase 5: 배포/운영 문서

목표: 교실에서 실행 가능한 상태로 만든다.

작업:

1. 배포 방식 결정: Vercel 또는 로컬 실행
2. 환경변수 설정 문서 작성
3. 시트 초기 템플릿 작성
4. QR 코드 생성 가이드 작성
5. 교사용 운영 매뉴얼 작성

완료 기준:

- 다른 사람이 문서만 보고 실행 가능

---

## 9. 세부 구현 태스크 초안

### Task 1: 프로젝트 생성

**Objective:** Next.js 기반 프로젝트를 생성한다.

**Files:**

- Create: `package.json`
- Create: `app/page.tsx`
- Create: `app/layout.tsx`
- Create: `.env.example`

**Commands:**

```bash
npx create-next-app@latest class-store --typescript --tailwind --eslint --app
```

**Verification:**

```bash
npm run dev
```

브라우저에서 첫 화면이 보여야 한다.

### Task 2: 데이터 타입 정의

**Objective:** 학생, 상품, 장바구니, 거래 타입을 정의한다.

**Files:**

- Create: `src/types/domain.ts`

**Types:**

```ts
export type Student = {
  studentId: string;
  name: string;
  number: number;
  balance: number;
  status: 'ACTIVE' | 'INACTIVE';
};

export type Product = {
  productId: string;
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  imageUrl?: string;
  category?: string;
  sortOrder: number;
};

export type CartItem = {
  productId: string;
  quantity: number;
};

export type CheckoutResult = {
  transactionId: string;
  studentId: string;
  totalAmount: number;
  balanceBefore: number;
  balanceAfter: number;
};
```

### Task 3: Google Sheets 클라이언트 작성

**Objective:** 서버에서 Google Sheets API를 호출하는 클라이언트를 만든다.

**Files:**

- Create: `src/server/googleSheets.ts`

**Required env:**

```text
GOOGLE_SHEET_ID=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
```

또는 Hermes/로컬 환경에서는 OAuth 토큰 기반 테스트도 가능하지만, 웹앱 배포용은 서비스 계정 방식이 운영하기 쉽다.

### Task 4: 학생 조회 함수 작성

**Objective:** `Students` 시트에서 학생ID로 학생을 찾는다.

**Files:**

- Create/Modify: `src/server/studentsRepository.ts`

**Verification:**

- `S001` 조회 시 학생 객체 반환
- 없는 ID 조회 시 `null` 반환

### Task 5: 상품 조회 함수 작성

**Objective:** 판매 가능한 상품 목록을 반환한다.

**Files:**

- Create/Modify: `src/server/productsRepository.ts`

**Verification:**

- `isActive=TRUE` 상품만 반환
- 가격/재고 숫자 변환 정상 처리

### Task 6: 결제 서비스 작성

**Objective:** 잔액/재고 검증 후 결제를 처리한다.

**Files:**

- Create: `src/server/checkoutService.ts`

**Verification:**

- 잔액 충분: 잔액 차감, 재고 차감, 거래 로그 생성
- 잔액 부족: 차감 없이 오류
- 재고 부족: 차감 없이 오류
- 비활성 상품: 차감 없이 오류

### Task 7: API Route 작성

**Objective:** 프론트엔드에서 호출할 API를 만든다.

**Files:**

- Create: `app/api/students/[studentId]/route.ts`
- Create: `app/api/products/route.ts`
- Create: `app/api/checkout/route.ts`

**Verification:**

```bash
curl http://localhost:3000/api/products
curl http://localhost:3000/api/students/S001
```

### Task 8: QR 스캔 UI 작성

**Objective:** QR 코드를 인식해 학생ID를 얻는다.

**Files:**

- Create: `src/components/QrScanner.tsx`

**Library 후보:**

- `html5-qrcode`
- `@zxing/browser`

**Verification:**

- QR 코드 `S001` 인식 시 콜백으로 `S001` 전달

### Task 9: 키오스크 메인 플로우 작성

**Objective:** 대기 → 학생 확인 → 상품 선택 → 결제 완료 흐름을 구현한다.

**Files:**

- Modify: `app/page.tsx`
- Create: `src/components/KioskApp.tsx`
- Create: `src/components/StudentPanel.tsx`
- Create: `src/components/ProductGrid.tsx`
- Create: `src/components/CartPanel.tsx`
- Create: `src/components/CheckoutComplete.tsx`

**Verification:**

- 테스트 QR 값 입력/스캔 후 상품 선택과 결제 가능

### Task 10: 운영 안정화

**Objective:** 실사용 오류를 줄인다.

**Files:**

- Modify: `src/components/CartPanel.tsx`
- Modify: `src/server/checkoutService.ts`

**Implementation:**

- 결제 중 버튼 비활성화
- 중복 요청 방지
- 오류 메시지 한글화
- 결제 완료 후 자동 초기화

---

## 10. 테스트 전략

### 10.1 단위 테스트

대상:

- 총액 계산
- 잔액 부족 판단
- 재고 부족 판단
- 상품 데이터 파싱
- 학생 데이터 파싱

### 10.2 통합 테스트

대상:

- 학생 조회 API
- 상품 조회 API
- 결제 API

### 10.3 수동 테스트 시나리오

1. 정상 결제
   - 학생 `S001`, 잔액 3500
   - 상품 800원 구매
   - 결제 후 잔액 2700
   - 거래 로그 1줄 생성

2. 잔액 부족
   - 학생 잔액 500
   - 상품 800원 구매 시도
   - 결제 실패
   - 잔액/재고 변화 없음

3. 재고 부족
   - 상품 재고 0
   - 구매 시도
   - 결제 실패

4. 등록되지 않은 QR
   - `S999` 스캔
   - 학생 없음 메시지 표시

5. 결제 버튼 연타
   - 한 번만 결제 처리되어야 함

---

## 11. 초기 샘플 데이터

### Students

```csv
studentId,name,number,balance,qrValue,status,note
S001,김민준,1,3500,S001,ACTIVE,
S002,이서연,2,1200,S002,ACTIVE,
S003,박도윤,3,0,S003,ACTIVE,
```

### Products

```csv
productId,name,price,stock,isActive,imageUrl,category,sortOrder
P001,연필,300,20,TRUE,,문구,1
P002,지우개,500,15,TRUE,,문구,2
P003,스티커,700,10,TRUE,,꾸미기,3
P004,간식쿠폰,1000,5,TRUE,,쿠폰,4
```

---

## 12. 결정이 필요한 사항

구현 전에 관리자님이 정하면 좋은 것들이다.

1. **배포 방식**
   - 로컬 PC에서만 실행
   - Vercel 같은 웹 배포
   - 학급 태블릿 전용 접속

2. **Google 인증 방식**
   - 서비스 계정 방식: 배포용으로 안정적
   - OAuth 방식: 개인 계정 기반, 초기 테스트 쉬움

3. **상품 재고 사용 여부**
   - 실제 재고 차감 사용
   - 재고 없이 가격만 사용

4. **학생 QR 코드 발급 방식**
   - 앱에서 QR 코드 일괄 생성
   - 별도 도구로 생성 후 인쇄

5. **관리자 기능 범위**
   - MVP에서는 시트에서 직접 관리
   - 앱 안에 관리자 페이지 포함

---

## 13. 추천 MVP 확정안

관리자님이 바로 실사용 가능한 1차 버전을 원한다면 다음 범위로 시작하는 것을 추천한다.

### 포함

- Next.js 웹앱
- QR 스캔
- 학생 잔액 조회
- 상품 목록 조회
- 장바구니
- 결제
- 잔액 차감
- 재고 차감
- 거래 로그 기록
- Google Sheets 템플릿
- 간단한 관리자 PIN

### 제외 — 2차로 미루기

- 앱 내 상품 편집
- 앱 내 학생 등록
- 환불 기능
- 여러 반 지원
- 상세 통계 대시보드
- 학생별 소비 제한

이 범위가 가장 빠르게 완성 가능하고, 실제 교실 테스트에도 충분하다.

---

## 14. 다음 실행 순서

1. 프로젝트 폴더 초기화
2. Google Sheets 템플릿 생성
3. 테스트 학생/상품 데이터 입력
4. Next.js 프로젝트 생성
5. Sheets 읽기 기능 구현
6. 결제 API 구현
7. 키오스크 UI 구현
8. 실제 QR 코드로 테스트
9. 교실 운영용 문서 작성

---

## 15. 리스크와 대응

### 리스크 1: Google Sheets 동시 수정 충돌

- **가능성:** 낮음. 한 기기 운영이면 거의 없음.
- **대응:** 결제 직전 최신 데이터 재조회, 결제 중 버튼 잠금.

### 리스크 2: QR 카메라 권한 문제

- **가능성:** 중간.
- **대응:** HTTPS 배포 또는 localhost 실행. 카메라 권한 안내 화면 제공.

### 리스크 3: 인증키 노출

- **가능성:** 잘못 구현하면 높음.
- **대응:** Google API 호출은 서버에서만 수행. `.env`와 키 파일은 Git 제외.

### 리스크 4: 수기 시트 수정으로 데이터 깨짐

- **가능성:** 중간.
- **대응:** 컬럼명 고정, ID 중복 금지, 데이터 검증 규칙 추가.

---

## 16. 한 줄 결론

`학급 매점`은 Google Sheets를 은행 장부처럼 쓰고, Next.js 웹앱을 키오스크 UI로 구성하면 MVP부터 실사용 버전까지 무리 없이 구현 가능하다.
