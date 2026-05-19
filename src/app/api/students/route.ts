import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { getStudents } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const reader = await createConfiguredSheetsReader();
    const students = await getStudents(reader);

    return Response.json(students);
  } catch (error) {
    const message = error instanceof Error ? error.message : '학생 목록을 불러오지 못했습니다.';

    return Response.json({ error: message }, { status: 500 });
  }
}
