# Vercel 배포 가이드

## 구조

학급 매점 운영 배포는 다음 구조를 사용합니다.

```text
사용자 기기 → Vercel Next.js 앱/API → Google Sheets
```

서버를 직접 켜둘 필요가 없습니다.

## 필수 환경변수

Vercel Project Settings → Environment Variables에 아래 값을 등록합니다.

```text
GOOGLE_SHEET_ID=스프레드시트 ID
GOOGLE_SERVICE_ACCOUNT_EMAIL=서비스계정 이메일
GOOGLE_PRIVATE_KEY=서비스계정 private key
ADMIN_PASSWORD=관리자 페이지 비밀번호
```

주의:

- `GOOGLE_PRIVATE_KEY`는 채팅이나 문서에 노출하지 마세요.
- Vercel에는 실제 줄바꿈 대신 `\n`이 포함된 형태로 넣어도 앱에서 처리합니다.
- `ADMIN_PASSWORD`가 없으면 관리자 페이지 보호가 꺼집니다. 운영 배포에서는 반드시 설정하세요.

## Google Sheets 권한

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
