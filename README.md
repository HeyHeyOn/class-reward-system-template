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
```

## Vercel 배포

이 저장소를 GitHub 템플릿 저장소로 공개한 뒤 Vercel에서 Import하면 선생님별 운영 앱을 만들 수 있습니다.

필수 기본 환경변수:

```text
GOOGLE_SHEET_ID=생성기가 만든 스프레드시트 ID
ADMIN_PASSWORD=관리자 페이지 비밀번호
AUTH_SECRET=긴 무작위 문자열
```

Google Sheets 접근용 인증값은 OAuth refresh token 방식 또는 서비스 계정 방식 중 하나를 설정해야 합니다. 자세한 내용은 `docs/vercel-deploy-guide.md`를 확인하세요.

## Google Sheets 템플릿

필수 시트와 컬럼은 `docs/google-sheets-template.md`를 확인하세요.
