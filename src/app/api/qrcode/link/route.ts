import * as QRCode from 'qrcode';

export const dynamic = 'force-dynamic';

const MAX_URL_BYTES = 2048;
const ERROR = 'QR 코드를 생성하지 못했습니다.';

export async function POST(request: Request) {
  if (new URL(request.url).search !== '') {
    return Response.json({ error: ERROR }, { status: 400 });
  }
  const value = await parseBody(request);
  if (!value) return Response.json({ error: ERROR }, { status: 400 });

  try {
    const svg = await QRCode.toString(value, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 256,
    });
    return new Response(svg, {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return Response.json({ error: ERROR }, { status: 500 });
  }
}

async function parseBody(request: Request): Promise<string | null> {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return null;
  try {
    const body: unknown = await request.json();
    if (!isPlainObject(body) || Object.keys(body).length !== 2
      || body.kind !== 'system-link' || typeof body.url !== 'string'
      || Buffer.byteLength(body.url, 'utf8') > MAX_URL_BYTES
      || body.url.startsWith('class-store-admin:')) return null;
    const url = new URL(body.url);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password
      || url.href !== body.url) return null;
    return url.href;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
