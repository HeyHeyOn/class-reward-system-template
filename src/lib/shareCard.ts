// Share card: one A4-shaped picture with the page name, a large QR and the address, so a teacher can
// save it as an image or a PDF and print it or show it on another device. Browser only (canvas).
import { singleImagePdf } from './imagePdf';

export type ShareCardContent = Readonly<{
  url: string;
  /** Page name, e.g. 매점, 은행, 관리자 페이지. */
  title: string;
  classLabel: string;
  hint: string;
  /** Shown in orange under the title (the teacher-only admin page). */
  caution?: string;
  /** CSS font-family of the page, so the card uses the same (already loaded) Korean font. */
  fontFamily: string;
}>;

/** A4 at 150 dpi. */
export const SHARE_CARD_SIZE = Object.freeze({ width: 1240, height: 1754 });

const QR_BOX = 880;
const QUIET_MODULES = 4;
const TEXT_WIDTH = 1040;

function fitText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (context.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && context.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Breaks an address into lines by width; an address has no spaces to break at. */
function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) {
  const lines: string[] = [];
  let line = '';
  for (const char of text) {
    if (line && context.measureText(line + char).width > maxWidth) {
      lines.push(line);
      line = '';
    }
    line += char;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), fitText(context, lines.slice(maxLines - 1).join(''), maxWidth)];
}

export async function drawShareCard(content: ShareCardContent): Promise<HTMLCanvasElement> {
  const QRCode = await import('qrcode');
  const qr = QRCode.create(content.url, { errorCorrectionLevel: 'M' });
  await document.fonts?.ready.catch(() => undefined);

  const { width, height } = SHARE_CARD_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas is unavailable');
  const font = (weight: number, size: number) => `${weight} ${size}px ${content.fontFamily}`;
  const center = width / 2;

  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, width, height);
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';

  context.fillStyle = '#64686F';
  context.font = font(600, 44);
  context.fillText(fitText(context, content.classLabel, TEXT_WIDTH), center, 220);

  context.fillStyle = '#1F2328';
  context.font = font(800, 112);
  context.fillText(fitText(context, content.title, TEXT_WIDTH), center, 360);

  if (content.caution) {
    context.fillStyle = '#C2410C';
    context.font = font(700, 42);
    context.fillText(fitText(context, content.caution, TEXT_WIDTH), center, 440);
  }

  // QR modules on whole pixels, with the standard 4-module quiet zone, centred in the QR box.
  const qrTop = content.caution ? 490 : 440;
  const modules = qr.modules.size;
  const cell = Math.floor(QR_BOX / (modules + QUIET_MODULES * 2));
  const drawn = cell * (modules + QUIET_MODULES * 2);
  const left = Math.round((width - drawn) / 2) + QUIET_MODULES * cell;
  const top = qrTop + Math.round((QR_BOX - drawn) / 2) + QUIET_MODULES * cell;
  context.fillStyle = '#000000';
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (qr.modules.get(row, column)) context.fillRect(left + column * cell, top + row * cell, cell, cell);
    }
  }

  const qrBottom = qrTop + QR_BOX;
  context.fillStyle = '#2B2D31';
  context.font = font(600, 46);
  context.fillText(fitText(context, content.hint, TEXT_WIDTH), center, qrBottom + 100);

  context.fillStyle = '#4B5058';
  context.font = font(500, 36);
  wrapText(context, content.url, TEXT_WIDTH, 3).forEach((line, index) => context.fillText(line, center, qrBottom + 180 + index * 50));

  context.fillStyle = '#9AA0A6';
  context.font = font(600, 30);
  context.fillText('학급 보상 시스템', center, height - 70);
  return canvas;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas could not be saved'))), type, quality);
  });
}

export async function shareCardPng(content: ShareCardContent): Promise<Blob> {
  return canvasBlob(await drawShareCard(content), 'image/png');
}

/** The card on one A4 page. JPEG at high quality keeps the QR's black-and-white edges sharp. */
export async function shareCardPdf(content: ShareCardContent): Promise<Blob> {
  const canvas = await drawShareCard(content);
  const jpeg = new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', 0.95)).arrayBuffer());
  const pdf = singleImagePdf(jpeg, canvas.width, canvas.height);
  return new Blob([pdf.buffer as ArrayBuffer], { type: 'application/pdf' });
}

/** e.g. "5학년 2반-매점-QR.png"; characters that file systems refuse become "-". */
export function shareFileName(classLabel: string, title: string, extension: 'png' | 'pdf') {
  const safe = (text: string) => text.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim();
  return [safe(classLabel), safe(title), 'QR'].filter(Boolean).join('-') + `.${extension}`;
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers start reading the file after click() returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
