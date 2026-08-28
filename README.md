# 학급 보상 시스템 / 학급 매점

Google Sheets를 백엔드로 사용하는 학급 보상 시스템·학급 매점 키오스크 웹앱입니다.
이 저장소는 선생님이 Vercel에서 가져와 개인 학급용 URL을 만들기 위한 템플릿 저장소로 사용할 수 있습니다.

## 주요 기능

- 학생 학급 화폐 잔액 조회
- 상품/재고 관리
- QR 기반 학생 선택
- 장바구니 결제
- Google Sheets 잔액/재고/결제내역 기록
- 관리자 페이지
- 학생 QR 출력
- 결제 내역 확인
- 학급 화폐 단위 설정
- 시작·마감 기한, 선행 과제, 다중 요일을 포함한 일/주/월 반복 과제 관리
- 은행 홈의 QR 없는 활성 과제 조회와 QR 기반 과제 완료
  - 공개 과제 목록은 홈 카드 안에서 스크롤되며, 모바일에서도 `내 계좌`와 `과제 완료` 버튼은 가로로 유지됩니다.
  - 공개 목록과 QR 확인 후 완료 목록 모두 연결된 과제를 한 장의 카드에서 좌우로 넘겨 볼 수 있습니다. 하단의 작은 채운 점으로 위치를 표시하고, 터치에서는 스와이프를, 마우스 환경에서는 카드 가장자리의 화살표를 사용할 수 있습니다.
  - 완료 목록은 학생명을 표시하며, 잠금 안내와 채운 알약형 완료 표시는 카드 위에 겹쳐 보여 목록 높이를 불필요하게 늘리지 않습니다. 완료된 카드는 배경만 어둡게 표시하고, 연결 과제는 완료된 슬라이드 영역에만 적용합니다.
  - 과제 상세를 닫아도 목록 스크롤과 각 연결 과제의 현재 슬라이드를 유지합니다. 완료 응답이 늦거나 유실되면 같은 operation ID로 상태를 재확인하고 학생 세션과 목록을 보존합니다.
- 관리자 과제 lifecycle/cycle 이력 조회
- 학생 API의 요청 학생 한정 공개 DTO와 관리자 인증 raw 조회 분리

## 로컬 실행

```bash
npm install
npm run dev
```

## 환경변수

`.env.example`을 참고해 `.env.local` 또는 Vercel 환경변수를 설정합니다.

```text
GOOGLE_SHEET_ID=

# OAuth refresh token 방식 권장: 학생/키오스크는 Google 로그인 없이 작동
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
AUTH_SECRET=
ADMIN_PASSWORD=

# 기존 서비스 계정 방식: OAuth refresh token이 없을 때 fallback
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=

# Padlet 연동 과제를 사용할 때만 설정(서버 전용)
PADLET_API_KEY=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

## Vercel 배포

이 저장소를 GitHub 템플릿 저장소로 공개한 뒤 Vercel에서 Import하면 선생님별 운영 앱을 만들 수 있습니다.

필수 기본 환경변수:

```text
GOOGLE_SHEET_ID=생성기가 만든 스프레드시트 ID
ADMIN_PASSWORD=관리자 페이지 비밀번호
AUTH_SECRET=긴 무작위 문자열
```

Google Sheets 접근용 인증값은 OAuth refresh token 방식 또는 서비스 계정 방식 중 하나를 설정해야 합니다. Padlet 연동 과제를 사용하는 배포는 추가로 Padlet 보드 owner/admin의 API 키와 Upstash Redis REST URL·token을 모두 설정해야 합니다. 해당 값이 없거나 서비스 확인에 실패하면 연동 과제는 fail-closed로 완료를 허용하지 않습니다. 자세한 내용은 `docs/vercel-deploy-guide.md`를 확인하세요.

## Google Sheets 템플릿

필수 시트와 컬럼은 `docs/google-sheets-template.md`를 확인하세요.

## 아키텍처 문서

- [스키마 호환성 정책](docs/architecture/schema-compatibility.md)
- [금전 작업 신뢰성 계약](docs/architecture/money-operation-contracts.md) — 현재/R1 부분 실패 경계와 향후 idempotency·outbox 목표

## 결제 예상 금액 API

`POST /api/checkout/preview`는 현재 상품, 재고, 활성 행사 정보를 기준으로 장바구니의 예상 결제 금액과 항목별 가격 스냅샷을 반환합니다. 이 결과는 조회 시점의 안내값이며 재고나 행사가 이후 변경될 수 있습니다. 실제 `POST /api/checkout` 결제는 저장 직전에 상품, 재고, 행사, 학생 잔액을 다시 읽고 금액을 권위 있게 재계산합니다.

키오스크는 인증 없이 `GET /api/promotions/active`에서 활성화된 행사 정의를 조회할 수 있습니다.
