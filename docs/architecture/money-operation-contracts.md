# 금전 작업 신뢰성 계약

이 문서는 학급 화폐 잔액, 상품 재고, `Transactions`, `TaskCompletions`를 함께 변경하는 작업의 신뢰성 경계를 정의합니다. 먼저 **현재 구현의 실제 동작과 위험**을 기록하고, 이어서 그중 **R0가 변경하지 않고 보존하는 범위**, 마지막으로 **향후 목표 계약**을 구분해 명시합니다.

> 중요: 아래의 idempotency operation record, outbox, checkpoint, lease 및 새 작업 유형은 설계 목표일 뿐입니다. R0에는 이를 위한 저장소·API·스키마가 구현되어 있지 않으며, 이 문서가 구현 완료를 뜻하지 않습니다.

## 1. 현재 구현: 코드 대조 결과

현재 Google Sheets 쓰기는 여러 호출로 나뉘며 트랜잭션, rollback, durable checkpoint 또는 요청 idempotency가 없다. 아래 내용은 현재 코드를 대조한 관찰 결과이며, R0가 보존하는 범위는 6절에서 별도로 선언한다.

### CHECKOUT

`processCheckout`의 쓰기 순서는 다음과 같다.

1. 학생 `balance` 차감
2. 장바구니의 상품별 `stock` 차감(각 상품을 순서대로 별도 갱신)
3. `Transactions`에 `COMPLETED` 행 append

중간 실패 시 구체적인 상태:

- 잔액 갱신 실패: 재고와 거래 행은 변경되지 않는다.
- n번째 재고 갱신 실패: 잔액은 이미 차감되었고 앞선 상품들의 재고도 이미 차감되었다. 실패한 상품과 뒤 상품은 변경되지 않으며 거래 행도 없다.
- 거래 append 실패: 잔액과 모든 대상 재고는 이미 차감되었지만 거래 원장이 없다. 호출은 실패한다.
- 응답 유실/HTTP 재시도: 현재 operation key가 없어 같은 결제가 다시 실행되어 잔액·재고가 중복 변경되고 별도 거래가 생길 수 있다.

현재 기본 거래 ID는 시각을 문자열로 만든 `T...` 값이다. 이는 중복 실행을 막는 키가 아니며 충돌 방지 계약도 아니다.

### TASK_REWARD

학생이 직접 과제를 완료하는 `completeTaskForStudent`의 쓰기 순서는 다음과 같다.

1. 학생 `balance`에 보상 반영
2. `TaskCompletions`에 `SUCCESS` 행 append
3. `Transactions`에 `TASK_REWARD` 행 append

중간 실패 시 구체적인 상태:

- 잔액 갱신 실패: 완료 행과 거래 행은 생기지 않는다.
- 완료 append 실패: 잔액은 이미 증가했지만 완료 행과 거래 행은 없다. 호출은 실패한다.
- 거래 append 실패: 잔액과 완료 행은 남는다. 이 실패는 현재 `.catch(() => undefined)`로 **무시하는 best effort**이므로 호출도 성공하며 `TASK_REWARD` 감사 원장만 누락된다.
- 응답 유실 뒤 재시도: 완료 행이 이미 보이면 현재 1회 완료 정책이 재지급을 대체로 차단하지만, 잔액 반영과 완료 append 사이에서 실패한 경우에는 완료 행이 없어 다시 보상이 지급될 수 있다. 이는 idempotency 보장이 아니다.

현재 `TASK_REWARD` 거래 ID `TASK-${completionId}`와 `completionId`의 `Date.now()`/난수 조합도 operation key가 아니다.

### CANCEL_TRANSACTION

현재 일반 거래 취소 `cancelTransaction`의 쓰기 순서는 다음과 같다.

1. 학생 `balance`를 원거래의 증감분만큼 역반영
2. 양수 금액의 구매 거래라면 대상 상품들의 `stock`을 한 묶음으로 복원 요청
3. 원거래 `status`를 `CANCELLED`로 갱신
4. `Transactions`에 `CANCEL_REVERSAL` 행 append

중간 실패 시 구체적인 상태:

- 잔액 갱신 실패: 재고, 원거래 상태, reversal 행은 변경되지 않는다.
- 재고 복원 실패: 잔액은 이미 역반영되었지만 원거래는 아직 취소 표시되지 않고 reversal 행도 없다. 현재 `GoogleSheetsStore`는 모든 대상 재고를 하나의 `spreadsheets.values.batchUpdate` 요청으로 보내므로 상품별 순차 호출로 기술하지 않는다. 다만 `TabularStore.updateCells` 인터페이스는 원자성을 계약하지 않고, 이를 제공하지 않는 저장소의 fallback은 셀별 순차 갱신이므로 저장소 구현에 따라 일부 재고만 복원될 가능성을 배제할 수 없다.
- 원거래 상태 갱신 실패: 잔액과 대상 재고는 이미 복원되었지만 원거래는 기존 상태이고 reversal 행은 없다.
- reversal append 실패: 잔액·재고는 복원되고 원거래는 `CANCELLED`이나 이를 설명할 reversal 원장이 없다. 호출은 실패한다.
- 동일 거래 재취소: 현재 원거래가 이미 `CANCELLED`이면 “이미 취소된 거래” 오류를 반환한다. 이전 성공 결과를 재반환하는 idempotency 계약은 아니다.

소득 거래(예: `TASK_REWARD`)는 재고 단계가 비어 있다. 현재는 역반영 결과가 음수가 되면 어떤 쓰기도 하기 전에 취소를 거부한다. 또한 `TASK_REWARD` 거래를 취소해도 연결된 `TaskCompletions` 행은 찾아 갱신하지 않으므로 완료 상태는 그대로 남는다.

### ADMIN_ADJUSTMENT

관리자 일괄 잔액 조정은 과제 완료 표시와 다른 **실제 금전 작업**이다.

1. 선택 학생들의 `balance`를 set/add/subtract 방식으로 갱신
2. 학생별로 `Transactions`에 `ADMIN_ADJUSTMENT` 행 append

현재 batch 저장의 원자성은 저장소 계약으로 보장되지 않는다. 잔액 batch/순차 갱신 중 실패하면 일부 학생만 변경될 수 있고 아직 원장은 하나도 append되지 않는다. 거래 append 중 실패하면 모든 잔액 갱신은 이미 시도된 뒤이며, 앞 학생 원장만 있고 실패한 학생과 뒤 학생 원장은 없을 수 있다. 호출은 실패한다. add/subtract의 변화량이 0이면 거래를 생략하지만 set은 값이 같아도 거래를 기록한다.

### ADMIN_MARK_COMPLETE

관리자 과제 배정 PATCH의 완료 표시 변경은 **금전 작업이 아니다**.

- 새 완료 표시는 `TaskCompletions`에 `status=SUCCESS`, `note=admin-assignment-status`로 append한다.
- `balanceBefore`와 `balanceAfter`는 동일하다.
- 학생 잔액을 지급/회수하지 않으며 `Transactions`에 보상 거래를 만들지 않는다.
- 현재 완료 해제는 해당 성공 완료 행을 삭제한다. append-only reversal이 아니다.
- 배정 대상(`allowedStudentIds`) 갱신 실패: 완료 행은 변경되지 않는다.
- 완료 행 조회 또는 기존 완료 삭제 실패: 배정 대상만 변경되고 기존 완료 상태는 남을 수 있다. 여러 삭제를 지원하지 않는 저장소의 순차 삭제 fallback에서는 일부 기존 완료만 삭제될 수 있다.
- 신규 n번째 완료 append 실패: 배정 대상 갱신과 기존 완료 삭제는 이미 반영되었고, 앞선 신규 완료만 추가된다. 실패한 학생과 뒤 학생의 신규 완료는 없다.

따라서 관리자 완료 체크를 `TASK_REWARD`나 `ADMIN_ADJUSTMENT`로 해석하면 안 된다. R0는 위 상태 표시 의미와 현재 완료 기록 보존/삭제 동작을 변경하지 않는다.

## 2. 향후 목표: 공통 idempotency 계약

향후 다음 작업은 모두 같은 durable operation 계약을 사용해야 한다.

- `CHECKOUT`
- `TASK_REWARD`
- `ADMIN_ADJUSTMENT`
- `CANCEL_TRANSACTION`
- `ADMIN_MARK_COMPLETE`

각 operation record는 최소한 다음 불변 필드를 가진다. 저장소는 `operationId`에 unique constraint 또는 동등한 atomic put-if-absent를 적용해야 한다. 최초 생성과 기존 record의 immutable 필드 비교는 하나의 원자적 경계에서 이루어져야 하며, 동일 ID의 동시 요청이 별도 record를 만들 수 있어서는 안 된다.

- `operationId`: 클라이언트가 한 번 생성한 뒤 동일 비즈니스 요청의 모든 재시도에서 바꾸지 않는 immutable ID. 전체 operation namespace에서 유일해야 한다.
- `operationType`: 위 작업 유형 중 하나.
- `subjectId`: 작업의 주 대상 ID. 예: 학생, 원거래, 과제 완료/배정 변경 대상. 다중 대상은 규격화된 복합 subject 표현을 사용한다.
- `payloadHash`: 의미 있는 요청 payload를 정규화한 뒤 계산한 hash.

정규화는 구현마다 달라져서는 안 된다. UTF-8 JSON, 객체 key 사전순 정렬, 배열은 해당 API에서 순서가 의미 없으면 명시된 stable key로 정렬하고 순서가 의미 있으면 보존, ID 문자열 trim, 금액/수량은 JSON 정수, 누락 optional 값은 계약에 정한 기본값으로 채운 canonical serialization을 사용한다. `operationType`과 `subjectId`도 hash 입력에 포함한다. 인증 토큰, 전송 시각, 재시도 횟수처럼 비즈니스 효과와 무관한 값은 제외한다.

처리 규칙:

- 같은 `operationId` + 같은 normalized `payloadHash`: 효과를 다시 적용하지 않고 저장된 이전 결과(성공이면 동일한 비즈니스 ID와 응답, 진행 중이면 현재 상태)를 반환한다.
- 같은 `operationId` + 다른 payload, `operationType` 또는 `subjectId`: 재사용 충돌로 거부한다. 새 효과를 적용하지 않는다.
- 서버가 `Date.now()` 등으로 만든 transaction/completion ID는 결과 식별자일 뿐 idempotency key로 사용하지 않는다.
- 네트워크 오류, timeout, 5xx, 응답 유실에 대한 **HTTP 재시도**는 원래 `operationId`와 payload를 그대로 사용한다.
- 사용자가 의도적으로 한 번 더 구매·지급·조정·취소 표시 변경을 하는 **새 비즈니스 요청**은 새 `operationId`를 사용한다. payload가 같다는 이유만으로 별도 요청을 합치지 않는다.

operation 결과와 생성되는 ledger/completion/reversal ID는 최초 처리 시 확정해 durable record에 저장하고 재개 시 재사용해야 한다.

## 3. 향후 목표: durable operation/outbox와 적용 상태

R0에는 operation/outbox 저장소가 없다. 향후 구현은 외부 효과보다 먼저 durable operation을 생성하고 다음 상태 기계를 따라야 한다.

```text
PENDING → APPLYING → APPLIED
                  ↘ FAILED_RETRYABLE
                  ↘ FAILED_MANUAL
FAILED_RETRYABLE → APPLYING
```

- `PENDING`: immutable 요청, hash, 예정 효과, 결정된 결과 ID를 durable하게 저장했으나 아직 적용하지 않음.
- `APPLYING`: applier가 lease를 획득해 효과를 적용/재개 중.
- `FAILED_RETRYABLE`: 일시 오류이며 자동/명시적 재시도가 가능. 마지막 성공 checkpoint와 오류를 보존.
- `FAILED_MANUAL`: 불변식 위반, 충돌 또는 자동 판별 불가능한 부분 적용. 운영자 조정 전 임의 재실행 금지.
- `APPLIED`: 잔액/재고/상태뿐 아니라 필요한 `Transactions` ledger 또는 완료 감사 행까지 기록되고 모든 checkpoint가 완료된 최종 상태.

적용 규칙:

1. **durable operation first**: Sheets 등 도메인 효과보다 operation record를 먼저 영속화한다.
2. 각 효과는 결정적 effect ID를 갖고 중복 적용 가능 여부를 조회할 수 있거나 compare-and-set 조건을 사용해야 한다. 외부 효과 성공 뒤 해당 effect checkpoint를 durable하게 기록한 다음 다음 효과로 간다.
3. 재개자는 완료 checkpoint 이전 효과를 건너뛰고 마지막 미완료 효과부터 시작한다. 단순히 전체 함수를 처음부터 재실행하지 않는다.
4. 효과 성공과 checkpoint 기록 사이 crash에도 중복 변경되지 않도록 effect ID/조건부 쓰기로 실제 적용 여부를 재확인한다. checkpoint만 믿고 산술 증감을 반복해서는 안 된다.
5. ledger append는 부가적인 best effort가 아니라 필수 효과다. ledger/audit append 실패를 무시하지 않고 `FAILED_RETRYABLE` 또는 `FAILED_MANUAL`로 남긴다. ledger checkpoint까지 완료되어야 `APPLIED`다.
6. 처리 결과는 operation record에 저장하며 동일 요청 재시도는 그 결과를 반환한다.

### 동시 실행의 최소 계약

동일 `operationId`에는 동시에 정확히 한 applier만 활성화될 수 있어야 한다. 구현은 durable compare-and-set으로 획득하는 만료 lease와 증가하는 fencing token을 사용해야 한다. 모든 checkpoint/state 갱신은 현재 token 소유자만 성공하며, lease 만료 후 `APPLYING` operation은 새 applier가 더 큰 token으로 인계하여 같은 상태에서 재개할 수 있다. 오래된 applier의 쓰기는 거부한다.

서로 다른 operation이 같은 학생 잔액 또는 상품 재고를 바꾸는 경우에도 subject/resource별 직렬화 또는 version 기반 compare-and-set을 사용한다. 계산 때 읽은 version이 달라지면 재계산 가능한 작업은 안전하게 재시도하고, 의미가 달라지는 작업은 충돌/수동 확인으로 전환한다. 단순 read-modify-write와 process-local mutex만으로는 여러 서버 인스턴스의 동시성을 충족하지 못한다.

서로 다른 `operationId`로 같은 원거래 취소가 동시에 요청되어도 원거래에는 성공한 취소가 최대 하나여야 한다. 원거래 status/version의 조건부 전이로 승자를 결정하고, 나머지는 새 reversal을 만들지 않은 채 이미 완료된 취소 결과 또는 명시적 충돌을 반환한다. `TASK_REWARD`도 `(task instance, student)`의 성공 완료 1회 불변식을 조건부 쓰기로 강제해야 하며, 잔액 version 확인만으로 대신할 수 없다.

## 4. 향후 목표: TASK_REWARD 취소

현재 구현의 일반 취소는 `TaskCompletions`를 변경하지 않는다. R0 보존 계약에서도 기존 완료 행을 그대로 유지하며 새 연결 컬럼이나 취소 상태를 도입하지 않는다.

향후 `TASK_REWARD` 취소는 다음을 하나의 `CANCEL_TRANSACTION` operation으로 처리해야 한다.

- 원 `TASK_REWARD` 거래와 원 `TaskCompletion`은 동일한 `completionId`로 명시적으로 연결한다. transaction ID 문자열 형식을 파싱하는 것만 연결 계약으로 삼지 않는다.
- 성공 시 원 `TASK_REWARD.status=CANCELLED`, 별도 reversal ledger append, 연결된 completion의 `status=REVERSED` 또는 `CANCELLED`가 모두 완료되어야 한다.
- 완료 이력은 삭제하지 않고 append-only 상태 변경/상쇄 기록으로 감사 가능해야 한다.
- 같은 취소 `operationId` 재시도 또는 이미 성공한 동일 취소 요청은 새 상쇄를 만들지 않고 이전 취소 결과를 반환한다.
- 보상을 받은 뒤 일부를 사용하여 회수 시 잔액이 음수가 되는 경우의 허용/거부/채무 처리 정책은 **TBD**다. 구현 전 제품 정책으로 확정해야 하며 현재의 “음수면 거부”를 영구 계약으로 간주하지 않는다.

## 5. 향후 목표: 관리자 완료와 보상 분리

`ADMIN_MARK_COMPLETE`는 앞으로도 표시/감사 상태 작업이며 잔액 효과가 없어야 한다. 관리자에게 실제 과제 보상을 지급하는 기능이 필요하면 별도 명령/operation type인 `ADMIN_GRANT_TASK_REWARD`로 제공한다.

- 보상 지급을 `completed: true` 같은 boolean PATCH 안에 숨기지 않는다.
- `ADMIN_GRANT_TASK_REWARD`는 금액, 대상, 연결 completion, 별도 idempotency key와 ledger를 명시하는 독립 요청이어야 한다.
- 완료 해제(uncomplete)는 기존 완료 행 삭제가 아니라 append-only reversal/status 전이로 설계한다.
- `ADMIN_MARK_COMPLETE`와 `ADMIN_GRANT_TASK_REWARD`는 operationId를 공유하거나 서로의 재시도로 취급하지 않는다.

`ADMIN_GRANT_TASK_REWARD`와 append-only uncomplete는 향후 목표이며 R0 구현에 존재하지 않는다.

## 6. R0 보존 계약과 도입 조건

- **현재 구현에서 관찰됨**: 1절의 다단계 Sheets 호출, 부분 실패 가능성, idempotency 부재 및 관리자 완료 표시 동작.
- **R0가 변경하지 않고 보존**: 기존 API, Sheets 8개 생성 스키마, 쓰기 순서, task reward 거래의 best-effort 처리, generic cancellation의 음수 방지 및 완료 행 유지, 관리자 완료 표시의 무보상 의미와 현재 삭제 동작. 이는 현재 구현의 위험을 해결했다는 뜻이 아니라 이번 R0 변경 범위 밖으로 명시한다는 뜻이다.
- **R0에 없음**: operationId 입력/응답, payloadHash, operation/outbox 저장소, 상태 기계, checkpoint, lease/fencing, 자동 복구, task completion 취소 연결, `ADMIN_GRANT_TASK_REWARD`.
- **향후 도입 조건**: 저장 위치와 스키마 호환/마이그레이션 계획, API versioning, canonical hash 규격 테스트, effect별 장애 주입 테스트, multi-instance 동시성 테스트, 운영자용 `FAILED_MANUAL` 조회·복구 절차를 별도 변경으로 승인해야 한다.

스키마 변경과 레거시 시트 보존 원칙은 [스키마 호환성 정책](./schema-compatibility.md)을 따른다.
