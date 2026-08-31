import { createConfiguredBankReader } from '@/server/repositories/configuredBank';

export const dynamic = 'force-dynamic';

const invalidQueryError = { error: '올바른 학생 ID를 입력해 주세요.' };
const missingStudentError = { error: '학생 정보를 찾을 수 없습니다.', code: 'STUDENT_NOT_FOUND' };
const unavailableError = {
  error: '학생 정보를 일시적으로 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
  code: 'STUDENT_DATA_UNAVAILABLE',
};

export async function GET(request: Request) {
  try {
    const query = Array.from(new URL(request.url).searchParams.entries());
    if (query.length !== 1 || query[0][0] !== 'studentId') {
      return Response.json(invalidQueryError, { status: 400 });
    }

    const studentId = query[0][1].trim();
    if (!studentId) return Response.json(invalidQueryError, { status: 400 });

    const reader = await createConfiguredBankReader(request);
    const lookup = await reader.confirmStudent(studentId);
    if (lookup.status === 'NOT_FOUND' || lookup.status === 'INACTIVE') {
      return Response.json(missingStudentError, { status: 404 });
    }
    if (lookup.status === 'UNAVAILABLE') {
      return Response.json(unavailableError, { status: 503 });
    }

    return Response.json({ studentId: lookup.student.studentId, name: lookup.student.name });
  } catch {
    return Response.json(unavailableError, { status: 503 });
  }
}
