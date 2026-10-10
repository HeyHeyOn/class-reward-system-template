// PDFs whose pages each hold one JPEG picture, written by hand so saving a share card or a printable
// form needs no PDF library. The pictures carry all the text (drawn on a canvas with the page's own
// font), so the PDF needs no fonts, which would otherwise have to be embedded for Korean.

/** A4 in PDF points (1/72 inch). */
export const A4_POINTS = Object.freeze({ width: 595.28, height: 841.89 });

export type PdfPageImage = Readonly<{
  jpeg: Uint8Array;
  /** The JPEG's own size in pixels. */
  width: number;
  height: number;
}>;

const encoder = new TextEncoder();

function number(value: number) {
  return Number(value.toFixed(2)).toString();
}

/**
 * Builds a PDF with one page per picture, each JPEG scaled to fit its page and centred.
 * Objects: 1 catalog, 2 page tree, then for page i: 3+3i page, 4+3i picture, 5+3i drawing.
 */
export function imagesPdf(images: ReadonlyArray<PdfPageImage>, page = A4_POINTS): Uint8Array {
  if (images.length === 0) throw new Error('a PDF needs at least one page');
  for (const image of images) {
    if (!(image.width > 0 && image.height > 0)) throw new Error('image size must be positive');
  }

  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: Uint8Array | string) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (body: () => void) => {
    offsets.push(length);
    push(`${offsets.length} 0 obj\n`);
    body();
    push('\nendobj\n');
  };
  const pageObject = (index: number) => 3 + index * 3;

  push('%PDF-1.4\n');
  // A comment of high bytes tells readers (and file transfers) that the file holds binary data.
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  object(() => push('<< /Type /Catalog /Pages 2 0 R >>'));
  const kids = images.map((_, index) => `${pageObject(index)} 0 R`).join(' ');
  object(() => push(`<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>`));

  images.forEach((image, index) => {
    const self = pageObject(index);
    const name = `Im${index}`;
    const scale = Math.min(page.width / image.width, page.height / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    const x = (page.width - drawWidth) / 2;
    const y = (page.height - drawHeight) / 2;
    const content = encoder.encode(`q ${number(drawWidth)} 0 0 ${number(drawHeight)} ${number(x)} ${number(y)} cm /${name} Do Q\n`);

    object(() => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(page.width)} ${number(page.height)}] /Resources << /XObject << /${name} ${self + 1} 0 R >> >> /Contents ${self + 2} 0 R >>`));
    object(() => {
      push(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.jpeg.length} >>\nstream\n`);
      push(image.jpeg);
      push('\nendstream');
    });
    object(() => {
      push(`<< /Length ${content.length} >>\nstream\n`);
      push(content);
      push('endstream');
    });
  });

  const xrefOffset = length;
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const pdf = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    pdf.set(part, at);
    at += part.length;
  }
  return pdf;
}

/**
 * Builds a one-page PDF with the JPEG scaled to fit and centred.
 * `pixelWidth`/`pixelHeight` must be the JPEG's own size.
 */
export function singleImagePdf(jpeg: Uint8Array, pixelWidth: number, pixelHeight: number, page = A4_POINTS): Uint8Array {
  return imagesPdf([{ jpeg, width: pixelWidth, height: pixelHeight }], page);
}
