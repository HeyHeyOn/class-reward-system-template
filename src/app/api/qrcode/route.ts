import * as QRCode from 'qrcode';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const value = url.searchParams.get('value')?.trim();

  if (!value) {
    return Response.json({ error: 'QR 값을 입력해 주세요.' }, { status: 400 });
  }

  try {
    const svg = await QRCode.toString(value, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 256,
    });

    return new Response(svg, {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'QR 코드를 생성하지 못했습니다.';

    return Response.json({ error: message }, { status: 500 });
  }
}
