import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { getStudentById } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

const invalidQueryError = { error: '올바른 학생 ID를 입력해 주세요.' };
const missingStudentError = { error: '학생 정보를 찾을 수 없습니다.' };
const internalError = { error: '학생 정보를 불러오지 못했습니다.' };

export async function GET(request: Request) {
  try {
    const query = Array.from(new URL(request.url).searchParams.entries());
    if (query.length !== 1 || query[0][0] !== 'studentId') {
      return Response.json(invalidQueryError, { status: 400 });
    }

    const studentId = query[0][1].trim();
    if (!studentId) return Response.json(invalidQueryError, { status: 400 });

    const reader = await createConfiguredSheetsReader(request);
    const student = await getStudentById(reader, studentId);
    if (!student || student.status !== 'ACTIVE') {
      return Response.json(missingStudentError, { status: 404 });
    }

    return Response.json({ studentId: student.studentId, name: student.name });
  } catch {
    return Response.json(internalError, { status: 500 });
  }
}
