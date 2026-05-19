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

## 주요 문서

- `docs/plans/2026-05-19-class-store-project-plan.md`
- `docs/sheets-template.md`
- `templates/students.csv`
- `templates/products.csv`

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

1. Google Sheets 서비스 계정/시트 ID 연결
2. Students/Products 시트 읽기 Repository 구현
3. Checkout API 구현
4. QR 스캔 컴포넌트 연결
5. 실제 시트 데이터로 키오스크 UI 연결

## 구현 전 결정 필요

1. 실제 Google Sheets를 새로 만들지, 관리자님 기존 시트를 쓸지
2. 서비스 계정 키를 새로 발급할지
3. 배포 방식: 로컬 PC / Vercel / 태블릿 전용 접속
