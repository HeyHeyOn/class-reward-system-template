# Vercel 배포 가이드

## 구조

학급 매점 운영 배포는 다음 구조를 사용합니다.

```text
사용자 기기 → Vercel Next.js 앱/API → Google Sheets
```

서버를 직접 켜둘 필요가 없습니다.

## 필수 환경변수

Vercel Project Settings → Environment Variables에 아래 값을 등록합니다.

### OAuth refresh token 방식 권장

서비스 계정을 만들지 않고, 최초 1회 승인받은 선생님 Google 계정 권한으로 Sheets를 수정하려면 아래 값을 사용합니다. 이 방식에서는 학생 키오스크와 암호 관리자 화면 모두 Google 로그인 없이 동작하고, Vercel 서버가 `GOOGLE_REFRESH_TOKEN`으로 Sheets API에 접근합니다.

```text
GOOGLE_SHEET_ID=스프레드시트 ID
GOOGLE_CLIENT_ID=Google OAuth 클라이언트 ID
GOOGLE_CLIENT_SECRET=Google OAuth 클라이언트 보안 비밀
GOOGLE_REFRESH_TOKEN=선생님 계정으로 발급받은 refresh token
AUTH_SECRET=임의의 긴 랜덤 문자열
ADMIN_PASSWORD=관리자 페이지 비밀번호
```

Google Cloud OAuth 클라이언트의 승인된 리디렉션 URI에는 refresh token 발급/재연결에 사용할 주소 기준 아래 값을 등록합니다.

```text
https://배포주소/api/google/callback
```

예:

```text
https://class-store-six.vercel.app/api/google/callback
```

Google refresh token의 계정은 해당 스프레드시트에 편집 권한이 있어야 합니다.

### 기존 서비스 계정 방식도 지원

기존처럼 서비스 계정을 쓰려면 아래 값을 사용합니다.

```text
GOOGLE_SHEET_ID=스프레드시트 ID
GOOGLE_SERVICE_ACCOUNT_EMAIL=서비스계정 이메일
GOOGLE_PRIVATE_KEY=서비스계정 private key
ADMIN_PASSWORD=관리자 페이지 비밀번호
```

`GOOGLE_CLIENT_ID`와 `GOOGLE_CLIENT_SECRET`이 설정되어 있으면 Google 계정 로그인 방식이 우선 적용됩니다.

주의:

- `GOOGLE_PRIVATE_KEY`는 채팅이나 문서에 노출하지 마세요.
- `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `AUTH_SECRET`, `GOOGLE_PRIVATE_KEY`는 채팅이나 공개 문서에 노출하지 마세요.
- Vercel에는 실제 줄바꿈 대신 `\\n`이 포함된 형태로 넣어도 앱에서 처리합니다.
- `ADMIN_PASSWORD`가 없으면 관리자 페이지 보호가 꺼집니다. 운영 배포에서는 반드시 설정하세요.

## Google Sheets 권한

### OAuth refresh token 방식

1. Google Cloud에서 OAuth 클라이언트를 만듭니다.
2. 승인된 리디렉션 URI에 `https://배포주소/api/google/callback`을 등록합니다.
3. 선생님 계정으로 최초 1회 승인하여 refresh token을 발급받습니다.
4. Vercel에 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `AUTH_SECRET`, `ADMIN_PASSWORD`를 등록합니다.
5. refresh token을 발급받은 Google 계정에 학급 매점 스프레드시트 **편집자** 권한을 부여합니다.
6. 운영 중 학생 키오스크와 `/admin/login` 암호 로그인은 Google 로그인 없이 사용할 수 있습니다.

### 서비스 계정 방식

1. Google Cloud에서 서비스 계정을 만듭니다.
2. 서비스 계정 이메일을 복사합니다.
3. 학급 매점 스프레드시트를 열고 서비스 계정 이메일을 **편집자**로 공유합니다.
4. Vercel 환경변수에 같은 이메일과 private key를 등록합니다.

## 배포 순서

1. GitHub 저장소에 프로젝트를 올립니다.
2. Vercel에서 Import Project를 선택합니다.
3. Framework Preset은 Next.js로 둡니다.
4. 환경변수를 등록합니다.
5. Deploy를 실행합니다.
6. 배포 후 아래 주소를 확인합니다.

```text
/
/admin/login
/admin
/admin/student-qrs
/admin/transactions
```

## 운영상 중요 변경점

Vercel에서는 로컬 파일 저장이 영구 보장되지 않습니다. 따라서 앱 설정은 `data/settings.json`이 아니라 Google Sheets의 `Settings` 시트를 사용합니다.

- 스프레드시트 ID: `GOOGLE_SHEET_ID` 환경변수로 고정
- 화폐 단위: `Settings` 시트의 `currencyUnit` 값

스프레드시트를 바꾸려면 관리자 화면이 아니라 Vercel의 `GOOGLE_SHEET_ID` 환경변수를 바꾸고 재배포하세요.
