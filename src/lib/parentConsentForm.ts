// The parent (법정대리인) consent form a teacher prints and sends home before entering students'
// real 학년·반, 번호 and 이름. Pure content: `documentCanvas.ts` lays it out on A4 pages.
// Runs of underscores ("____") are blanks to fill in by hand; the renderer draws them as lines.

export type ParentConsentFormInput = Readonly<{
  schoolName?: string;
  /** e.g. "5학년 2반". */
  classLabel?: string;
  teacherName?: string;
  /** Free text, e.g. "3월 15일". */
  dueDate?: string;
}>;

export type DocumentTable = Readonly<{
  kind: 'table';
  header: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
  /** The first column labels each row (bold, shaded). */
  rowLabels?: boolean;
}>;

export type DocumentBlock =
  | Readonly<{ kind: 'heading'; text: string }>
  | Readonly<{ kind: 'paragraph'; text: string; bold?: boolean }>
  | DocumentTable
  /** A question answered by ticking one box. */
  | Readonly<{ kind: 'consent'; question: string; options: readonly string[] }>
  | Readonly<{
    kind: 'signature';
    /** Filled in by hand, inside a box. */
    lines: readonly string[];
    /** Right-aligned under the lines. */
    date: string;
    /** The recipient, under the box ("… 귀하"). */
    addressee: string;
  }>;

export type ConsentFormDocument = Readonly<{
  title: string;
  subtitle?: string;
  blocks: readonly DocumentBlock[];
}>;

/** Printed where an input was left empty, to be filled in by hand. */
export const BLANK = '__________';

export const CONSENT_FORM_TITLE = '개인정보 수집·이용 동의서';

const AGREE_OPTIONS = Object.freeze(['동의합니다', '동의하지 않습니다']);

function filled(value: string | undefined) {
  return value?.replace(/\s+/g, ' ').trim() || BLANK;
}

/** "3월 15일" and "3월 15일까지" both become "3월 15일". */
function dueDateText(value: string | undefined) {
  return value?.replace(/\s+/g, ' ').trim().replace(/\s*까지$/, '') ?? '';
}

export function buildParentConsentForm(input: ParentConsentFormInput): ConsentFormDocument {
  const school = filled(input.schoolName);
  const classLabel = filled(input.classLabel);
  const teacher = filled(input.teacherName);
  const due = dueDateText(input.dueDate);

  const blocks: DocumentBlock[] = [
    {
      kind: 'paragraph',
      text: `${school} ${classLabel}에서는 학급 경제 활동(학급 화폐·매점·은행·과제)을 운영하기 위해 온라인 서비스 「딴쌤 클래스」를 사용합니다. 「개인정보 보호법」 제22조의2에 따라 만 14세 미만 학생의 개인정보를 처리하려면 법정대리인의 동의가 필요합니다. 아래 내용을 읽고 동의 여부를 표시한 뒤 서명해 주시기 바랍니다.`,
    },
  ];
  if (due) blocks.push({ kind: 'paragraph', text: `※ ${due}까지 담임교사에게 제출해 주세요.`, bold: true });

  blocks.push(
    { kind: 'heading', text: '1. 개인정보 수집·이용 (필수 항목을 실명으로 쓰기 위한 동의)' },
    {
      kind: 'table',
      rowLabels: true,
      header: ['구분', '내용'],
      rows: [
        ['수집·이용 목적', '학급 경제 활동 운영(학급 화폐 지급·사용, 매점 구매, 은행 잔액 확인, 과제 완료 확인)과 학생 본인 확인(학생 QR 코드 로그인)'],
        ['수집 항목', '학년·반, 번호, 이름 / 서비스를 이용하면서 생기는 정보: 학급 화폐 잔액과 지급·사용 기록, 과제 완료 기록, 접속 기록'],
        ['보유·이용 기간', '해당 학년도 학급 운영이 끝날 때까지 보유하며, 이후 담임교사가 학급을 삭제하면 지체 없이 파기합니다. (장애 복구용 백업에는 최대 7일 동안 남을 수 있습니다.)'],
        ['동의 거부 권리와 불이익', '동의를 거부할 수 있습니다. 거부하더라도 학생은 실명 대신 별명과 임의 번호로 학급 활동에 똑같이 참여할 수 있으며, 불이익은 없습니다.'],
      ],
    },
    { kind: 'consent', question: '위와 같이 개인정보를 수집·이용하는 데 동의하십니까?', options: AGREE_OPTIONS },

    { kind: 'heading', text: '2. 개인정보 처리 위탁 안내' },
    { kind: 'paragraph', text: '담임교사는 서비스 제공을 위해 딴쌤 클래스 운영자에게 개인정보 처리를 맡기며, 운영자는 서버 운영을 위해 아래 업체에 다시 맡깁니다.' },
    {
      kind: 'table',
      header: ['위탁받는 자', '위탁 업무'],
      rows: [
        ['딴쌤 클래스 운영자(환잇쌤)', '서비스 운영, 학생 정보 저장·관리'],
        ['Vercel Inc.', '웹 서비스 호스팅과 서버 운영'],
        ['Neon, LLC', '데이터베이스 저장과 운영'],
      ],
    },

    { kind: 'heading', text: '3. 개인정보 국외 이전 (「개인정보 보호법」 제28조의8)' },
    {
      kind: 'table',
      header: ['이전받는 자(연락처)', '이전 국가', '이전 항목', '이전 목적과 방법', '보유 기간'],
      rows: [
        ['Vercel Inc. (privacy@vercel.com)', '싱가포르, 미국', '1번의 모든 항목', '웹 서비스 호스팅 / 서비스를 이용할 때마다 암호화된 네트워크로 전송', '1번의 보유·이용 기간과 같음'],
        ['Neon, LLC (privacy@databricks.com)', '싱가포르, 미국', '1번의 항목 중 접속 기록을 뺀 항목', '데이터베이스 저장 / 서비스를 이용할 때마다 암호화된 네트워크로 전송', '1번의 보유·이용 기간과 같음'],
      ],
    },
    { kind: 'paragraph', text: '국외 이전을 거부할 수 있으며, 거부하면 학생은 실명 대신 별명과 임의 번호로 참여하고 불이익은 없습니다.' },
    { kind: 'consent', question: '위와 같이 개인정보를 국외로 이전하는 데 동의하십니까?', options: AGREE_OPTIONS },

    { kind: 'heading', text: '4. 법정대리인의 권리' },
    { kind: 'paragraph', text: '법정대리인은 언제든지 담임교사에게 학생 개인정보의 열람·정정·삭제·처리 정지를 요구하거나 동의를 철회할 수 있습니다. 자세한 내용은 딴쌤 클래스 개인정보처리방침(https://class.ddanssaem.com/privacy)에서 확인할 수 있습니다.' },

    {
      kind: 'signature',
      lines: [
        '학생   ____학년 ____반 ____번   이름 ____________',
        '법정대리인   이름 ____________   (학생과의 관계: ________)   서명 ____________',
      ],
      date: '20____년 ____월 ____일',
      addressee: `${school} ${classLabel} 담임교사 ${teacher} 귀하`,
    },
  );

  return {
    title: `「딴쌤 클래스」 이용을 위한 학생 ${CONSENT_FORM_TITLE}`,
    subtitle: '(법정대리인용)',
    blocks,
  };
}

/** The whole form as plain text, one line per paragraph, table row or signature line. */
export function documentPlainText(doc: ConsentFormDocument): string {
  const lines = [doc.title];
  if (doc.subtitle) lines.push(doc.subtitle);
  for (const block of doc.blocks) {
    switch (block.kind) {
      case 'heading':
      case 'paragraph':
        lines.push(block.text);
        break;
      case 'table':
        lines.push(block.header.join(' | '), ...block.rows.map((row) => row.join(' | ')));
        break;
      case 'consent':
        lines.push([block.question, ...block.options.map((option) => `□ ${option}`)].join('   '));
        break;
      case 'signature':
        lines.push(...block.lines, block.date, block.addressee);
        break;
    }
  }
  return lines.join('\n');
}

/** e.g. "5학년 2반-개인정보 수집·이용 동의서.pdf"; characters that file systems refuse become "-". */
export function consentFormFileName(classLabel: string) {
  const safe = classLabel.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim();
  return `${safe || '학급'}-${CONSENT_FORM_TITLE}.pdf`;
}
