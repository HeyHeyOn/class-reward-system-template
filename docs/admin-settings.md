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

## 과제 기한·반복·선행 과제

- 과제 행의 `기한` 버튼에서 시작 시각, 마감 시각, 선행 과제와 반복 규칙을 설정한다. 모바일에서는 팝업 안에서 내용을 세로로 스크롤하며 날짜·시간 입력은 팝업 폭에 맞춰 줄어든다.
- 기한은 `Asia/Seoul`에서 입력하고 저장소에는 ISO instant로 기록한다. 시작 시각 이상, 마감 시각 미만인 동안만 학생 목록과 완료 처리에 노출된다.
- 선행 과제는 하나만 선택할 수 있다. 자기 자신, 존재하지 않는 과제, 순환 참조는 저장되지 않는다.
- 주간 반복은 일~토 버튼을 여러 개 선택할 수 있다. 선택한 각 요일의 설정 시각이 자연 회차 경계가 된다.
- 기한은 과제 전체의 이용 가능 기간이고, 반복은 그 기간 안에서 완료 상태가 초기화되는 주기다. 마감이 반복 경계보다 우선한다.
- 은행 홈에서는 QR 없이 현재 활성 과제와 설명을 확인할 수 있다. 실제 `과제 완료` 처리에는 학생 QR이 필요하다.

## Padlet 연동 과제

1. Padlet 보드에서 방문자 로그인을 필수로 하고 작성자 이름·작성 시각 표시를 켠다.
2. 보드 owner/admin 계정의 Developer 설정에서 API 키를 발급한다.
3. Vercel Production 환경에 `PADLET_API_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`을 설정한다.
4. 관리자 과제 생성 또는 상세 편집에서 Padlet 주소를 입력한다.

연동 과제는 현재 회차 시작 이후에 올라온 `approved` 게시물 중 Padlet `fullName`이 CRS 학생 이름과 공백 제거 후 정확히 같은 게시물만 인정한다. 동명이인·이름 변경·다른 사람 이름 사용은 자동으로 구별할 수 없으므로 학급에서 Padlet 표시 이름을 통제해야 한다. 게시물 하나는 Redis 원자 claim으로 한 과제에만 사용되며, 완료를 초기화해도 다시 사용할 수 없다. Padlet 또는 Redis가 미설정·장애 상태이면 연동 과제는 완료되지 않고 학생 화면에 확인 불가 상태로 표시된다.
