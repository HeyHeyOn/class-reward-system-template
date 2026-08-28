# Google Sheets 템플릿 만들기

스프레드시트 하나를 만들고 아래 시트를 생성합니다.

## 1. Students

`templates/students.csv` 내용을 가져오기/붙여넣기 합니다.

필수 컬럼:

- `studentId`: QR 코드 값과 동일한 학생 고유 ID
- `name`: 학생 이름
- `balance`: 현재 잔액
- `status`: `ACTIVE` 또는 `INACTIVE`

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

## 5. Tasks

새로 만드는 시트는 아래 34개 canonical 헤더를 순서대로 사용합니다.

```csv
taskId,title,description,reward,isActive,sortOrder,createdAt,updatedAt,allowedStudentIds,taskInstanceId,ruleVersion,scheduleEffectiveFrom,recurrenceTimeZone,recurrenceType,recurrenceTime,recurrenceWeekday,recurrenceDayOfMonth,resetCompletionOnCycle,resetAssignmentOnCycle,pendingRuleVersion,pendingEffectiveFrom,pendingTimeZone,pendingRecurrenceType,pendingRecurrenceTime,pendingRecurrenceWeekday,pendingRecurrenceDayOfMonth,pendingResetCompletionOnCycle,pendingResetAssignmentOnCycle,availableFrom,dueAt,prerequisiteTaskId,recurrenceWeekdays,pendingRecurrenceWeekdays,padletBoardId
```

- `availableFrom`/`dueAt`은 ISO instant이며 시작 포함·마감 제외 기간을 뜻합니다.
- `prerequisiteTaskId`는 먼저 완료할 활성 과제 하나를 지정합니다.
- `recurrenceWeekdays`/`pendingRecurrenceWeekdays`는 `1,4`처럼 복수 ISO 요일을 저장합니다.
- `padletBoardId`는 선택적인 공식 Padlet 보드 ID(16~22자 영숫자)입니다.
- 기존 시트를 직접 재작성하지 않습니다. 앱의 명시적 과제 mutation이 누락된 새 열을 끝에 append하며 기존 열·행·알 수 없는 사용자 열을 보존합니다.
- 레거시 `recurrenceWeekday`/`pendingRecurrenceWeekday`는 단일 요일 fallback으로 읽습니다. 복수 요일 저장 시 레거시 단일값 셀은 비웁니다.

## 6. TaskCompletions

Padlet 증거와 BANK 작업 멱등성 열을 기존 canonical 열 뒤에 추가합니다.

```csv
completionId,timestamp,taskId,studentId,studentName,reward,balanceBefore,balanceAfter,status,note,taskInstanceId,cycleId,cycleStartsAt,cycleEndsAt,ruleVersion,timeZone,source,assignmentId,schemaVersion,operationId,operationPayloadHash,evidenceProvider,evidenceBoardId,evidencePostId,evidenceCreatedAt,evidenceAuthorFullName
```

`evidenceProvider`부터 `evidenceAuthorFullName`까지는 모두 비어 있거나 모두 유효해야 합니다. 기존·알 수 없는 후행 열은 삭제하거나 순서를 바꾸지 않습니다.

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
