// Versions of the terms of service and the privacy policy that teachers agree to.
//
// To change either document: edit it, then add a revision here with its effective time and a short
// list of what changed. Before that time, signed-in teachers see a notice of the coming change
// (the law asks for notice in advance: 7 days, or 30 days for changes against the user); from that
// time on, they must agree again (or withdraw) before they keep using the service.

export type LegalRevision = Readonly<{
  /** YYYY-MM-DD; stored with each agreement. Later revisions sort later. */
  version: string;
  /** When the revision takes effect (Korea time). */
  effectiveAt: string;
  /** For people: e.g. 2026년 10월 8일. */
  effectiveLabel: string;
  changes: readonly string[];
}>;

export const LEGAL_REVISIONS: readonly LegalRevision[] = [
  {
    version: '2026-10-08',
    effectiveAt: '2026-10-08T00:00:00+09:00',
    effectiveLabel: '2026년 10월 8일',
    changes: [
      '이용약관을 새로 마련했어요.',
      '개인정보처리방침에 가입 동의 기록, 프로필(닉네임·프로필 아이콘), 회원 탈퇴 시 처리, 학생 개인정보를 위한 법정대리인 동의에 관한 내용을 더했어요.',
    ],
  },
  {
    version: '2026-10-18',
    effectiveAt: '2026-10-18T00:00:00+09:00',
    effectiveLabel: '2026년 10월 18일',
    changes: [
      '탈퇴 시 학생 정보가 포함된 거래·과제·성장·보관함 기록과 이전 원본 자료를 함께 파기하는 절차를 명확히 했어요.',
      '탈퇴 처리 사실과 폐기된 로그인·중복 보상 방지를 위한 보안용 식별자 해시의 보유 범위를 명시했어요.',
      '서비스 이름을 ‘학급 보상 시스템’에서 ‘딴쌤 클래스’로 바꿨어요.',
    ],
  },
];

function effectiveTime(revision: LegalRevision) {
  return Date.parse(revision.effectiveAt);
}

/** The revision in force now: the latest one whose effective time has come. */
export function currentLegalRevision(now: number = Date.now(), revisions: readonly LegalRevision[] = LEGAL_REVISIONS): LegalRevision {
  const inForce = revisions.filter((revision) => effectiveTime(revision) <= now);
  return inForce.at(-1) ?? revisions[0];
}

/** The next revision announced but not yet in force, for the advance notice. */
export function upcomingLegalRevision(now: number = Date.now(), revisions: readonly LegalRevision[] = LEGAL_REVISIONS): LegalRevision | null {
  return revisions.find((revision) => effectiveTime(revision) > now) ?? null;
}

/** What changed since the version a teacher agreed to (everything, if they never agreed). */
export function revisionsSince(agreedVersion: string | undefined, now: number = Date.now(), revisions: readonly LegalRevision[] = LEGAL_REVISIONS): LegalRevision[] {
  const current = currentLegalRevision(now, revisions);
  return revisions.filter((revision) => (!agreedVersion || revision.version > agreedVersion) && revision.version <= current.version);
}

export const LEGAL_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
