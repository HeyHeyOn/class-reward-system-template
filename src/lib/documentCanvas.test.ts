import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_FONTS,
  DOCUMENT_PAGE,
  layoutBlocks,
  measureLine,
  parentConsentFormPdf,
  renderDocumentPages,
  textSegments,
  wrapText,
  type DrawOp,
  type FontSpec,
  type MeasureText,
  type PageGeometry,
} from './documentCanvas';
import { buildParentConsentForm, documentPlainText, type ConsentFormDocument } from './parentConsentForm';

/** Hangul and other wide characters 1em, spaces 0.3em, everything else 0.55em; bold 5% wider. */
const measure: MeasureText = (text, font) => {
  let ems = 0;
  for (const char of text) ems += char === ' ' ? 0.3 : char.codePointAt(0)! >= 0x1100 ? 1 : 0.55;
  return ems * font.size * (font.weight >= 700 ? 1.05 : 1);
};

const FONT: FontSpec = { size: 10, weight: 400 };
const words = (text: string) => text.split(/\s+/).filter(Boolean);
const texts = (ops: readonly DrawOp[]) => ops.flatMap((op) => (op.kind === 'text' ? [op] : []));
const rects = (ops: readonly DrawOp[]) => ops.flatMap((op) => (op.kind === 'rect' ? [op] : []));

function expectWithinPage(pages: DrawOp[][], page: PageGeometry) {
  const bottom = page.height - page.marginBottom;
  pages.forEach((ops, index) => {
    for (const op of ops) {
      const isPageNumber = op.kind === 'text' && op.text === `${index + 1} / ${pages.length}`;
      if (isPageNumber) continue;
      const left = op.x;
      const right = op.x + op.width;
      const top = op.kind === 'text' ? op.y - op.font.size / 2 : op.y;
      const end = op.kind === 'text' ? op.y + op.font.size / 2 : op.y + op.height;
      expect(left, JSON.stringify(op)).toBeGreaterThanOrEqual(page.marginX - 0.01);
      expect(right, JSON.stringify(op)).toBeLessThanOrEqual(page.width - page.marginX + 0.01);
      expect(top, JSON.stringify(op)).toBeGreaterThanOrEqual(page.marginTop - 0.01);
      expect(end, JSON.stringify(op)).toBeLessThanOrEqual(bottom + 0.01);
    }
  });
}

describe('wrapText', () => {
  it('keeps text that fits on one line as it is, spaces included', () => {
    expect(wrapText('학생   이름', 100, FONT, measure)).toEqual(['학생   이름']);
  });

  it('breaks at spaces and never makes a line wider than allowed', () => {
    const text = '학급 경제 활동 운영과 학생 본인 확인을 위해 개인정보를 수집합니다';
    const lines = wrapText(text, 75, FONT, measure);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(measure(line, FONT)).toBeLessThanOrEqual(75);
    expect(lines.flatMap(words)).toEqual(words(text));
    // Each line is as full as it can be: the next word would not have fit.
    lines.slice(0, -1).forEach((line, index) => {
      expect(measure(`${line} ${words(lines[index + 1])[0]}`, FONT)).toBeGreaterThan(75);
    });
  });

  it('breaks inside a word only when the word alone is wider than a line', () => {
    expect(wrapText('가 나다라마바사아자차', 35, FONT, measure)).toEqual(['가', '나다라', '마바사', '아자차']);
    expect(wrapText('(privacy@databricks.com)', 80, FONT, measure).join('')).toBe('(privacy@databricks.com)');
    expect(wrapText('가나 다라', 30, FONT, measure)).toEqual(['가나', '다라']);
  });

  it('starts a new line at "\\n"', () => {
    expect(wrapText('학년·반\n이름', 500, FONT, measure)).toEqual(['학년·반', '이름']);
  });

  it('measures blanks at a fixed width whatever the font', () => {
    expect(textSegments('20____년 ____월')).toEqual([
      { text: '20', blank: false }, { text: '____', blank: true }, { text: '년 ', blank: false }, { text: '____', blank: true }, { text: '월', blank: false },
    ]);
    expect(measureLine('__________', FONT, () => 999)).toBeCloseTo(10 * 0.6 * FONT.size);
    expect(textSegments('a_b')).toEqual([{ text: 'a_b', blank: false }]);
  });
});

describe('layoutBlocks', () => {
  const doc = buildParentConsentForm({ schoolName: '햇살초등학교', classLabel: '5학년 2반', teacherName: '김하늘', dueDate: '3월 15일' });
  const pages = layoutBlocks(doc, measure);

  it('fits the consent form on one or two A4 pages, inside the margins, numbered when two', () => {
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages.length).toBeLessThanOrEqual(2);
    expectWithinPage(pages, DOCUMENT_PAGE);
    if (pages.length === 2) {
      expect(texts(pages[0]).at(-1)!.text).toBe('1 / 2');
      expect(texts(pages[1]).at(-1)!.text).toBe('2 / 2');
    }
  });

  it('draws every word of the form, in order, starting with the title and ending with the addressee', () => {
    const drawn = pages.flatMap(texts).map((op) => op.text).filter((text) => !/^\d \/ \d$/.test(text));
    const source = documentPlainText(doc).replace(/[□|]/g, ' ');
    expect(drawn.flatMap(words)).toEqual(words(source));
    expect(texts(pages[0])[0]).toMatchObject({ text: doc.title, font: DOCUMENT_FONTS.title });
    expect(drawn.at(-1)).toBe('햇살초등학교 5학년 2반 담임교사 김하늘 귀하');
  });

  it('keeps body text at a readable print size', () => {
    const pt = (font: FontSpec) => font.size * 72 / 200;
    expect(pt(DOCUMENT_FONTS.body)).toBeGreaterThanOrEqual(10);
    expect(pt(DOCUMENT_FONTS.body)).toBeLessThanOrEqual(10.5);
    for (const op of pages.flatMap(texts)) expect(pt(op.font)).toBeGreaterThanOrEqual(9);
  });

  it('draws two tick boxes for each consent question', () => {
    const boxes = pages.flatMap(rects).filter((rect) => rect.width === rect.height && rect.width < 40);
    expect(boxes).toHaveLength(4);
    const labels = pages.flatMap(texts).filter((op) => op.text === '동의합니다' || op.text === '동의하지 않습니다');
    expect(labels.map((op) => op.text)).toEqual(['동의합니다', '동의하지 않습니다', '동의합니다', '동의하지 않습니다']);
  });

  it('wraps long table cells inside their column', () => {
    const cellRects = pages.flatMap(rects).filter((rect) => rect.stroke && rect.width < DOCUMENT_PAGE.width - DOCUMENT_PAGE.marginX * 2);
    const purpose = pages.flatMap(texts).filter((op) => op.font === DOCUMENT_FONTS.cell && op.text.startsWith('학급 경제 활동 운영'));
    expect(purpose).toHaveLength(1);
    const cell = cellRects.find((rect) => rect.x <= purpose[0].x && purpose[0].x < rect.x + rect.width && rect.y <= purpose[0].y && purpose[0].y < rect.y + rect.height)!;
    expect(cell).toBeTruthy();
    for (const op of pages.flatMap(texts).filter((text) => text.y > cell.y && text.y < cell.y + cell.height && text.x > cell.x && text.x < cell.x + cell.width)) {
      expect(op.x + op.width).toBeLessThanOrEqual(cell.x + cell.width);
    }
  });
});

describe('layoutBlocks pagination', () => {
  const small: PageGeometry = { width: 1000, height: 1200, marginX: 100, marginTop: 100, marginBottom: 100 };
  const bottom = small.height - small.marginBottom;

  it('never splits a table row and repeats the header row on the next page', () => {
    const rows = Array.from({ length: 30 }, (_, index) => [`항목 ${index + 1}`, `내용 ${index + 1} `.repeat(index % 4 === 0 ? 12 : 1).trim()]);
    const doc: ConsentFormDocument = { title: '긴 표', blocks: [{ kind: 'table', header: ['구분', '내용'], rows }] };
    const pages = layoutBlocks(doc, measure, small);

    expect(pages.length).toBeGreaterThan(1);
    expectWithinPage(pages, small);
    for (const rect of pages.flatMap(rects)) expect(rect.y + rect.height).toBeLessThanOrEqual(bottom);
    pages.slice(1).forEach((ops) => {
      const [first, second] = texts(ops);
      expect([first.text, second.text]).toEqual(['구분', '내용']);
      expect(first.font).toBe(DOCUMENT_FONTS.cellBold);
    });
    const labels = pages.flatMap(texts).map((op) => op.text).filter((text) => text.startsWith('항목 '));
    expect(labels).toEqual(rows.map(([label]) => label));
  });

  // Grows the text above until the block in question would sit at the foot of the first page.
  const lead = (words: number) => '학급 경제 활동을 운영합니다'.split(' ').concat(Array(words).fill('운영')).join(' ');
  const pageOf = (pages: DrawOp[][], text: string) => pages.findIndex((ops) => texts(ops).some((op) => op.text === text));

  it('moves a heading to the next page with what follows it', () => {
    let moved = 0;
    for (let count = 100; count < 400; count += 3) {
      const doc: ConsentFormDocument = {
        title: '제목',
        blocks: [
          { kind: 'paragraph', text: lead(count) },
          { kind: 'heading', text: '2. 다음 절' },
          { kind: 'paragraph', text: '다음 절의 첫 문단' },
        ],
      };
      const pages = layoutBlocks(doc, measure, small);
      expect(pageOf(pages, '2. 다음 절')).toBe(pageOf(pages, '다음 절의 첫 문단'));
      if (pageOf(pages, '2. 다음 절') === 1) {
        moved += 1;
        expect(texts(pages[1])[0].text).toBe('2. 다음 절');
      }
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('keeps a short table whole, and a consent question on the page of the table it answers', () => {
    let moved = 0;
    for (let count = 100; count < 400; count += 3) {
      const doc: ConsentFormDocument = {
        title: '제목',
        blocks: [
          { kind: 'paragraph', text: lead(count) },
          { kind: 'table', header: ['구분', '내용'], rows: [['목적', '학급 운영'], ['항목', '이름']] },
          { kind: 'consent', question: '동의하십니까?', options: ['동의합니다', '동의하지 않습니다'] },
        ],
      };
      const pages = layoutBlocks(doc, measure, small);
      const consentPage = pageOf(pages, '동의하십니까?');
      expect(pageOf(pages, '구분')).toBe(consentPage);
      expect(pageOf(pages, '목적')).toBe(consentPage);
      expect(pageOf(pages, '항목')).toBe(consentPage);
      if (consentPage === 1) moved += 1;
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('adds no page number to a single page', () => {
    const pages = layoutBlocks({ title: '제목', blocks: [{ kind: 'paragraph', text: '짧은 글' }] }, measure, small);
    expect(pages).toHaveLength(1);
    expect(texts(pages[0]).map((op) => op.text)).toEqual(['제목', '짧은 글']);
  });
});

describe('renderDocumentPages and parentConsentFormPdf', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function fakeCanvas() {
    const calls = { fillText: [] as string[], fonts: new Set<string>() };
    const context = {
      font: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      textAlign: 'start',
      textBaseline: 'alphabetic',
      measureText(text: string) {
        const [, weight, size] = /^(\d+) ([\d.]+)px/.exec(this.font)!;
        calls.fonts.add(this.font);
        return { width: measure(text, { size: Number(size), weight: Number(weight) }) };
      },
      fillText(text: string) { calls.fillText.push(text); },
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => context) as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlob(callback: BlobCallback, type?: string) {
      callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type }));
    });
    return { calls, context };
  }

  it('paints each page on an A4 canvas with the given font, drawing blanks as lines', async () => {
    const { calls, context } = fakeCanvas();
    const canvases = await renderDocumentPages(buildParentConsentForm({}), { fontFamily: '"Test Sans", sans-serif' });

    expect(canvases.length).toBeGreaterThanOrEqual(1);
    for (const canvas of canvases) expect([canvas.width, canvas.height]).toEqual([1654, 2339]);
    expect(calls.fillText[0]).toBe('「학급 보상 시스템」 이용을 위한 학생 개인정보 수집·이용 동의서');
    expect(calls.fillText.some((text) => text.includes('__'))).toBe(false);
    // "__________ __________에서는 …": the words after the blanks are drawn on their own.
    expect(calls.fillText.some((text) => text.startsWith('에서는 학급 경제 활동'))).toBe(true);
    const blankLines = context.fillRect.mock.calls.filter(([, , , height]) => height === 2);
    expect(blankLines.length).toBeGreaterThanOrEqual(15);
    for (const font of calls.fonts) expect(font).toMatch(/px "Test Sans", sans-serif$/);
    expect(context.textBaseline).toBe('middle');
    expect(context.strokeRect).toHaveBeenCalled();
  });

  it('saves the consent form as a PDF with one picture per page', async () => {
    fakeCanvas();
    const blob = await parentConsentFormPdf({ classLabel: '5학년 2반' }, { fontFamily: 'sans-serif' });
    expect(blob.type).toBe('application/pdf');
    const text = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
    const count = Number(/\/Count (\d+)/.exec(text)![1]);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(2);
    expect(text.match(/\/Subtype \/Image \/Width 1654 \/Height 2339/g)).toHaveLength(count);
  });
});
