import { describe, expect, it } from 'vitest';
import { A4_POINTS, imagesPdf, singleImagePdf } from './imagePdf';

const decoder = new TextDecoder('latin1');

describe('singleImagePdf', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const pdf = singleImagePdf(jpeg, 1240, 1754);
  const text = decoder.decode(pdf);

  it('writes a complete PDF whose cross-reference table points at every object', () => {
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.endsWith('%%EOF\n')).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const entries = text.slice(startxref).split('\n').slice(3, 8);
    entries.forEach((entry, index) => {
      expect(entry).toMatch(/^\d{10} 00000 n $/);
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
    });
  });

  it('embeds the JPEG bytes unchanged with their exact length', () => {
    expect(text).toContain(`/Width 1240 /Height 1754`);
    expect(text).toContain(`/Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    const start = text.indexOf('/DCTDecode');
    const streamStart = text.indexOf('stream\n', start) + 'stream\n'.length;
    expect(Array.from(pdf.slice(streamStart, streamStart + jpeg.length))).toEqual(Array.from(jpeg));
    expect(text.slice(streamStart + jpeg.length, streamStart + jpeg.length + '\nendstream'.length)).toBe('\nendstream');
  });

  it('fits the picture on an A4 page, centred, keeping its shape', () => {
    expect(text).toContain(`/MediaBox [0 0 ${A4_POINTS.width} ${A4_POINTS.height}]`);
    const [, width, height, x, y] = /q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im0 Do Q/.exec(text)!.map(Number);
    expect(width / height).toBeCloseTo(1240 / 1754, 3);
    expect(width).toBeLessThanOrEqual(A4_POINTS.width + 0.01);
    expect(height).toBeLessThanOrEqual(A4_POINTS.height + 0.01);
    expect(x * 2 + width).toBeCloseTo(A4_POINTS.width, 1);
    expect(y * 2 + height).toBeCloseTo(A4_POINTS.height, 1);
    const contentLength = Number(/<< \/Length (\d+) >>\nstream\nq /.exec(text)![1]);
    expect(contentLength).toBe(/q [^\n]+ Do Q\n/.exec(text)![0].length);
  });

  it('refuses an empty picture', () => {
    expect(() => singleImagePdf(jpeg, 0, 10)).toThrow();
  });
});

describe('imagesPdf', () => {
  const portrait = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 10, 20, 30, 0xff, 0xd9]);
  const landscape = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 40, 50, 0xff, 0xd9]);
  const pdf = imagesPdf([
    { jpeg: portrait, width: 1654, height: 2339 },
    { jpeg: landscape, width: 2000, height: 1000 },
  ]);
  const text = decoder.decode(pdf);

  it('writes every page into the page tree and points the cross-reference table at all objects', () => {
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.endsWith('%%EOF\n')).toBe(true);
    expect(text).toContain('<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>');
    expect(text).toContain('/Size 9 /Root 1 0 R');
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    expect(text.slice(startxref).split('\n')[1]).toBe('0 9');
    const entries = text.slice(startxref).split('\n').slice(3, 11);
    expect(entries).toHaveLength(8);
    entries.forEach((entry, index) => {
      expect(entry).toMatch(/^\d{10} 00000 n $/);
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
    });
  });

  it('gives each page its own picture, embedded unchanged', () => {
    expect(text.match(/\/Subtype \/Image/g)).toHaveLength(2);
    expect(text).toContain('/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R');
    expect(text).toContain('/Resources << /XObject << /Im1 7 0 R >> >> /Contents 8 0 R');
    expect(text).toContain(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width 1654 /Height 2339 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${portrait.length} >>`);
    expect(text).toContain(`7 0 obj\n<< /Type /XObject /Subtype /Image /Width 2000 /Height 1000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${landscape.length} >>`);
    for (const [object, jpeg] of [[4, portrait], [7, landscape]] as const) {
      const start = text.indexOf(`${object} 0 obj`);
      const streamStart = text.indexOf('stream\n', start) + 'stream\n'.length;
      expect(Array.from(pdf.slice(streamStart, streamStart + jpeg.length))).toEqual(Array.from(jpeg));
      expect(text.slice(streamStart + jpeg.length, streamStart + jpeg.length + '\nendstream'.length)).toBe('\nendstream');
    }
  });

  it('fits and centres each picture on its own A4 page', () => {
    const draws = [...text.matchAll(/<< \/Length (\d+) >>\nstream\n(q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/(Im\d) Do Q\n)/g)];
    expect(draws.map((draw) => draw[7])).toEqual(['Im0', 'Im1']);
    const shapes = [1654 / 2339, 2000 / 1000];
    draws.forEach((draw, index) => {
      expect(Number(draw[1])).toBe(draw[2].length);
      const [width, height, x, y] = draw.slice(3, 7).map(Number);
      expect(width / height).toBeCloseTo(shapes[index], 2);
      expect(width).toBeLessThanOrEqual(A4_POINTS.width + 0.01);
      expect(height).toBeLessThanOrEqual(A4_POINTS.height + 0.01);
      expect(x * 2 + width).toBeCloseTo(A4_POINTS.width, 1);
      expect(y * 2 + height).toBeCloseTo(A4_POINTS.height, 1);
    });
    expect(text.match(new RegExp(`/MediaBox \\[0 0 ${A4_POINTS.width} ${A4_POINTS.height}\\]`, 'g'))).toHaveLength(2);
  });

  it('writes the same file as singleImagePdf for one page', () => {
    expect(imagesPdf([{ jpeg: portrait, width: 1654, height: 2339 }])).toEqual(singleImagePdf(portrait, 1654, 2339));
  });

  it('refuses no pages or an empty picture', () => {
    expect(() => imagesPdf([])).toThrow();
    expect(() => imagesPdf([{ jpeg: portrait, width: 10, height: 10 }, { jpeg: landscape, width: 10, height: 0 }])).toThrow();
  });
});
