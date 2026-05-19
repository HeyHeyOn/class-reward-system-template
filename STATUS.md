# 학급 매점 프로젝트 상태

**최근 업데이트:** 2026-05-19

## 개요

초등학교 학급에서 학급 화폐 기반 매점을 운영하기 위한 키오스크형 웹 앱 프로젝트.

## 현재 단계

- 기획/설계 완료
- Next.js 16 + TypeScript + Tailwind 프로젝트 초기화 완료
- Google Sheets 템플릿 CSV와 환경변수 샘플 작성 완료
- 결제 미리보기 순수 로직 TDD 구현 완료
- 초기 키오스크 랜딩 UI 작성 완료
- 저장된 시트 ID를 Google Sheets API 클라이언트에서 사용하는 구조 구현 완료
- Students/Products 시트 읽기 Repository 구현 완료
- 학생 조회 API와 상품 목록 API 구현 완료
- 결제 API 구현 완료: 잔액 차감, 재고 차감, Transactions 로그 append

## 주요 문서

- `docs/plans/2026-05-19-class-store-project-plan.md`
- `docs/sheets-template.md`
- `docs/admin-settings.md`
- `templates/students.csv`
- `templates/products.csv`

## 설정 방식

- 기본: `/admin/settings` 화면에서 Google Sheets 주소 또는 시트 ID 입력
- 저장 위치: `data/settings.json` — Git 제외
- fallback: `.env.local`의 `GOOGLE_SHEET_ID`

## 검증 상태

- `npm test`: 통과
- `npm run lint`: 통과
- `npm run build`: 통과

## 권장 MVP

- Next.js 웹앱
- Google Sheets 연동
- QR 스캔
- 학생 잔액 조회
- 상품 목록/장바구니
- 결제 시 잔액/재고 차감
- 거래 로그 기록
- 간단한 관리자 PIN

## 다음 작업

1. 실제 서비스 계정 키 설정 후 라이브 읽기/결제 테스트
2. QR 스캔 컴포넌트 연결
3. 실제 시트 데이터로 키오스크 UI 연결
4. 중복 결제 방지 UX 강화

## 구현 전 결정 필요

1. 서비스 계정 키를 새로 발급할지
2. 배포 방식: 로컬 PC / Vercel / 태블릿 전용 접속
