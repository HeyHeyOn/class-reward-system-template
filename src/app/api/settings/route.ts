import { getAppSettings, saveAppSettings } from '@/server/settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  const settings = await getAppSettings();

  return Response.json(settings);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { spreadsheetIdOrUrl?: unknown };

    if (typeof body.spreadsheetIdOrUrl !== 'string') {
      return Response.json({ error: '시트 ID 또는 주소를 입력해 주세요.' }, { status: 400 });
    }

    const settings = await saveAppSettings({ spreadsheetIdOrUrl: body.spreadsheetIdOrUrl });

    return Response.json(settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : '설정을 저장하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}
