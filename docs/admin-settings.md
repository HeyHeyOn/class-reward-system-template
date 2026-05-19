# 관리자 설정

학급 매점은 각 이용자가 자기 Google Spreadsheet를 연결해서 쓰는 방식을 기본으로 한다.

## 시트 ID 설정 방식

앱 실행 후 아래 주소로 이동한다.

```text
/admin/settings
```

관리자 설정 화면에서 다음 중 하나를 입력한다.

- Google Sheets 주소 전체
- Google Sheets ID만 입력

예시:

```text
https://docs.google.com/spreadsheets/d/1AbC_defGhijKlmnopQRstuVwxyz-1234567890/edit#gid=0
```

또는:

```text
1AbC_defGhijKlmnopQRstuVwxyz-1234567890
```

앱은 주소에서 `/spreadsheets/d/` 뒤의 ID를 자동 추출해 저장한다.

## 저장 위치

런타임 설정은 아래 파일에 저장된다.

```text
data/settings.json
```

이 파일은 이용자별 설정이므로 Git에는 커밋하지 않는다. 예시 파일만 커밋한다.

```text
data/settings.example.json
```

## 환경변수 fallback

배포 환경에서 파일 저장을 쓰기 어렵거나 기본 시트를 미리 지정하고 싶다면 `.env.local`에 `GOOGLE_SHEET_ID`를 넣을 수 있다.

우선순위:

1. `data/settings.json`에 저장된 런타임 설정
2. `.env.local`의 `GOOGLE_SHEET_ID`
3. 미설정 상태

## Google 권한 주의

서비스 계정 방식을 쓸 경우, 입력한 스프레드시트에 서비스 계정 이메일을 **편집자**로 공유해야 한다.

서비스 계정 이메일은 `.env.local`의 `GOOGLE_SERVICE_ACCOUNT_EMAIL`에 들어간다.
