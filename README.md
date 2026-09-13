# 학급 보상 시스템 / 학급 매점

학급 보상 시스템·학급 매점 키오스크 웹앱입니다. 기존 Google Sheets 운영과 중앙 PostgreSQL 기반 학급별(tenant) 경로를 구분합니다.
이 저장소는 선생님이 Vercel에서 가져와 개인 학급용 URL을 만들기 위한 템플릿 저장소로 사용할 수 있습니다.

## 주요 기능

- 학생 학급 화폐 잔액 조회
- 상품/재고 관리
- QR 기반 학생 선택
- 장바구니 결제
- 잔액/재고/결제내역 기록(기존 Google Sheets / 중앙 PostgreSQL)
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

## 중앙 tenant / DB 구조와 이전 상태

- 중앙 학급 화면은 `/c/[slug]`, API는 `/api/c/[slug]/…`를 사용합니다. 서버가 canonical slug를 DB에서 조회해 요청별 tenant context를 만들며, 운영 PostgreSQL repository는 `ACTIVE` tenant만 허용합니다. 요청 context가 있으면 전역 환경 설정으로 tenant를 대체하거나 Sheets로 fallback하지 않습니다.
- Google 로그인 자체는 관리자 권한이 아닙니다. 선택 학급의 `OWNER`/`ADMIN` membership을 검사하며, 제한된 기존 tenant 관리자 세션 호환은 별도 검증합니다. 모든 조회가 관리자 전용인 것은 아닙니다.
- tenant 데이터는 transaction-local `app.tenant_id`와 FORCE RLS로 격리합니다. 중앙 runtime은 비소유자 `NOSUPERUSER NOBYPASSRLS` 최소 권한 계정이어야 하며 migration 계정과 분리합니다. 실제 DB 적용·권한 검증 완료를 뜻하지 않습니다.
- **자동 이전이나 activation 완료 상태가 아닙니다.** 준비용 READY는 bound snapshot 검증이며 live freeze 증명이 아닙니다. 구현된 FREEZING start도 `NOT_PROVEN`, 진단 재취득도 `NONAUTHORITY`·`finalImportEligible:false`입니다. 유지되는 외부 writer 배제, 최종 import·정합성·전역 claim 공개·activation은 아직 완료되지 않았습니다.
- live freeze·activation·옛 배포 은퇴·원본 삭제는 별도 승인 사항입니다. 원본 Sheets는 자동 삭제하지 않습니다. 앱 버전 rollback은 PostgreSQL 권위를 유지하며, Sheets 복귀는 단순 storage 값 변경이 아닌 별도 통제 migration입니다.

구성과 한계는 [DB 아키텍처](docs/database-architecture.md), 배포 역할·환경 설정·운영 승인 경계는 [Vercel 배포 가이드](docs/vercel-deploy-guide.md)를 확인하세요.

## 로컬 실행

```bash
npm install
npm run dev
```

## 환경변수

[`.env.example`](.env.example)을 참고해 `.env.local` 또는 Vercel 환경변수를 설정합니다. 아래는 **기존 Sheets 운영용 발췌**입니다. 중앙 DB·생성기·서명 QR 등 역할별 추가 설정은 예시 파일과 배포 가이드를 확인하세요. `CLASS_STORE_STORAGE`는 정확히 `sheets` 또는 `postgresql`을 명시하며 설정 변경만으로 이전되지 않습니다.

중앙 `DATABASE_URL`과 migration 전용 `DIRECT_DATABASE_URL`은 역할을 분리해 준비합니다. `CLASS_STORE_CENTRAL_TENANT_ID/STATUS`는 요청 context 없는 명시적 호환 경로용이지 중앙 `/c/[slug]`의 전역 기본값이 아니며, 일반 중앙 배포에서는 비웁니다.

```text
CLASS_STORE_STORAGE=sheets
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
```

## Vercel 배포

기존 Sheets 운영 방식에서는 이 저장소를 GitHub 템플릿 저장소로 공개한 뒤 Vercel에서 Import하면 선생님별 운영 앱을 만들 수 있습니다. 중앙 PostgreSQL 준비는 별도 배포 역할이며, 아래 Sheets 설정을 변경해 live 이전하는 절차가 아닙니다.

기존 Sheets 운영의 기본 환경변수(전체 설정은 `.env.example` 참고):

```text
CLASS_STORE_STORAGE=sheets
GOOGLE_SHEET_ID=생성기가 만든 스프레드시트 ID
ADMIN_PASSWORD=관리자 페이지 비밀번호
AUTH_SECRET=긴 무작위 문자열
```

Google Sheets 접근용 인증값은 OAuth refresh token 방식 또는 서비스 계정 방식 중 하나를 설정해야 합니다. 자세한 내용은 `docs/vercel-deploy-guide.md`를 확인하세요.

## Google Sheets 템플릿

필수 시트와 컬럼은 `docs/google-sheets-template.md`를 확인하세요.

## 아키텍처 문서

- [스키마 호환성 정책](docs/architecture/schema-compatibility.md)
- [금전 작업 신뢰성 계약](docs/architecture/money-operation-contracts.md) — 현재/R1 부분 실패 경계와 향후 idempotency·outbox 목표

## 결제 예상 금액 API

아래는 기존 unscoped API 경로입니다. 중앙 tenant에서는 같은 기능을 `/api/c/[slug]/checkout/preview`, `/api/c/[slug]/checkout`, `/api/c/[slug]/promotions/active`로 요청합니다.

`POST /api/checkout/preview`는 현재 상품, 재고, 활성 행사 정보를 기준으로 장바구니의 예상 결제 금액과 항목별 가격 스냅샷을 반환합니다. 이 결과는 조회 시점의 안내값이며 재고나 행사가 이후 변경될 수 있습니다. 실제 `POST /api/checkout` 결제는 저장 직전에 상품, 재고, 행사, 학생 잔액을 다시 읽고 금액을 권위 있게 재계산합니다.

키오스크는 인증 없이 `GET /api/promotions/active`에서 활성화된 행사 정의를 조회할 수 있습니다.
