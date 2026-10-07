# CRS 보안 및 구조 성능 검사 보고서

검사일: 2026년 10월 7일. 대상: 현재 운영 중인 CRS. **검사와 보고서 작성만 수행했으며 애플리케이션 코드·의존성·배포·운영 DB·보안 설정은 변경하지 않았다.**

## 결론

보안상 개선할 문제가 있다. 로컬 합성 검사에서 **로그아웃 후 일부 관리자 인증이 유지되는 문제**, **Excel 압축파일의 사전 검사가 실제 파서가 읽는 범위를 모두 검사하지 않는 문제**, **셀 병합 확장이 자원 제한 검사보다 먼저 실행되는 문제**를 확인했다. 첫 문제는 비밀번호 호환 로그인을 사용한 브라우저, 나머지는 업로드 권한이 있는 사용자에게 해당한다. 운영 서비스에 공격 파일을 전송하거나 장애를 유발하지 않았다.

성능에서는 **거래 취소 연결 조회의 반복 전체 검색**과 **관리자 거래 목록의 무제한 조회**, **과제 장부의 반복적인 전체 이력 계산**이 우선 개선 대상이다. 작은 합성 DB에서도 첫 문제의 비용 증가를 재현했다. 화면 디자인을 다시 만들거나 DB를 교체할 필요 없이 조회·인덱스·잠금 범위부터 개선할 수 있다.

이번에 살펴본 인증·권한 경로에서 Google 인증 위조, 학급 간 권한 우회, SQL 주입 또는 현재 CRS에서 호출 가능한 원격 코드 실행 경로는 확인하지 못했다. 이는 모든 취약점이 없다는 보증은 아니다. 라이브러리 경고, 조건부 위험, 보류한 정책은 아래에서 별도로 구분한다.

## 대상과 검사 범위

| 항목 | 확인 결과 |
|---|---|
| 운영 주소 | <https://crs-postgresql.vercel.app/classes> |
| 실제 주소 연결 | `crs-postgresql.vercel.app`이 `dpl_Dc39E98LPdA4GQ5dzCYwRJ2UiVNU`를 가리킴을 Vercel 조회로 확인 |
| 운영 배포 | READY, Production, Singapore `sin1` |
| 검토 소스 | Git `a0c32fbfb99b3bbaf56f6db7f67749469f1b2064`; 제품 체크포인트 `2ab7c21` |
| 배포 후보 대조 | 보관된 후보의 src/public·패키지·설정 591개 파일 대조. 제품 코드의 두 파일은 공백만 다르고, `vercel.json`은 JSON 표현만 다르며 의미는 동일. 나머지 차이는 테스트용 경로 목록. 패키지 잠금 파일 일치 |
| 운영 요청 | 로그인하지 않은 GET 6회. 응답 상태·보안 헤더만 확인하고 본문·쿠키는 수집하지 않음 |
| 로컬 검증 | 인증 관련 기존 검사 11개 파일·169건 통과, 로그아웃 합성 재현, 작은 Excel 파서 검사, 메모리 DB 조회 계획, 장부 계산 CPU 측정 |
| 의존성 | `npm audit --omit=dev --json` 및 관련 공식 보안 공지 확인 |
| 제외한 검사 | 운영 DB 직접 조회·변경, 학생 정보 조회, 실사용자 세션 검사, 공격 요청·대량 요청, 운영 부하 시험, 전체 회귀 검사 |

Vercel 방화벽의 사용자 지정 설정 조회는 결과를 얻지 못했다. 따라서 로그인 제한이나 사용자 지정 WAF 규칙이 없다고 단정하지 않는다. 운영 DB의 실제 인덱스·권한·타임아웃도 직접 조사하지 않았으며, 아래 DB 판단은 저장소 스키마와 격리된 합성 실행에 근거한다.

## 보안 개선 항목

심각도는 발생 시 영향과 필요한 권한을 함께 고려했다. ‘우선 개선’은 다음 변경 작업의 우선순위이며 현재 장애 발생이나 긴급 서비스 중단을 뜻하지 않는다.

| 번호 | 항목 | 판단 | 우선순위 |
|---|---|---|---|
| SEC-01 | 로그아웃 후 학급 관리자 세션 유지 | 중간 위험, 로컬 재현 | 우선 개선 |
| SEC-02 | Excel 압축파일 검사 범위 누락 | 중간 위험, 사전 검사와 실제 파서의 불일치 재현 | 우선 개선 |
| SEC-03 | Excel 병합 셀의 사전 자원 제한 부족 | 중간 위험, 작은 파일로 할당 증가 재현 | 우선 개선 |
| SEC-04 | 알려진 보안 경고가 있는 의존성 | 버전 해당, 실제 공격 가능성은 경로별로 다름 | 호환 패치 계획 |
| SEC-05 | 비밀번호 로그인 시도 제한 | 앱 제어 부재 확인, 운영 WAF·실제 비밀번호 사용 여부 미확인 | 조건부 보완 |
| SEC-06 | 브라우저 보안 헤더 | 실제 응답에서 부재 확인, 직접 악용은 미검증 | 방어 보강 |
| SEC-07 | 요청 본문을 제한 검사 전에 메모리에 적재 | 코드 확인, Vercel의 별도 상한 존재 | 구조 보완 |

### SEC-01 로그아웃 후 학급 관리자 세션 유지

CRS의 비밀번호·QR 호환 관리자 로그인은 `class_store_tenant_admin` 세션을 발급한다. 그러나 관리자 로그아웃과 Google 로그아웃은 이 쿠키를 만료시키지 않는다. 내 학급 화면이 호출하는 Google 로그아웃은 정상 완료되더라도 해당 호환 세션을 남긴다. 이후 학급 관리자 권한 검사에서는 남은 세션을 계속 받아들인다.

실제 로그아웃 핸들러와 실제 권한 검사 함수에 합성 브라우저 쿠키·메모리 세션 저장소를 연결한 결과, 두 로그아웃 모두 200을 반환했지만 이후 관리자 인증도 성공했다. 호환 세션은 최대 12시간 유지될 수 있다. 비밀번호 호환 로그인을 사용한 공유 기기에서 다음 사용자가 관리자 기능을 계속 사용할 수 있다는 의미다. **Google 로그인만 사용하고 호환 관리자 세션이 없는 브라우저에 같은 문제가 발생한다는 뜻은 아니다.** 운영 학급의 현재 비밀번호 활성 상태는 조사하지 않았다.

개선 방향은 해당 쿠키의 정확한 범위를 만료시키고 서버에 저장된 세션도 폐기하는 것이다. 비밀번호 로그인, Google·비밀번호 혼합 로그인, 로그아웃, 뒤이은 관리자 요청 거절을 함께 검증해야 한다. Google 본인 확인을 별도로 요구하는 학급 관리·이전·내보내기가 모두 이 문제로 우회된다는 주장은 하지 않는다.

근거: [Google 로그아웃](/home/haeon/workspace/projects/class-store/src/app/api/google/logout/route.ts:5), [관리자 로그아웃](/home/haeon/workspace/projects/class-store/src/app/api/admin/logout/route.ts:4), [세션 발급](/home/haeon/workspace/projects/class-store/src/app/api/admin/login/route.ts:21), [호환 세션 허용](/home/haeon/workspace/projects/class-store/src/server/tenantAccess.ts:66), [합성 결과](/home/haeon/.cache/crs-audit-20261007/auth-logout-proof-result.json).

### SEC-02 Excel 압축파일 검사 범위 누락

학생·상품 일괄 등록과 기존 CRS Excel 가져오기에 각각 별도 ZIP 검사기가 있다. 두 구현 모두 압축파일에 기록된 항목 수만큼 검사한 뒤, 실제 디렉터리 전체를 빠짐없이 검사했는지 최종 대조하지 않는다. 이후 사용하는 Excel 파서는 이 검사보다 더 많은 항목을 읽을 수 있다.

약 207KiB의 무해한 합성 압축파일에서 정상 메타데이터일 때는 항목 수 제한으로 거절되지만, 메타데이터와 실제 항목 수가 불일치하는 경우 두 검사기를 통과하고 후속 파서는 2,003개 항목을 읽는 것을 확인했다. 즉 사전 검사의 항목 수·압축 해제 크기 제한을 모든 파서 입력에 적용했다고 볼 수 없다. 대규모 압축 해제나 운영 장애는 시험하지 않았다.

공격자가 업로드 권한을 가진 경우 서버 CPU·메모리를 과도하게 쓰게 할 여지가 있다. Google 로그인으로 자신의 학급을 만드는 사용자가 다른 학급의 관리자일 필요는 없다. 개선 시 중앙 디렉터리의 바이트 범위·실제 항목 수·끝 위치·중복·누락을 일치시키고, 후속 파서가 읽는 모든 내용을 같은 예산으로 제한해야 한다. 두 검사기를 공통의 검증 모듈로 모아 같은 수정이 한쪽에서 빠지지 않도록 하는 것도 적절하다.

근거: [일괄 등록 검사](/home/haeon/workspace/projects/class-store/src/server/bulkImport/xlsxContainer.ts:67), [이전 검사](/home/haeon/workspace/projects/class-store/src/server/migration/xlsx/xlsxWorkbook.ts:62), [로컬 파서 결과](/home/haeon/.cache/crs-audit-20261007/input-probes-result.json).

### SEC-03 Excel 병합 셀의 사전 자원 제한 부족

두 Excel 경로는 `workbook.xlsx.load()`로 통합 문서를 만든 뒤 행·열·셀 수를 검사한다. ExcelJS는 이 단계에서 병합 영역의 각 셀을 먼저 생성한다. 따라서 작은 XML에 적힌 넓은 병합 범위가 최종 데이터보다 훨씬 많은 메모리를 사용할 수 있다. 현재 이전 코드는 병합된 종속 셀을 결과에서 제외하므로 최종 셀 수 검사로 이 할당량을 알 수도 없다.

6,415바이트의 작은 합성 통합 문서가 두 압축 검사기를 통과했고, 로딩 때 셀 40,000개를 만들었지만 최종 이전용 데이터는 1개 셀로 집계됐다. 해당 로컬 실행의 heap 증가는 약 25.7MiB였다. 메모리 수치는 GC·환경의 영향을 받는 단일 관측이며 운영 소비량이나 최대 공격 크기의 측정값이 아니다.

병합 범위·행·열·공유 문자열·스타일 등 객체 할당을 늘리는 요소를 **파서의 객체 생성 전** 제한해야 한다. 필요한 시트·셀만 스트리밍으로 읽거나 시간·메모리 예산이 있는 별도 처리 단위를 사용하는 방법을 검토할 수 있다. 파일 자체 용량 제한만 강화하면 압축 해제 이후의 확장을 놓친다.

근거: [일괄 등록 로더](/home/haeon/workspace/projects/class-store/src/server/bulkImport/sheetReader.ts:56), [이전 로더와 사후 제한](/home/haeon/workspace/projects/class-store/src/server/migration/xlsx/xlsxWorkbook.ts:190), [로컬 결과](/home/haeon/.cache/crs-audit-20261007/input-probes-result.json).

### SEC-04 의존성 보안 경고와 실제 사용 경로

운영 의존성 검사 결과는 **영향 패키지 8개: Critical 1, High 3, Moderate 4**다. 이 수는 앱에서 악용 가능한 독립 취약점 8건을 뜻하지 않는다. 예를 들어 ExcelJS 항목은 하위 uuid 경고가 상위 패키지에 전파된 것이다.

| 패키지와 잠금 버전 | 자동 분류 | CRS 사용 경로 판단 |
|---|---|---|
| Next.js 16.3.3 | Critical | `next/og`의 Node ImageResponse에서 공격자 입력을 SVG로 렌더링할 때 문제가 되는 공지. CRS 소스에서 해당 기능 사용은 발견하지 못함. 이 공지로 현재 CRS의 RCE가 가능하다고 판단하지 않음 |
| sharp 0.35.3 | High | 하위 이미지 처리 라이브러리 경고. CRS는 브라우저 `img`를 사용하고 직접 sharp·next/image를 호출하지 않음. 현재 악성 이미지가 서버 디코더까지 도달하는 경로 미확인 |
| brace-expansion 1.1.14 | High | 입력 패턴에 따른 자원 소모 경고. 앱의 직접 호출이나 외부 입력 연결 미확인 |
| source-map-js 1.2.1 | High | 소스맵 파싱 자원 소모 경고. CRS가 외부 사용자의 소스맵을 받아 처리하는 경로 미확인 |
| baseline-browser-mapping 2.10.31 | Moderate | 주로 브라우저 호환성·빌드 도구 경로. 앱 사용자 입력 연결 미확인 |
| qs 6.15.2 | Moderate | 하위 의존성의 입력 파싱 경고. CRS의 일반 요청 처리는 Web Request·URLSearchParams이며 직접 qs 사용 미확인 |
| uuid 8.3.2 | Moderate | 공지는 외부 버퍼를 받는 v3/v5/v6 API에 해당. 확인한 ExcelJS 호출부는 v4를 사용 |
| ExcelJS 4.4.0 | Moderate | 위 uuid 경고의 상위 전파. 자동 도구의 3.4.0 다운그레이드 제안을 그대로 적용하면 현재 가져오기 기능 호환성을 해칠 수 있음 |

Next.js의 해당 공지는 수정 버전 16.3.6, sharp의 librsvg 공지는 0.35.5를 안내한다. 추후 수정 시 호환되는 보안 패치 버전과 하위 의존성 잠금 파일을 함께 검토하고, 빌드·로그인·QR·Excel 가져오기를 검증해야 한다. `npm audit fix --force`를 일괄 적용하는 방식은 권하지 않는다. 이번에는 패키지를 변경하지 않았다.

공식 근거: [Next.js 공지](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j), [sharp 공지](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w), [uuid 공지](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq). 전체 경고·버전·연결 근거: [의존성 분석](/home/haeon/.cache/crs-audit-20261007/dependency-assessment.json).

### SEC-05부터 SEC-07까지 조건부 보완

- **SEC-05 로그인 시도 제한:** 공개 비밀번호 호환 로그인 경로에 앱 수준의 실패 횟수·속도 제한·잠금이 없다. 유효한 비밀번호 설정이 있으면 매 요청마다 검증하며, scrypt 경로는 동기식이다. 실제 비밀번호 사용 여부와 WAF 제한은 미확인이다. 유지할 기능이라면 학급·요청 출처별 제한과 지연, 비동기 해시 처리를 함께 검토한다. [로그인](/home/haeon/workspace/projects/class-store/src/app/api/admin/login/route.ts:9), [해시 검증](/home/haeon/workspace/projects/class-store/src/server/adminAuth.ts:143).
- **SEC-06 보안 헤더:** 운영에서 확인한 학급 목록·매점·은행 응답에 CSP, X-Frame-Options, X-Content-Type-Options, 명시적 Referrer-Policy가 없었다. HSTS는 적용되어 있었다. 직접 XSS나 클릭재킹 성공을 입증한 것은 아니며, 브라우저의 기본 정책과 쿠키 정책도 영향을 준다. 프레임 포함 제한, `nosniff`, 필요한 카메라 권한을 고려한 정책, CSP Report-Only 도입 순으로 검토한다. [응답 헤더 기록](/home/haeon/.cache/crs-audit-20261007/http-readonly.json), [현재 Next 설정](/home/haeon/workspace/projects/class-store/next.config.ts:3).
- **SEC-07 본문 선행 적재:** 학급 API 분배기는 일반 요청을 `arrayBuffer()`로 모두 읽은 뒤 개별 핸들러에 전달한다. 핸들러의 작은 본문 제한보다 메모리 할당이 먼저 발생한다. Vercel Functions는 요청 본문에 별도의 4.5MB 상한을 두므로 ‘운영에서 무제한 업로드 가능’으로 표현해서는 안 된다. 경로별 제한을 적재 전에 적용하고 스트림을 불필요하게 복제하지 않는 방향이 적절하다. [분배기](/home/haeon/workspace/projects/class-store/src/server/tenantApiDispatcher.ts:104), [Vercel 공식 제한](https://vercel.com/docs/functions/limitations).

### 기존에 보류한 정책

매점의 학생 번호 기반 이름·잔액 조회와 번호형 QR 결제 허용은 **사용자가 보류한 정책 항목**으로 유지한다. 이번 새 결함 수나 우선 수정 제안에 합산하지 않았으며 동작을 변경하지 않았다. 기록이 남는다는 사실과 접근 자체가 제한된다는 사실은 구분하되, 이번 검사에서 재결정을 요구하지 않는다.

## 구조와 성능 개선 항목

### PERF-01 거래 취소 연결 조회의 인덱스와 중복 검색

거래 조회는 각 거래마다 `tenant_id + reverses_transaction_id + kind=CANCELLATION` 조건의 집계 서브쿼리를 네 번 수행한다. 저장소 migration·ORM에는 transactions 테이블의 이 조건에 맞는 인덱스가 없다. 다른 테이블인 legacy_transaction_origins의 유사 인덱스로는 이를 해결할 수 없다.

커밋된 인덱스와 같은 구조를 가진 **축소된 합성 PGlite DB**에서 다음 결과를 얻었다. 실제 운영 DB·하드웨어·RLS·네트워크·상품 항목 조인은 포함하지 않았다. 각 조회 계획의 단회 측정이며 운영 응답 속도나 보장된 개선 배수가 아니다.

| 합성 조회 | 현재 인덱스 구조 | 실험용 취소 연결 인덱스 추가 후 |
|---|---:|---:|
| 관리자 전체 조회 1,000건 | 613ms | 미측정 |
| 관리자 전체 조회 5,000건 | 15,055ms | 91ms |
| 5,000건 중 학생 최근 100건 | 373ms | 2ms |

현재 구조에서는 네 개의 순차 검색이 거래 수만큼 반복됐다. 우선 실제 운영 인덱스를 읽기 전용으로 확인한 뒤, `transactions(tenant_id, reverses_transaction_id)`의 취소 거래용 부분 인덱스를 검토하는 것이 타당하다. 이어 네 집계를 한 번의 집계로 묶을 수 있다. 취소 건수 무결성 검사를 제거하거나 UNIQUE를 임의로 추가하는 방식으로 바꾸면 안 된다.

검증 기준: 별도 PostgreSQL에서 정확한 전체 스키마·RLS로 1천·5천·2만 건의 `EXPLAIN ANALYZE`, 읽은 행·블록 수, p95를 비교하고 다중 상품 구매·과거 취소의 표시를 유지한다.

근거: [거래 SQL](/home/haeon/workspace/projects/class-store/src/server/repositories/database/transactionQueries.ts:139), [스키마 인덱스](/home/haeon/workspace/projects/class-store/src/server/db/schema/ledger.ts:40), [합성 계획 기록](/home/haeon/.cache/crs-audit-20261007/transaction-plan-probe.json).

### PERF-02 관리자 거래 목록 페이지 나누기

관리자 API는 거래 전체와 각 상품 항목을 조회해 응답한다. 화면은 이를 모두 메모리에 보관하고 필터·합계·날짜별 묶음을 만든 뒤 렌더링한다. 같은 날짜의 거래를 묶는 과정에서 누적 배열을 매번 복사하는 부분도 있다. 학생 개인 거래는 최근 100건으로 제한되어 있어 관리자 경로와 다르다.

취소 인덱스만 추가해도 무제한 응답·JSON 파싱·화면 렌더링 비용은 남는다. 거래 부모 행 기준으로 50~100건의 커서 페이지를 나누고 서버의 날짜·학생 필터 및 별도 합계를 제공하는 방식이 적절하다. 상품 항목을 먼저 LIMIT하면 한 거래의 일부만 나타날 수 있으므로 부모 거래를 먼저 선택해야 한다.

검증 기준: 전체 이력이 늘어도 첫 응답의 행 수·바이트·DOM 수가 제한되는지, 같은 시각의 거래·여러 상품·페이지를 건너는 취소 연결이 정확한지 확인한다.

근거: [관리자 API](/home/haeon/workspace/projects/class-store/src/app/api/transactions/route.ts:9), [조회 범위](/home/haeon/workspace/projects/class-store/src/server/repositories/database/transactionQueries.ts:124), [화면 가공](/home/haeon/workspace/projects/class-store/src/components/TransactionsPage.tsx:149).

### PERF-03 과제 장부의 반복 전체 계산

관리자 화면이 보이는 동안 약 20초마다 과제 장부를 조회하며, 과제 외 다른 관리자 탭에서도 동작한다. 현재 상태를 만들기 위해 장부 전환 이후 누적 이벤트를 읽고 학생·과제별 상태를 계산한다. 정상적인 변경 없는 조회 경로에도 장부 초기화 여부 확인이 중복되어 **4개 DB 트랜잭션·20개 SQL 명령**이 발생한다. 인증·학급 조회는 이 수에 포함하지 않았다. 브라우저가 숨겨지거나 쓰기가 진행 중일 때 조회를 억제하는 처리는 이미 있다.

현재 도메인 함수 자체를 수정 없이 실행한 로컬 CPU 검사에서, 50개 과제·30명 기준 이벤트 15,000개는 중앙값 234ms, 150,000개는 2,257ms, 600,000개는 8,904ms였다. 각 조건 3회 측정이며 DB·네트워크·반복 초기화 계산은 제외했다. 실제 HTTP 응답 시간이 아니라 이력 증가에 따른 계산 비용의 증거다.

개선 순서는 중복 초기화 확인 제거, 같은 DB snapshot에서 현재 시각 확보, 필요한 관리자 탭에서만 조회, 변경 번호와 다음 반복 초기화 시각에 따른 무변경 조회 생략이 적절하다. 이후 검증된 현재 상태 체크포인트나 최신 이벤트 조회를 도입한다. 상태 복원에 필요한 옛 이벤트를 단순히 잘라내면 보상 취소·초기화 결과가 달라질 수 있다.

검증 기준: 조회당 SQL·이벤트 수·CPU·응답 크기와 p95를 기록하고, 반복 경계·과거 이월·취소·동시 쓰기에서 기존 상태 계산과 같은 결과를 내는지 대조한다.

근거: [조회 주기](/home/haeon/workspace/projects/class-store/src/components/tasks/ledger/useTaskBoard.ts:31), [관리자 사용 범위](/home/haeon/workspace/projects/class-store/src/components/AdminManagePage.tsx:729), [첫 초기화 확인](/home/haeon/workspace/projects/class-store/src/server/repositories/configuredTaskLedger.ts:48), [중복 확인과 조회](/home/haeon/workspace/projects/class-store/src/server/repositories/database/taskLedger/commands.ts:124), [CPU 측정](/home/haeon/.cache/crs-audit-20261007/ledger-cpu-probe.json).

### PERF-04 학생 과제 완료의 잠금 범위

은행의 과제 완료 권한 재검사에서 해당 학급의 모든 유효 과제 행을 잠근다. 서로 다른 학생이 서로 다른 과제를 완료해도 공통 과제 행의 잠금을 기다릴 수 있다. 대기하는 트랜잭션은 DB 연결도 점유하므로 여러 학급이 같은 서버 프로세스의 풀을 사용할 때 다른 요청까지 지연시킬 가능성이 있다. 실제 잠금 대기 시간은 측정하지 않았다.

대상 과제와 필요한 선행 과제를 정해진 순서로 잠그는 방향을 검토한다. 먼저 조회 비용을 줄이고, 보상·취소·과제 삭제·선행 과제 수정의 잠금 순서와 중복 지급 방지 조건을 보존해야 한다. 단순히 `FOR UPDATE`를 지우는 최적화는 적절하지 않다.

검증 기준: 실제 격리 PostgreSQL의 별도 연결에서 서로 다른 과제의 동시 진행, 같은 요청의 중복 방지, 선행 과제 수정·취소 경쟁을 검사하고 1·10·30명 동시 요청의 잠금 대기·트랜잭션 시간·연결 대기를 측정한다.

근거: [완료의 잠금 조회](/home/haeon/workspace/projects/class-store/src/server/repositories/database/taskCompletionCommands.ts:416), [과제 잠금 구현](/home/haeon/workspace/projects/class-store/src/server/repositories/database/taskLedger/store.ts:157).

### PERF-05 DB 연결 대기와 오류 처리

프로세스 공용 DB 풀과 Vercel 생명주기 연결은 이미 적용되어 있다. 그러나 앱의 Pool 생성에는 연결 문자열만 전달된다. 설치된 라이브러리 기본 연결 수는 10이며 앱에서 획득 대기 제한·일반 쿼리 및 잠금 제한을 명시하지 않는다. 실제 연결 문자열이나 DB 서버의 별도 제한은 미확인이다.

또한 사용 중인 연결의 오류 처리는 있지만, 풀에 반납된 유휴 연결의 오류를 받는 `pool.on('error')`는 앱 코드에 없다. 설치된 Vercel 연결 보조 함수도 해당 오류 리스너를 추가하지 않는다. 연결 유실 시 처리되지 않은 오류로 이어질 가능성이 있으며, 이번에 운영 장애가 발생했다는 뜻은 아니다.

연결 수를 무조건 늘리기보다 요청별 대기·쿼리·잠금 시간 예산, 자격증명을 남기지 않는 오류 처리, 연결 대기 수 측정을 추가하는 것이 우선이다. 설정값은 실제 DB 공급자의 풀 용량과 서버 인스턴스 수를 고려해야 한다.

근거: [Pool 생성](/home/haeon/workspace/projects/class-store/src/server/db/client.ts:65), [트랜잭션 오류 처리](/home/haeon/workspace/projects/class-store/src/server/db/transaction.ts:140).

### PERF-06 관리자 화면과 저장소별 코드 분리

`AdminManagePage.tsx`는 약 4,100줄로 거래·설정·프로모션·가져오기·옛 과제 UI·새 장부 UI를 함께 import한다. 실행 시 모드를 나누더라도 공통 클라이언트 import에 연결된 옛 코드가 자동으로 사라지는 것은 아니다. 큰 공통 파일은 기능 수정의 영향 범위도 넓힌다.

현재 CRS용 과제 영역부터 분리하고 처음 열지 않는 탭·대화창을 지연 로딩하는 정도가 적절하다. 옛 주기 기반 과제 코드는 초기 장부 변환에, Sheets 코드는 호환 경로에 아직 필요하므로 일괄 삭제해서는 안 된다. 서버의 Sheets/googleapis import도 실제 저장소 선택 이후로 미룰 가치가 있는지 빌드 결과로 확인한다.

이전 로컬 `.next`는 최신 배포 산출물임이 입증되지 않아 그 크기를 현재 운영 번들 수치로 보고하지 않는다. 추후 동일 후보의 새 빌드에서 다운로드·파싱·상호작용 시간을 측정하고, 편집 중 값·포커스·저장 충돌 처리가 유지되는지 검증해야 한다.

근거: [관리자 import](/home/haeon/workspace/projects/class-store/src/components/AdminManagePage.tsx:3), [저장소별 의존성](/home/haeon/workspace/projects/class-store/src/server/repositories/configuredTasks.ts:5).

### PERF-07 검사 실행 구조

기본 `npm test`는 일반 Vitest 수집을 사용해 하네스의 자식 실행 파일까지 포함할 수 있다. 이미 존재하는 `release-unit.config.mts`는 애플리케이션 코드만 수집하고 환경 파일을 읽지 않지만 기본 npm 명령과 연결되어 있지 않다. 서버 검사 중 상당수도 기본 jsdom 환경을 상속하며, 일부 DB 검사는 매 사례마다 전체 스키마를 새로 만든다.

애플리케이션·브라우저·네이티브 DB 검사의 진입점을 명확히 나누고, setup 비용을 측정한 뒤 격리를 해치지 않는 부분만 재사용한다. 새로운 테스트를 줄이거나 건너뛴 검사를 합격으로 세는 방식은 최적화가 아니다. 실제 다중 학급 부하는 네이티브 동시성 검사로 따로 측정해야 한다.

근거: [기본 명령](/home/haeon/workspace/projects/class-store/package.json:11), [기본 환경](/home/haeon/workspace/projects/class-store/vitest.config.mts:10), [애플리케이션 전용 설정](/home/haeon/workspace/projects/class-store/test-support/release-unit.config.mts:4).

추가 관찰로, 새 과제 번호는 현재 최대값을 읽고 증가시키므로 동시 생성 두 요청이 같은 번호를 고를 가능성이 있다. DB의 고유 제약이 중복 저장을 막지만 한 요청이 실패할 수 있다. 이번에는 동시 재현하지 않았으므로 확정 결함 목록과 분리한다. [번호 생성](/home/haeon/workspace/projects/class-store/src/server/repositories/database/taskLedger/commands.ts:251).

## 유지할 보호 장치

코드와 제한된 검사에서 다음 보호 장치를 확인했다. 최적화할 때 이 경계를 보존해야 한다.

- 학급은 요청 URL과 DB directory로 선택하고, Google 로그인으로 확인하는 관리자 권한은 현재 Google subject·학급 membership과 연결한다.
- DB 작업은 트랜잭션 내부 tenant context를 설정하며, 저장소 스키마는 FORCE RLS와 학급을 포함한 외래 키를 사용한다. 이번 검사가 운영 DB 권한의 재인증을 대신하지는 않는다.
- 금액 변경에 요청 번호·내용 지문·저장 결과를 사용하며, 불확실한 재시도에서 중복 지급을 막는 구조가 있다.
- 개인 은행은 학급별 학생 세션을 사용하고 응답에 `private, no-store`를 적용한다. 운영의 비인증 학생 목록 및 개인 거래 요청은 401이었다.
- 주로 바인딩된 SQL과 React 텍스트 렌더링을 사용한다. 검토한 제품 코드에서 `dangerouslySetInnerHTML` 사용은 찾지 못했다.
- Padlet 서버 요청은 고정 API 호스트와 인코딩된 식별자를 사용하며 리다이렉트를 거부한다. 상품 이미지 URL은 브라우저에서 읽는다. 이 경로들에서 서버의 임의 URL 요청은 확인하지 못했다.

## 권장 작업 순서

1. **보안 경계 보완:** SEC-01 로그아웃과 SEC-02·03 Excel 입력 제한을 각각 작은 변경으로 수정하고 해당 회귀 검사를 추가한다. 호환 비밀번호를 유지할지에 맞춰 시도 제한도 검토한다.
2. **의존성 패치:** 실제 사용 경로를 고려해 호환 패치를 적용하고 로그인·QR·가져오기·빌드를 검증한다. 자동 분류 Critical과 현재 서비스에서 확인된 공격 가능성을 혼동하지 않는다.
3. **거래 조회 개선:** 실제 인덱스를 확인한 뒤 취소 연결 인덱스와 관리자 페이지 나누기를 먼저 적용한다.
4. **과제 조회·동시성 개선:** 중복 조회 제거 → 변경 없는 전체 계산 생략 → 검증된 상태 조회 개선 → 잠금 범위 축소 순으로 진행한다.
5. **구조·운영 관측 개선:** Pool 시간 예산·오류 처리, 관리자 화면 분리, 테스트 진입점 정리를 진행하고 다중 학급의 p95·잠금 대기·오류율·원장 정합성을 측정한다.

학생 번호 조회 공개 범위는 기존 보류 결정을 유지한다. 이 순서는 제안이며 이번 검사에서 구현하거나 배포하지 않았다.

## 보관한 근거

- [배포 메타데이터](/home/haeon/.cache/crs-audit-20261007/deployment-metadata.json), [운영 주소 연결](/home/haeon/.cache/crs-audit-20261007/alias-binding.json), [소스 대조](/home/haeon/.cache/crs-audit-20261007/source-comparison.json)
- [인증 검토](/home/haeon/.cache/crs-audit-20261007/auth-findings.json), [입력 검토](/home/haeon/.cache/crs-audit-20261007/input-findings-reviewed.json), [성능·구조 검토](/home/haeon/.cache/crs-audit-20261007/performance-findings.json)
- [의존성 원본 검사](/home/haeon/.cache/crs-audit-20261007/npm-audit-production.json), [공개 응답 헤더](/home/haeon/.cache/crs-audit-20261007/http-readonly.json)

근거 파일은 로컬 제한 디렉터리에 보관하며 실학생 정보·운영 인증값을 보고서에 넣지 않았다. 이번 보고서는 현재 확인한 결함과 개선 지점을 기록한 것으로, 과거 A–F 수용을 재판정하거나 전체 회귀 검사 통과를 새로 선언하는 문서가 아니다.

## 후속 패치

이 문서는 수정 전 점검 기록이다. 수정 사항과 검증·배포 상태는 [CRS 보안 및 성능 패치 결과](2026-10-07-crs-security-performance-patch.md)에 기록한다.
