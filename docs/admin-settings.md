# 관리자 설정

이 문서의 시트 연결·설정 저장 절차는 기존 개인 Sheets 배포용이다. 중앙 PostgreSQL은 `/c/{slug}`의 tenant를 사용하며, 시트 ID 입력으로 tenant나 저장소 권한을 바꾸지 않는다. 배포 역할은 [Vercel 배포 가이드](vercel-deploy-guide.md)를 참고한다.

## 시트 ID 설정 방식

앱 실행 후 아래 주소로 이동하면 `/admin`으로 연결된다. 필요한 관리자 인증 후 시스템 설정을 확인한다.

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

앱은 주소에서 `/spreadsheets/d/` 뒤의 ID를 추출해 검증한다. 저장 요청의 ID는 배포에 설정된 `GOOGLE_SHEET_ID`와 같아야 하며, 관리자 화면에서 다른 시트로 영구 변경할 수 없다.

## 저장 위치

기존 Sheets 배포의 통화 단위·앱 제목·테마 등은 연결된 시트의 `Settings`에 저장된다. `data/settings.json`을 만들거나 수정하는 방식은 현재 설정 저장 경로가 아니다.

## 환경변수와 연결 확인

1. 기존 Sheets 배포는 `CLASS_STORE_STORAGE=sheets`와 `GOOGLE_SHEET_ID`를 설정한다. 일반 코드 업데이트에서는 기존 ID를 유지하고 새 시트를 만들지 않는다.
2. 승인된 시트 변경이 필요한 경우에만 배포 환경의 `GOOGLE_SHEET_ID`를 변경한 뒤 재배포한다. 관리자 화면의 입력만으로 배포 환경값은 바뀌지 않는다.
3. 설정을 불러오지 못했다면 저장하지 말고 `설정 다시 불러오기`로 재확인한다. 기본값이나 연결 ID 표시만으로 시트 접근 성공을 판단하지 않는다.

중앙 `/api/c/{slug}/settings`의 GET은 tenant DB 설정을 읽지만, 현재 POST는 Sheets 저장 경로를 호출하며 scoped tenant 요청에서는 그 경로가 거절된다. 따라서 이 폼을 중앙 DB 설정 저장 절차로 사용하지 않는다. 이 제한을 피하려고 전역 시트 ID나 storage를 바꾸지 않는다.

## Google 권한 주의

서비스 계정 방식을 쓸 경우, 입력한 스프레드시트에 서비스 계정 이메일을 **편집자**로 공유해야 한다.

서비스 계정 이메일은 `.env.local`의 `GOOGLE_SERVICE_ACCOUNT_EMAIL`에 들어간다.

지속 refresh token이 설정된 배포는 OAuth client와 해당 토큰을 먼저 사용한다. 일반 Google identity 로그인만으로 Sheets 편집 권한이나 refresh token을 얻지는 않는다. 목적별 인증과 환경변수는 [Vercel 배포 가이드](vercel-deploy-guide.md#서버-sheets-인증)와 [환경변수 예시](../.env.example)를 따른다.

## 과제 기한·반복·선행 과제

- 과제 행의 `기한` 버튼에서 시작 시각, 마감 시각, 선행 과제와 반복 규칙을 설정한다. 모바일에서는 팝업 안에서 내용을 세로로 스크롤하며 날짜·시간 입력은 팝업 폭에 맞춰 줄어든다.
- 기한은 `Asia/Seoul`에서 입력하고 저장소에는 ISO instant로 기록한다. 시작 시각 이상, 마감 시각 미만인 동안만 학생 목록과 완료 처리에 노출된다.
- 선행 과제는 하나만 선택할 수 있다. 자기 자신, 존재하지 않는 과제, 순환 참조는 저장되지 않는다.
- 주간 반복은 일~토 버튼을 여러 개 선택할 수 있다. 선택한 각 요일의 설정 시각이 자연 회차 경계가 된다.
- 기한은 과제 전체의 이용 가능 기간이고, 반복은 그 기간 안에서 완료 상태가 초기화되는 주기다. 마감이 반복 경계보다 우선한다.
- 은행 홈에서는 QR 없이 현재 활성 과제와 설명을 확인할 수 있다. 실제 `과제 완료` 처리에는 학생 QR이 필요하다.
