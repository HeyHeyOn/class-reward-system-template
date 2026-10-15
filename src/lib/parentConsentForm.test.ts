import { describe, expect, it } from 'vitest';
import { BLANK, buildParentConsentForm, consentFormFileName, documentPlainText, type DocumentBlock } from './parentConsentForm';

const FILLED = { schoolName: '햇살초등학교', classLabel: '5학년 2반', teacherName: '김하늘', dueDate: '3월 15일' };

function blocksOf<K extends DocumentBlock['kind']>(kind: K, input = {}) {
  return buildParentConsentForm(input).blocks.filter((block): block is Extract<DocumentBlock, { kind: K }> => block.kind === kind);
}

describe('buildParentConsentForm', () => {
  it('titles the form for the legal representative', () => {
    const doc = buildParentConsentForm({});
    expect(doc.title).toBe('「딴쌤 클래스」 이용을 위한 학생 개인정보 수집·이용 동의서');
    expect(doc.subtitle).toBe('(법정대리인용)');
  });

  it('holds every section, table and consent question in order', () => {
    const text = documentPlainText(buildParentConsentForm(FILLED));
    const expected = [
      '「개인정보 보호법」 제22조의2에 따라 만 14세 미만 학생의 개인정보를 처리하려면 법정대리인의 동의가 필요합니다.',
      '1. 개인정보 수집·이용 (필수 항목을 실명으로 쓰기 위한 동의)',
      '구분 | 내용',
      '수집과 이용 목적 | 학급 경제 활동 운영(학급 화폐 지급과 사용, 매점 구매, 은행 잔액 확인, 과제 완료 확인, 펫과 나무 키우기, 보관함)과 학생 본인 확인(학생 QR 코드 로그인)',
      '수집 항목 | 학년과 반, 번호, 이름 / 서비스를 이용하면서 생기는 정보: 학급 화폐 잔액, 지급과 사용 기록, 과제 완료 기록, 학생이 직접 지은 펫 이름, 펫과 나무 키우기 기록, 보관함 기록, 접속 기록',
      '(장애 복구용 백업에는 최대 7일 동안 남을 수 있습니다.)',
      '동의 거부 권리와 불이익 | 동의를 거부할 수 있습니다.',
      '위와 같이 개인정보를 수집·이용하는 데 동의하십니까?   □ 동의합니다   □ 동의하지 않습니다',
      '2. 개인정보 처리 위탁 안내',
      '딴쌤 클래스 운영자(환잇쌤) | 서비스 운영, 학생 정보 저장·관리',
      'Vercel Inc. | 웹 서비스 호스팅과 서버 운영',
      'Neon, LLC | 데이터베이스 저장과 운영',
      '3. 개인정보 국외 이전 (「개인정보 보호법」 제28조의8)',
      '이전받는 자(연락처) | 이전 국가 | 이전 항목 | 이전 목적과 방법 | 보유 기간',
      'Vercel Inc. (privacy@vercel.com) | 싱가포르, 미국 | 1번의 모든 항목 | 웹 서비스 호스팅 / 서비스를 이용할 때마다 암호화된 네트워크로 전송 | 1번의 보유·이용 기간과 같음',
      'Neon, LLC (privacy@databricks.com) | 싱가포르, 미국 | 1번의 항목 중 접속 기록을 뺀 항목 | 데이터베이스 저장 / 서비스를 이용할 때마다 암호화된 네트워크로 전송 | 1번의 보유·이용 기간과 같음',
      '국외 이전을 거부할 수 있으며, 거부하면 학생은 실명 대신 별명과 임의 번호로 참여하고 불이익은 없습니다.',
      '위와 같이 개인정보를 국외로 이전하는 데 동의하십니까?   □ 동의합니다   □ 동의하지 않습니다',
      '4. 법정대리인의 권리',
      '딴쌤 클래스 개인정보처리방침(https://class.ddanssaem.com/privacy)에서 확인할 수 있습니다.',
      '학생   ____학년 ____반 ____번   이름 ____________',
      '법정대리인   이름 ____________   (학생과의 관계: ________)   서명 ____________',
      '20____년 ____월 ____일',
    ];
    let from = 0;
    for (const part of expected) {
      const at = text.indexOf(part, from);
      expect(at, part).toBeGreaterThanOrEqual(0);
      from = at + part.length;
    }
    expect(blocksOf('consent')).toHaveLength(2);
    expect(blocksOf('table').map((table) => table.rows.length)).toEqual([4, 3, 2]);
    expect(blocksOf('table')[0].rowLabels).toBe(true);
  });

  it('fills in the school, class, teacher and due date', () => {
    const doc = buildParentConsentForm(FILLED);
    const text = documentPlainText(doc);
    expect(text).toContain('햇살초등학교 5학년 2반에서는 학급 경제 활동(학급 화폐·매점·은행·과제)을 운영하기 위해 온라인 서비스 「딴쌤 클래스」를 사용합니다.');
    expect(text).toContain('※ 3월 15일까지 담임교사에게 제출해 주세요.');
    expect(doc.blocks.find((block) => block.kind === 'signature')).toMatchObject({ addressee: '햇살초등학교 5학년 2반 담임교사 김하늘 귀하' });
    expect(text.split('\n').filter((line) => line.includes(BLANK))).toEqual([
      '학생   ____학년 ____반 ____번   이름 ____________',
      '법정대리인   이름 ____________   (학생과의 관계: ________)   서명 ____________',
    ]);
    // The due date note comes right after the introduction.
    expect(doc.blocks[1]).toEqual({ kind: 'paragraph', text: '※ 3월 15일까지 담임교사에게 제출해 주세요.', bold: true });
  });

  it('leaves blanks to fill in by hand for what was not given, and no due date note', () => {
    const doc = buildParentConsentForm({ schoolName: '  ', classLabel: '', teacherName: undefined, dueDate: ' ' });
    const text = documentPlainText(doc);
    expect(text).toContain(`${BLANK} ${BLANK}에서는 학급 경제 활동`);
    expect(text).toContain(`${BLANK} ${BLANK} 담임교사 ${BLANK} 귀하`);
    expect(text).not.toContain('※');
    expect(text).not.toContain('제출해 주세요');
  });

  it('tidies the inputs', () => {
    const text = documentPlainText(buildParentConsentForm({ schoolName: ' 햇살  초등학교 ', classLabel: '5학년\n2반', dueDate: '3월 15일까지 ' }));
    expect(text).toContain('햇살 초등학교 5학년 2반에서는');
    expect(text).toContain('※ 3월 15일까지 담임교사에게 제출해 주세요.');
    expect(text).toContain(`햇살 초등학교 5학년 2반 담임교사 ${BLANK} 귀하`);
  });
});

describe('consentFormFileName', () => {
  it('names the file after the class', () => {
    expect(consentFormFileName('5학년 2반')).toBe('5학년 2반-개인정보 수집·이용 동의서.pdf');
    expect(consentFormFileName('  ')).toBe('학급-개인정보 수집·이용 동의서.pdf');
  });

  it('replaces characters that file systems refuse', () => {
    const name = consentFormFileName('5/2반: "별"');
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name).toBe('5-2반- -별--개인정보 수집·이용 동의서.pdf');
  });
});
