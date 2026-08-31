import { createConfiguredTaskReader } from '@/server/repositories/configuredTasks';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const reader = await createConfiguredTaskReader(request);
    const now = new Date().toISOString();
    return Response.json(await reader.getBankTasks(now));
  } catch {
    return Response.json({ error: '과제 목록을 불러오지 못했습니다.' }, { status: 500 });
  }
}