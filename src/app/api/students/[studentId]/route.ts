import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { getStudentById } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ studentId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { studentId } = await context.params;
    const reader = await createConfiguredSheetsReader();
    const student = await getStudentById(reader, decodeURIComponent(studentId));

    if (!student) {
      return Response.json({ error: '학생을 찾을 수 없습니다.' }, { status: 404 });
    }

    return Response.json(student);
  } catch (error) {
    const message = error instanceof Error ? error.message : '학생 정보를 불러오지 못했습니다.';

    return Response.json({ error: message }, { status: 500 });
  }
}
