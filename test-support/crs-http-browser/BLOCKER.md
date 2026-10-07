# P1 / Task20 — BLOCKED / NOT_RUN / 수용 0/6

## 현재 결론

실제 Next HTTP → 세션/멤버십 → history anchor → native 다운로드 경로는 닫히지 않았다. 실제 실행 대신 합성 PASS를 만들지 않았다. 이번 패킷은 최소 실제-network 시나리오 코드와 환경 장애 재현만 제공한다. 승인된 전체 fixture launcher/PG seed/Next·Chrome 실행환경은 아직 없으며, `README.md`의 선행 계약이 충족되어야 한다. Sol 독립 통합 전 Task20은 **0/6**이다.

## 이번 세션의 실제 장애 재현

- 분류: **ENVIRONMENT / nested namespace admission**. 모델·인증·프로필 실패 또는 production route 결함으로 판정하지 않는다.
- 실행: 저장소 루트에서 `python3 -I -B test-support/crs-http-browser/probe.py`
- 호스트에서 물려준 환경은 PATH/LANG만. outer bwrap 안에는 HOME/LANG/PATH/PWD만 지정했다. 소스 트리·dotenv·운영 홈·기존 서비스 소켓은 마운트하지 않았다.
- outer 네임스페이스에서 관측: UID 1000, 인터페이스 lo만, IPv4 route 없음, IPv6 loopback 및 reject route만, `/home`, `/root`, `/run`, `/var/run`, `/repo`, `/etc/resolv.conf` 없음. `127.0.0.1:35883` 임시 bind 후 즉시 close. HTTP listener 또는 클라이언트 통신이 아니다.
- 현재 LSM label 관측: `bwrap//&unpriv_bwrap (enforce)`.
- inner payload는 `/usr/bin/true`뿐이며 inner bwrap의 실제 종료코드 **1**. 바깥 probe도 **1**. timeout=false.
- inner stderr 그대로:

  `bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>.`

- nested 시각: 2026-09-26T11:18:13.235772+00:00 → 2026-09-26T11:18:13.237169+00:00. 정확한 outer/inner argv·시간·duration·PID·실제 종료코드는 아래 원시 JSON과 로그에 있다. 이 에러 문자열만으로 시스템 전역 userns 비활성 또는 특정 AppArmor 규칙을 확정하지 않는다. outer 생성은 성공했고 inner admission만 실패한 것이 이번 관측 범위다.
- 근거: `evidence/probe-168137c1682f4b7c99898aa6434f5aed/result.json`, `stdout.log`, `stderr.log`. inner stderr는 outer stdout의 구조화 JSON 안에 있다. outer stderr.log가 비었다고 성공이 아니다.
- 정리: probe가 만든 프로세스를 wait/reap했고 loopback socket을 닫았다. `--die-with-parent`로 수명 제한. 남긴 것은 허용 폴더 내 증거 파일뿐이다. 신규 Next/Chrome/PG/Docker 리소스는 없다.

중첩 실패 이후 Next를 outer 쪽으로 옮기기, host 실행, 같은 namespace sidecar/nsenter, relay, `--no-sandbox`, privileged wrapper, AppArmor/sysctl/chmod 등 어떠한 대체 topology·정책 완화도 시도하지 않았다. Chrome 단독 실행 성공의 과거 기록을 이번 Next/browser 성공으로 승격하지 않았다. 인터넷 오류 안내 URL을 열지도 않았다.

## 기존 구현과 marker 확인

읽은 최초 기준: CURRENT-STATE.md, CRITICAL-PATH.md, VERIFICATION-ENV.md, EVIDENCE-CONTRACT.md, BLOCKER-default-profile-home-20260926.md, 저장소 AGENTS.md, 설치 Next installation/testing Playwright/Vitest/route 가이드, 기존 gap audit.

현재 기존 route는 `src/app/api/migrations/status/[slug]/preflight/download/route.ts`에 있다. GET/HEAD가 기존 `readHistoricalReportDownload`로 연결된다. history page의 native `<a>`는 같은 route를 가리킨다. 중복 route를 생성하지 않았다. `download.browser-boundary.test.tsx`는 opt-in 값과 관계없이 skip하는 기존 marker 그대로다. 과거 gap audit의 route/history/두 reader/marker SHA와 현재 SHA 비교 결과는 static 증거에 별도 기록한다.

실제 기본 프로필 홈은 이번 실행에서 `/home/haeon/.hermes`로 관측했다. profiles/default 생성·계정/모델/프로필 설정 변경이나 이전 서비스 재시작은 하지 않았다. 과거 프로필 경로 오류와 이번 namespace 오류는 별개다.

## 작성 범위와 구현 수준

추가 파일은 `test-support/crs-http-browser/**` 및 신규 `src/app/c/[slug]/admin/migrations/history/download.acceptance.test.tsx`뿐이다. 기존 production route/reader/shared 파일은 수정하지 않았다. 공유 트리의 다른 작업자 미커밋·미추적 항목은 보존했다. commit/push/전환/배포는 없다.

시나리오 코드에는 실제 Next navigation, CDP native input/download event·저장 바이트, GET/HEAD, 쿠키 제거·만료, 실제 PG membership 삭제 COMMIT 이후 stale link의 403, 다른 tenant의 HTTP 403 및 누출 검사 경로가 있다. 아직 이를 실행하거나 seed/서버/browser 호환성을 입증하지 못했다. 외부 OAuth 로그인을 사용하지 않고 합성 ordinary-session cookie로 실제 복호화/멤버십 경로를 검증하도록 준비했다. Google OAuth login/callback 자체는 범위 밖/미입증이다.

추가 production/shared 파일 수정 필요성은 현재 정적 조사에서 확정되지 않았다. 향후 실제 fixture 실행 중 필요성이 확인되면 해당 파일·이유를 보고하고 멈춰야 한다. 승인된 sandbox launcher와 PG fixture 준비는 잔여 선행 작업이며, 완료된 구현으로 숨기지 않는다.

## 실제 검사와 미실행 항목

- namespace probe: 실제 실행, exit **1** (장애 재현; acceptance PASS 아님).
- Python AST, 새 TS/TSX/MTS의 TypeScript transpileModule 문법 검사, source hash/whitespace/git diff-check: 별도 `verify_static.py` 실행 결과를 `evidence/static-*/result.json` 및 로그에 기록. compiler API는 구문만 읽으며 파일 emit/프로젝트 타입검사/테스트 discovery/앱 import를 하지 않는다. 이 결과는 HTTP/browser/PG 입증을 대체하지 않는다.
- 실제 Next HTTP: **NOT_RUN / NOT_PROVEN**.
- 실제 Chrome/native 다운로드: **NOT_RUN / NOT_PROVEN**.
- 실제 PG wire/RLS/멤버십: **NOT_RUN / NOT_PROVEN**.
- Vitest (기존 marker 포함), 프로젝트 tsc, lint, build, Docker 및 공유 runner: **NOT_RUN**. 미실행 marker를 이번 실행의 SKIP 또는 PASS 숫자로 세지 않는다.
- 운영 쿠키·DB·Sheets·Redis·외부 접속: 사용하지 않음. probe가 한 소켓 작업은 격리 loopback bind/close뿐이며 외부 connect 시도는 없다.
- acceptance-stage: 미도달, security_outcome: **NOT_PROVEN**, 독립 검증자: 미배정/미실행, 전체 스냅샷 통합 수용: 없음.

남은 차단: 허용된 nested sandbox topology, 승인된 폐기형 PG/role/DDL/seed와 runtime Next 연결, 격리 Chrome과 native 다운로드 관측, 직렬 runner 슬롯 및 전체 소스 freeze/증거 계약/cleanup, Sol 독립 검증. 현재 generic GET/HEAD route가 존재한다는 사실이나 syntax exit 0만으로 이 차단을 해소할 수 없다.
