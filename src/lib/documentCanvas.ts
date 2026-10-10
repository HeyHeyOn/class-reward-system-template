// Lays a printable document (see parentConsentForm.ts) out on A4 pages and draws them on canvases with
// the page's own (already loaded) Korean font, so the PDF needs no embedded fonts. Layout is pure: it
// takes a text measurer and returns drawing operations, so it is tested without a canvas.
import { imagesPdf } from './imagePdf';
import {
  buildParentConsentForm,
  type ConsentFormDocument,
  type DocumentBlock,
  type DocumentTable,
  type ParentConsentFormInput,
} from './parentConsentForm';

export type FontSpec = Readonly<{ size: number; weight: number }>;
/** Width in pixels of `text` drawn in `font`. */
export type MeasureText = (text: string, font: FontSpec) => number;

export type DrawOp =
  /** One line of text: `x` is its left edge, `y` the middle of the line, `width` its measured width. */
  | Readonly<{ kind: 'text'; text: string; x: number; y: number; width: number; font: FontSpec }>
  /** A filled and/or outlined box (`stroke` is the outline width). */
  | Readonly<{ kind: 'rect'; x: number; y: number; width: number; height: number; fill?: string; stroke?: number }>;

export type PageGeometry = Readonly<{ width: number; height: number; marginX: number; marginTop: number; marginBottom: number }>;

/** A4 at 200 dpi, with margins of about 19 mm. */
export const DOCUMENT_PAGE: PageGeometry = Object.freeze({ width: 1654, height: 2339, marginX: 150, marginTop: 140, marginBottom: 150 });

/** Pixels per typographic point at 200 dpi. */
const PT = 200 / 72;

export const DOCUMENT_FONTS = Object.freeze({
  title: { size: 15 * PT, weight: 800 },
  subtitle: { size: 11 * PT, weight: 600 },
  heading: { size: 11.5 * PT, weight: 700 },
  body: { size: 10.5 * PT, weight: 400 },
  bodyBold: { size: 10.5 * PT, weight: 700 },
  cell: { size: 10 * PT, weight: 400 },
  cellBold: { size: 10 * PT, weight: 700 },
  addressee: { size: 13 * PT, weight: 700 },
  pageNumber: { size: 9 * PT, weight: 400 },
} satisfies Record<string, FontSpec>);

const INK = '#000000';
const HEADER_FILL = '#E4E4E4';
const LABEL_FILL = '#F2F2F2';
const CONSENT_FILL = '#F2F2F2';
const RULE = 2;

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

/** Each underscore of a blank is this many ems wide, whatever the font, so blanks leave room to write. */
const BLANK_EM = 0.6;
const BLANK_RUN = /(_{2,})/;

/** Splits text into plain parts and blanks (runs of two or more underscores). */
export function textSegments(text: string): Array<{ text: string; blank: boolean }> {
  return text.split(BLANK_RUN).filter(Boolean).map((part) => ({ text: part, blank: /^_{2,}$/.test(part) }));
}

function blankWidth(run: string, font: FontSpec) {
  return run.length * BLANK_EM * font.size;
}

/** Width of a line of text, blanks included. */
export function measureLine(text: string, font: FontSpec, measure: MeasureText) {
  let width = 0;
  for (const segment of textSegments(text)) width += segment.blank ? blankWidth(segment.text, font) : measure(segment.text, font);
  return width;
}

/**
 * Breaks text into lines no wider than `maxWidth`. Lines break at spaces (runs of spaces between
 * words on one line are kept); a word is broken between characters only when it alone is wider than
 * a line. "\n" always starts a new line.
 */
export function wrapText(text: string, maxWidth: number, font: FontSpec, measure: MeasureText): string[] {
  const width = (value: string) => measureLine(value, font, measure);
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    let space = '';
    for (const token of paragraph.split(/( +)/)) {
      if (!token) continue;
      if (token.startsWith(' ')) {
        if (line) space = token;
        continue;
      }
      const joined = line ? `${line}${space}${token}` : token;
      space = '';
      if (width(joined) <= maxWidth) {
        line = joined;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      if (width(token) <= maxWidth) {
        line = token;
        continue;
      }
      for (const char of Array.from(token)) {
        if (line && width(line + char) > maxWidth) {
          lines.push(line);
          line = '';
        }
        line += char;
      }
    }
    lines.push(line);
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

type Unit = {
  height: number;
  /** Space above the unit, dropped at the top of a page. */
  space: number;
  /** Keep on the same page as the next unit. */
  keepWithNext?: boolean;
  /** Placed first when this unit starts a new page: a table's header row. */
  carryOver?: Unit;
  draw: (top: number) => DrawOp[];
};

type Layout = Readonly<{
  measure: MeasureText;
  /** Left edge and width of the text area. */
  left: number;
  width: number;
  /** Height of a page's text area. */
  pageHeight: number;
}>;

type Align = 'left' | 'center' | 'right';

function linesOps(layout: Layout, lines: readonly string[], font: FontSpec, lineHeight: number, left: number, width: number, top: number, align: Align = 'left') {
  const ops: DrawOp[] = [];
  lines.forEach((text, index) => {
    if (!text) return;
    const textWidth = measureLine(text, font, layout.measure);
    const x = align === 'left' ? left : align === 'center' ? left + (width - textWidth) / 2 : left + width - textWidth;
    ops.push({ kind: 'text', text, x, y: top + lineHeight * (index + 0.5), width: textWidth, font });
  });
  return ops;
}

function titleUnit(layout: Layout, doc: ConsentFormDocument): Unit {
  const { title: titleFont, subtitle: subtitleFont } = DOCUMENT_FONTS;
  const titleLines = wrapText(doc.title, layout.width, titleFont, layout.measure);
  const titleLineHeight = titleFont.size * 1.4;
  const subtitleLineHeight = subtitleFont.size * 1.5;
  const subtitleTop = titleLines.length * titleLineHeight + 4;
  const ruleTop = Math.ceil(subtitleTop + (doc.subtitle ? subtitleLineHeight : 0) + 22);
  return {
    height: ruleTop + 11,
    space: 0,
    draw: (top) => [
      ...linesOps(layout, titleLines, titleFont, titleLineHeight, layout.left, layout.width, top, 'center'),
      ...(doc.subtitle ? linesOps(layout, [doc.subtitle], subtitleFont, subtitleLineHeight, layout.left, layout.width, top + subtitleTop, 'center') : []),
      // A double rule under the title, as on printed school forms.
      { kind: 'rect', x: layout.left, y: top + ruleTop, width: layout.width, height: 5, fill: INK },
      { kind: 'rect', x: layout.left, y: top + ruleTop + 9, width: layout.width, height: 2, fill: INK },
    ],
  };
}

function textUnit(layout: Layout, text: string, font: FontSpec, lineHeight: number): Unit {
  const lines = wrapText(text, layout.width, font, layout.measure);
  return {
    height: Math.ceil(lines.length * lineHeight),
    space: 0,
    draw: (top) => linesOps(layout, lines, font, lineHeight, layout.left, layout.width, top),
  };
}

/**
 * Column widths. A column whose cells fit on one line within an equal share of the table keeps them on
 * one line; the other columns share the rest like an automatic HTML table, so no word is broken if the
 * words fit at all.
 */
function columnWidths(layout: Layout, table: DocumentTable, padX: number) {
  const columns = table.header.length;
  const fontAt = (row: number, column: number) => (row < 0 || (table.rowLabels && column === 0) ? DOCUMENT_FONTS.cellBold : DOCUMENT_FONTS.cell);
  const least = new Array<number>(columns).fill(0);
  const most = new Array<number>(columns).fill(0);
  [table.header, ...table.rows].forEach((cells, index) => {
    for (let column = 0; column < columns; column += 1) {
      const font = fontAt(index - 1, column);
      const text = cells[column] ?? '';
      for (const line of text.split('\n')) {
        most[column] = Math.max(most[column], measureLine(line, font, layout.measure) + padX * 2 + 1);
        for (const word of line.split(/ +/)) least[column] = Math.max(least[column], measureLine(word, font, layout.measure) + padX * 2 + 1);
      }
    }
  });

  const total = layout.width;
  const all = most.map((_, column) => column);
  const sum = (values: readonly number[], of: readonly number[]) => of.reduce((result, column) => result + values[column], 0);
  /** Shares `room` among `flexible` columns: each at least its longest word, at most its one-line width. */
  const share = (widths: number[], flexible: readonly number[], room: number) => {
    const leastSum = sum(least, flexible);
    const mostSum = sum(most, flexible);
    for (const column of flexible) {
      if (mostSum <= room) widths[column] = most[column] * (room / mostSum);
      else if (leastSum <= room) widths[column] = least[column] + (room - leastSum) * ((most[column] - least[column]) / (mostSum - leastSum));
      else widths[column] = least[column] * (room / leastSum);
    }
    return widths;
  };

  let widths: number[];
  const narrow = all.filter((column) => most[column] <= total / columns);
  const flexible = all.filter((column) => most[column] > total / columns);
  if (sum(most, all) <= total || narrow.length === 0 || sum(most, narrow) + sum(least, flexible) > total) {
    widths = share(new Array<number>(columns).fill(0), all, total);
  } else {
    widths = most.map((width, column) => (narrow.includes(column) ? width : 0));
    share(widths, flexible, total - sum(most, narrow));
  }

  // Whole pixels, so ruled lines stay sharp; the last column takes what rounding leaves.
  const rounded = widths.map(Math.floor);
  rounded[columns - 1] = total - rounded.slice(0, -1).reduce((sum, width) => sum + width, 0);
  return rounded;
}

function tableUnits(layout: Layout, table: DocumentTable): Unit[] {
  const padX = 18;
  const padY = 14;
  const lineHeight = DOCUMENT_FONTS.cell.size * 1.5;
  const widths = columnWidths(layout, table, padX);
  const lefts = widths.map((_, column) => layout.left + widths.slice(0, column).reduce((sum, width) => sum + width, 0));

  const row = (cells: readonly string[], header: boolean): Unit => {
    const fonts = widths.map((_, column) => (header || (table.rowLabels && column === 0) ? DOCUMENT_FONTS.cellBold : DOCUMENT_FONTS.cell));
    const lines = widths.map((width, column) => wrapText(cells[column] ?? '', width - padX * 2, fonts[column], layout.measure));
    const height = Math.ceil(Math.max(...lines.map((cell) => cell.length)) * lineHeight + padY * 2);
    return {
      height,
      space: 0,
      draw: (top) => widths.flatMap((width, column): DrawOp[] => {
        const label = !header && table.rowLabels && column === 0;
        const textTop = top + (height - lines[column].length * lineHeight) / 2;
        return [
          { kind: 'rect', x: lefts[column], y: top, width, height, fill: header ? HEADER_FILL : label ? LABEL_FILL : undefined, stroke: RULE },
          ...linesOps(layout, lines[column], fonts[column], lineHeight, lefts[column] + padX, width - padX * 2, textTop, header || label ? 'center' : 'left'),
        ];
      }),
    };
  };

  const header = row(table.header, true);
  const rows = table.rows.map((cells) => row(cells, false));
  // A short table stays on one page; a long one breaks between rows.
  const short = rows.reduce((sum, unit) => sum + unit.height, header.height) <= layout.pageHeight / 2;
  return [
    { ...header, keepWithNext: true },
    ...rows.map((unit, index) => ({ ...unit, keepWithNext: short && index < rows.length - 1, carryOver: header })),
  ];
}

function consentUnit(layout: Layout, question: string, options: readonly string[]): Unit {
  const font = DOCUMENT_FONTS.bodyBold;
  const optionFont = DOCUMENT_FONTS.body;
  const padX = 26;
  const padY = 16;
  const lineHeight = font.size * 1.6;
  const box = Math.round(optionFont.size * 0.82);
  const boxGap = optionFont.size * 0.4;
  const optionGap = optionFont.size * 1.6;
  const inner = layout.width - padX * 2;
  const optionWidths = options.map((option) => box + boxGap + measureLine(option, optionFont, layout.measure));
  const optionsWidth = optionWidths.reduce((sum, width) => sum + width, 0) + optionGap * Math.max(0, options.length - 1);
  const oneLine = measureLine(question, font, layout.measure) + optionFont.size * 2 + optionsWidth <= inner;
  const questionLines = oneLine ? [question] : wrapText(question, inner, font, layout.measure);
  const lines = oneLine ? 1 : questionLines.length + 1;
  const height = Math.ceil(lines * lineHeight + padY * 2);
  return {
    height,
    space: 0,
    draw: (top) => {
      const ops: DrawOp[] = [
        { kind: 'rect', x: layout.left, y: top, width: layout.width, height, fill: CONSENT_FILL, stroke: RULE },
        ...linesOps(layout, questionLines, font, lineHeight, layout.left + padX, inner, top + padY),
      ];
      const middle = top + padY + lineHeight * (lines - 0.5);
      let x = layout.left + padX + inner - optionsWidth;
      options.forEach((option, index) => {
        ops.push({ kind: 'rect', x: Math.round(x), y: Math.round(middle - box / 2), width: box, height: box, fill: '#FFFFFF', stroke: 3 });
        const textX = x + box + boxGap;
        ops.push({ kind: 'text', text: option, x: textX, y: middle, width: optionWidths[index] - box - boxGap, font: optionFont });
        x += optionWidths[index] + optionGap;
      });
      return ops;
    },
  };
}

function signatureUnit(layout: Layout, block: Extract<DocumentBlock, { kind: 'signature' }>): Unit {
  const font = DOCUMENT_FONTS.body;
  const addresseeFont = DOCUMENT_FONTS.addressee;
  const padX = 40;
  const padY = 14;
  // Tall lines leave room to write by hand above each blank.
  const lineHeight = font.size * 2.8;
  const inner = layout.width - padX * 2;
  const lines = block.lines.flatMap((line) => wrapText(line, inner, font, layout.measure));
  const dateLines = wrapText(block.date, inner, font, layout.measure);
  const boxHeight = Math.ceil((lines.length + dateLines.length) * lineHeight + padY * 2);
  const addresseeLineHeight = addresseeFont.size * 1.5;
  const addresseeLines = wrapText(block.addressee, layout.width, addresseeFont, layout.measure);
  const addresseeTop = boxHeight + 56;
  // Text sits low in its line, so the room to write is above the blank.
  const lowered = (ops: DrawOp[]) => ops.map((op) => (op.kind === 'text' ? { ...op, y: op.y + lineHeight * 0.12 } : op));
  return {
    height: Math.ceil(addresseeTop + addresseeLines.length * addresseeLineHeight),
    space: 0,
    draw: (top) => [
      { kind: 'rect', x: layout.left, y: top, width: layout.width, height: boxHeight, stroke: RULE },
      ...lowered(linesOps(layout, lines, font, lineHeight, layout.left + padX, inner, top + padY)),
      ...lowered(linesOps(layout, dateLines, font, lineHeight, layout.left + padX, inner, top + padY + lines.length * lineHeight, 'right')),
      ...linesOps(layout, addresseeLines, addresseeFont, addresseeLineHeight, layout.left, layout.width, top + addresseeTop, 'center'),
    ],
  };
}

const SPACING: Record<DocumentBlock['kind'], Readonly<{ before: number; after: number }>> = {
  heading: { before: 50, after: 16 },
  paragraph: { before: 18, after: 18 },
  table: { before: 16, after: 18 },
  consent: { before: 14, after: 18 },
  signature: { before: 60, after: 0 },
};

function blockUnits(layout: Layout, block: DocumentBlock): Unit[] {
  switch (block.kind) {
    case 'heading':
      return [{ ...textUnit(layout, block.text, DOCUMENT_FONTS.heading, DOCUMENT_FONTS.heading.size * 1.45), keepWithNext: true }];
    case 'paragraph': {
      const font = block.bold ? DOCUMENT_FONTS.bodyBold : DOCUMENT_FONTS.body;
      return [textUnit(layout, block.text, font, font.size * 1.65)];
    }
    case 'table':
      return tableUnits(layout, block);
    case 'consent':
      return [consentUnit(layout, block.question, block.options)];
    case 'signature':
      return [signatureUnit(layout, block)];
  }
}

/**
 * Lays the document out on pages: returns each page's drawing operations. A table row, a consent
 * question and the signature block are never split; a table no taller than half a page is kept whole;
 * a heading stays with what follows it, a consent question with what precedes it, and a table carried
 * onto a new page repeats its header row.
 * Page numbers are added when there is more than one page.
 */
export function layoutBlocks(doc: ConsentFormDocument, measure: MeasureText, page: PageGeometry = DOCUMENT_PAGE): DrawOp[][] {
  const layout: Layout = { measure, left: page.marginX, width: page.width - page.marginX * 2, pageHeight: page.height - page.marginTop - page.marginBottom };
  const units: Unit[] = [titleUnit(layout, doc)];
  let after = 56;
  for (const block of doc.blocks) {
    const blockUnitsList = blockUnits(layout, block);
    const spacing = SPACING[block.kind];
    blockUnitsList[0] = { ...blockUnitsList[0], space: Math.max(after, spacing.before) };
    // A consent question answers the table or text right above it.
    if (block.kind === 'consent') units[units.length - 1] = { ...units[units.length - 1], keepWithNext: true };
    units.push(...blockUnitsList);
    after = spacing.after;
  }

  const top = page.marginTop;
  const bottom = page.height - page.marginBottom;
  const pages: DrawOp[][] = [[]];
  let y = top;
  const place = (unit: Unit) => {
    if (y > top) y += unit.space;
    pages[pages.length - 1].push(...unit.draw(y));
    y += unit.height;
  };

  units.forEach((unit, index) => {
    let needed = (y > top ? unit.space : 0) + unit.height;
    for (let next = index; units[next].keepWithNext && next + 1 < units.length; next += 1) {
      needed += units[next + 1].space + units[next + 1].height;
    }
    if (y > top && y + needed > bottom) {
      pages.push([]);
      y = top;
      if (unit.carryOver) place(unit.carryOver);
    }
    place(unit);
  });

  if (pages.length > 1) {
    const font = DOCUMENT_FONTS.pageNumber;
    pages.forEach((ops, index) => {
      const text = `${index + 1} / ${pages.length}`;
      const width = measureLine(text, font, measure);
      ops.push({ kind: 'text', text, x: (page.width - width) / 2, y: page.height - page.marginBottom / 2, width, font });
    });
  }
  return pages;
}

/* ------------------------------------------------------------------ */
/* Canvas                                                              */
/* ------------------------------------------------------------------ */

function cssFont(font: FontSpec, family: string) {
  return `${font.weight} ${Number(font.size.toFixed(2))}px ${family}`;
}

function canvasMeasure(context: CanvasRenderingContext2D, family: string): MeasureText {
  const cache = new Map<string, number>();
  return (text, font) => {
    const key = `${font.weight}|${font.size}|${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      context.font = cssFont(font, family);
      width = context.measureText(text).width;
      cache.set(key, width);
    }
    return width;
  };
}

function paintPage(context: CanvasRenderingContext2D, ops: readonly DrawOp[], page: PageGeometry, family: string, measure: MeasureText) {
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, page.width, page.height);
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  for (const op of ops) {
    if (op.kind === 'rect') {
      if (op.fill) {
        context.fillStyle = op.fill;
        context.fillRect(op.x, op.y, op.width, op.height);
      }
      if (op.stroke) {
        context.strokeStyle = INK;
        context.lineWidth = op.stroke;
        context.strokeRect(op.x, op.y, op.width, op.height);
      }
      continue;
    }
    context.font = cssFont(op.font, family);
    context.fillStyle = INK;
    let x = op.x;
    for (const segment of textSegments(op.text)) {
      if (segment.blank) {
        // A blank is a line at the foot of the text, slightly inset so blanks next to words stay apart.
        const width = blankWidth(segment.text, op.font);
        context.fillRect(x + 3, op.y + op.font.size * 0.5, width - 6, 2);
        x += width;
      } else {
        context.fillText(segment.text, x, op.y);
        x += measure(segment.text, op.font);
      }
    }
  }
}

async function loadFonts(family: string) {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts;
  if (!fonts) return;
  // Web fonts load on first use; ask for every weight the layout draws before measuring.
  const weights = [...new Set(Object.values(DOCUMENT_FONTS).map((font) => font.weight))];
  await Promise.all(weights.map((weight) => fonts.load(`${weight} 16px ${family}`, '가A').catch(() => undefined)));
  await fonts.ready.catch(() => undefined);
}

/** Draws the document on A4 canvases (one per page) with the given CSS font family. Browser only. */
export async function renderDocumentPages(doc: ConsentFormDocument, { fontFamily }: { fontFamily: string }, page: PageGeometry = DOCUMENT_PAGE): Promise<HTMLCanvasElement[]> {
  const family = fontFamily.trim() || 'sans-serif';
  await loadFonts(family);
  const scratch = document.createElement('canvas').getContext('2d');
  if (!scratch) throw new Error('canvas is unavailable');
  const measure = canvasMeasure(scratch, family);
  return layoutBlocks(doc, measure, page).map((ops) => {
    const canvas = document.createElement('canvas');
    canvas.width = page.width;
    canvas.height = page.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas is unavailable');
    paintPage(context, ops, page, family, measure);
    return canvas;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas could not be saved'))), type, quality);
  });
}

/** The document as an A4 PDF, one JPEG picture per page. */
export async function documentPdf(doc: ConsentFormDocument, options: { fontFamily: string }): Promise<Blob> {
  const canvases = await renderDocumentPages(doc, options);
  const pages = [];
  for (const canvas of canvases) {
    const jpeg = new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
    pages.push({ jpeg, width: canvas.width, height: canvas.height });
  }
  const pdf = imagesPdf(pages);
  return new Blob([pdf.buffer as ArrayBuffer], { type: 'application/pdf' });
}

/** The parent consent form (법정대리인용 개인정보 수집·이용 동의서) as a printable A4 PDF. */
export function parentConsentFormPdf(input: ParentConsentFormInput, options: { fontFamily: string }): Promise<Blob> {
  return documentPdf(buildParentConsentForm(input), options);
}
