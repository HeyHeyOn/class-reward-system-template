# 딴쌤 계정 전환 체크리스트 (클래스)

허브(ddanssaem.com)의 딴쌤 계정으로 클래스 로그인을 바꾸는 일. 기준은 `/home/haeon/workspace/projects/ddanssaem-hub/docs/account-protocol.md`의 6장(일정)과 7장(앱 할 일)이다. 세 앱을 묶은 통합 계획은 허브의 `docs/switch-plan.md`에 있다. 날짜는 허브 대화와 맞춘 것이고, 운영에 손대는 단계는 모두 사용자 확인을 받고 한다.

## 2026-10-16 운영 전환 (12월 5일에서 앞당김, 사용자 결정)

사용자가 허브 대화에서 바로 전환하기로 했다(이용자가 본인뿐이고 공개 전). 통합 약관 시행일도 2026-10-16으로 당겨졌다.

- 안전장치: 운영 선생님 계정 2개(본인 계정, `example.invalid` 시험 계정)뿐임을 확인했다.
- 백업: 0058, 0059는 기존 행을 바꾸지 않는다. 적용 직전 정의로 만든 되돌리기 SQL(구조만)을 두었다.
- 운영 DB에 0058, 0059를 적용했다. 적용 전후 행 수가 같다.
- 운영 환경 변수를 넣었다: `DDANSSAEM_HUB_URL=https://ddanssaem.com`, `DDANSSAEM_CLIENT_SECRET`, `DDANSSAEM_LOGIN=1`, `HUB_READY=1`, `CRON_SECRET`. `GOOGLE_*`는 되돌리기용으로 남겼다.
- 운영 배포 `dpl_5cKVMtFyVKgzvard7GNetQQZixCs`(직전 `dpl_DwNssaAieHLgmKPjQFLnWjMQjnZr`)를 냈다. 검사 21개를 통과했다.
- 되돌리기: 직전 배포를 다시 promote하면 바로 예전 Google 로그인이다. DB 변경은 추가뿐이라 그대로 둬도 된다.
- 아래 '전환 전'과 '전환 당일'은 12월 5일 기준으로 쓴 계획이다. '이날 바뀌는 것'과 '전환 뒤 정리'는 그대로 유효하다.

## 전환 전 상태 (2026-10-15)

- 코드
  - `DDANSSAEM_HUB_URL`과 `DDANSSAEM_CLIENT_SECRET`이 있으면 허브의 서버 호출(로그아웃과 탈퇴 알림 `/api/auth/ddanssaem/events`, 요약 `/api/ddanssaem/summary`)에 답한다.
  - 여기에 `DDANSSAEM_LOGIN=1`이면 로그인도 허브로 간다(`src/server/ddanssaem/hub.ts`의 `hubConnected`, `hubLoginEnabled`).
  - 마이그레이션
    - 0058: 허브 세션(`teacher_auth_sessions.hub_sid`)과 허브 동의(`user_agreements`에 `hub:YYYY-MM-DD`로 따로)
    - 0059: 탈퇴 기록 1년 보관 뒤 파기
  - 매일 크론 `/api/cron/withdrawal-retention`(`vercel.json`, 03:00 KST)은 `CRON_SECRET`이 있어야 일한다. 없으면 503으로 답하고 아무것도 하지 않는다.
- 미리보기 `https://ddanssaem-class-beta.vercel.app`(beta 허브와 연결)
  - DB는 같은 Neon 서버의 따로 둔 데이터베이스 `crs_preview`(구조만, 운영 데이터 없음)를 쓴다.
  - 확인한 것: 로그인과 로그아웃(허브까지), 학급 만들기, 허브 첫 화면의 '내 학급' 요약, 허브 탈퇴(`account_deleted`).
  - 탈퇴는 두 번 확인했다. 빈 학급으로 한 번, 학생과 거래, 과제, 펫이 있는 합성 학급으로 한 번이다. 텍스트 열 460개 어디에도 이름과 이메일이 남지 않았다.
  - 새 미리보기를 올리면 `vercel alias set <배포> ddanssaem-class-beta.vercel.app`을 다시 한다.
- 운영
  - 지금 Google 로그인 그대로다.
  - 연결 코드는 아직 운영에 나가지 않았다.
  - 0058, 0059는 운영 DB에 아직 적용하지 않았다.

## 전환 전 (11월 3일까지)

1. 운영 DB에 0058, 0059를 적용한다(사용자 확인).
   - 소유자 연결, 한 트랜잭션, 적용 전후 행 수 비교로 한다.
   - 0059는 탈퇴 함수를 바꿔서, 이후 탈퇴부터 식별자 해시를 기록에 함께 남긴다.
2. 연결 코드를 운영에 배포한다(허브 로그인은 꺼진 채, 사용자 확인).
   - `vercel deploy --prod --skip-domain` → `verify-stage.mjs` → `promote.mjs`
   - 배포 폴더의 `vercel.json`에 크론이 들어 있는지 본다.
3. 운영(Production) 환경 변수를 미리 넣는다(사용자 확인). 넣은 뒤 다시 배포해야 읽힌다.
   - `DDANSSAEM_HUB_URL=https://ddanssaem.com`
   - `DDANSSAEM_CLIENT_SECRET`
     - 허브 운영 `HUB_CLIENT_SECRET_CLASS`와 같은 값이다.
     - `~/.config/ddanssaem/hub-secrets.env`에서 파이프로 넣고 `--sensitive`를 붙인다.
   - 이것만으로는 로그인이 바뀌지 않는다. 알림과 요약 경로만 살아나서, 허브가 운영 요약을 미리 받아 볼 수 있다.
4. 허브 운영 쪽에 등록할 클래스 주소다(허브 대화 몫).
   - 돌아올 주소: `https://class.ddanssaem.com/api/auth/ddanssaem/callback`
   - 이벤트: `https://class.ddanssaem.com/api/auth/ddanssaem/events`
   - 요약: `https://class.ddanssaem.com/api/ddanssaem/summary`
   - 로그아웃 뒤 돌아올 곳: `https://class.ddanssaem.com/classes`
   - 운영 주소 class.ddanssaem.com은 Vercel 보호 밖이라 우회 값이 필요 없다. 보호는 미리보기와 `*.vercel.app` 운영 주소에만 걸려 있다.
5. 11월 4일 공지
   - 클래스 `/terms`, `/privacy`에 '12월 5일 시행 예정 통합 약관' 안내와 허브 문서 링크를 단다.
   - 선생님 화면에 안내 띠를 단다. 문구는 허브 대화와 맞춘다.
   - 같은 날 처리방침의 남은 '·'를 쉼표로 고친다: '학급 생성·관리', '매점·은행·과제', '구매·지급·회수', '이용약관·개인정보처리방침'.
6. 연결 작업이 끝나면 생성기 기능 코드를 지운다(허브 대화가 따로 요청).

## 전환 당일 (12월 5일 토요일 오전)

순서는 허브 → 보드 → 클래스다(통합 계획).

1. 클래스 운영 환경 변수를 넣고 운영을 다시 배포한다. 환경 변수는 배포할 때 읽힌다.
   - `DDANSSAEM_LOGIN=1`
   - `HUB_READY=1`
     - 머리글 메뉴에 '홈'과 '수업 도구'가 다시 생기고, 로고가 허브(`DDANSSAEM_HUB_URL`)로 간다.
     - 이 값은 `next.config.ts`의 `env`로 화면 코드에 들어가므로, 바꾼 뒤에는 꼭 다시 배포해야 한다.
   - `CRON_SECRET`: 32바이트 이상 무작위 값, `--sensitive`. Vercel 크론이 이 값을 `Authorization: Bearer`로 보낸다.
2. 바로 확인할 것
   - 머리글: 홈, 클래스, 보드, 수업 도구 메뉴와 로고 링크
   - 'Google로 로그인' 버튼 → 허브 → 클래스로 돌아오기(내 학급)
   - 허브 첫 화면의 '내 학급'
   - 로그아웃이 허브와 보드까지 이어지기
   - 내 프로필: 닉네임은 딴쌤 계정 이름(읽기 전용), 탈퇴는 '딴쌤 계정 열기'
   - 학생 입장, 매점과 은행(학생 QR)은 그대로인지
   - 크론: `vercel crons run /api/cron/withdrawal-retention`으로 한 번 돌려 200과 0건을 확인한다. 첫 파기는 2027년 10월쯤이다.
3. 이날 바뀌는 것
   - 허브를 거친 세션만 인정한다.
     - 클래스는 허브 동의(`hub`)가 있는 세션만 받으므로, 선생님은 모두 한 번 다시 로그인한다.
     - 학생 입장과 학생 세션은 그대로다.
   - 약관 동의는 허브가 처음 로그인할 때 받는다.
     - 클래스 자체 동의 화면(`/signup`)과 동의 경로는 쓰이지 않는다(`/signup`은 `/classes`로 보냄).
     - 허브 동의는 `user_agreements`에 `hub:YYYY-MM-DD`로 따로 적힌다. 예전 클래스 동의 기록은 그대로 둔다.
   - 닉네임은 로그인할 때마다 딴쌤 계정 이름으로 바뀐다. 프로필 아이콘은 그대로다.
   - 클래스의 동의 철회와 탈퇴는 막히고 허브의 내 계정으로 안내한다. 허브 탈퇴가 오면 클래스 탈퇴 규칙대로 지운다.
   - 같은 Google 계정이면 기존 학급이 그대로 이어진다.
4. 되돌리기
   - `DDANSSAEM_LOGIN`(과 `HUB_READY`)을 지우고 다시 배포하면 예전 Google 로그인으로 돌아간다.
   - 허브로 만든 세션은 그때 무효가 되어 한 번 다시 로그인한다. 클래스 동의 기록이 남아 있으니 같은 판이면 다시 동의하지 않는다.
   - Google 클라이언트를 지우기 전까지만 가능하다.
   - `DDANSSAEM_HUB_URL`, `DDANSSAEM_CLIENT_SECRET`, `CRON_SECRET`은 남겨 둬도 된다.

## 전환 뒤 정리 (안정되면, 예: 2주 뒤)

1. 지울 코드
   - 클래스 자체 Google 로그인
     - `/api/google/login`의 신원 확인 부분, `/api/google/callback`
     - `src/server/googleOAuth.ts`의 로그인용 함수
   - 클래스 자체 가입과 동의
     - `/signup`, `/api/account/agreement`
     - 가입 대기 쿠키(`class_store_pending_agreement`)
     - `legalNoticeFor`의 클래스 판 안내
   - 클래스 자체 탈퇴와 닉네임 바꾸기
     - `/api/account/withdraw`, 프로필의 닉네임 입력
     - 탈퇴 규칙 `platform_withdraw_user`는 `account_deleted`에서 계속 쓴다.
   - `hubLoginEnabled()` 분기와 `requiredAgreementVersion()`: 늘 허브인 것으로 정리한다.
   - 개발용 로그인: 로컬에서 허브 없이 시험할 방법(예: 개발 모드 전용 가짜 허브)을 정한 뒤 바꾼다.
   - 생성기와 시트 모드를 남길지 정한다.
2. 코드 정리를 운영에 배포한 뒤 아래를 지운다.
   - Google Cloud 프로젝트 `CRS-generator`(로그인 클라이언트 포함)
   - 운영 환경 변수 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - 세션 쿠키 키는 `AUTH_SECRET`에서 나오므로 Google 값을 지워도 세션은 그대로다. 그래도 코드 정리보다 먼저 지우면 로그인이 깨진다.
3. ~~클래스 `/terms`, `/privacy`를 허브 통합 문서로 옮긴다.~~ 2026-10-16 끝남: 두 주소는 허브로 308 이동하고, 앱 안의 링크도 모두 허브 주소다. 남은 `src/lib/legalDocuments.ts`는 1번 코드 정리 때 함께 지운다.
4. 미리보기 정리
   - `crs_preview` DB와 역할 `crs_preview_runtime`은 시험이 더 필요 없으면 지운다(사용자 확인).
   - Vercel 미리보기 환경 변수도 함께 지운다.

## 설정과 비밀값 위치

| 무엇 | 어디 |
|---|---|
| 허브와 나누는 비밀값 | `~/.config/ddanssaem/hub-secrets.env`의 `HUB_CLIENT_SECRET_CLASS`(출력하지 않고 파이프로) |
| 미리보기 보호 우회 값 | `~/.config/ddanssaem/class-bypass.txt`(허브 미리보기 `HUB_CLIENT_BYPASS_CLASS`) |
| 미리보기 DB 앱 연결 | `~/.config/ddanssaem/class-preview-db.env`(Vercel 미리보기 `DATABASE_URL`) |
| 운영 배포 폴더 | `~/.cache/crs-legal-task-20261011/deployment`(Vercel 프로젝트 `crs-postgresql`) |
