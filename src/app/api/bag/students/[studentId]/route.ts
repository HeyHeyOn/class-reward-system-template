import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredStudentBag } from '@/server/repositories/configuredStudentBag';
import { studentBagAdminRequired, studentBagFailure, studentBagJson } from '@/server/studentBagHttp';

type RouteContext = { params: Promise<{ studentId: string }> };

export const dynamic = 'force-dynamic';

/** One student's bag for the teacher. */
export async function GET(request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return studentBagAdminRequired();
  try {
    const { studentId } = await context.params;
    const id = decodeURIComponent(studentId ?? '').trim();
    if (!id || id.length > 200) return studentBagJson({ error: '학생을 다시 골라 주세요.', code: 'INVALID_INPUT' }, 400);
    const bag = await createConfiguredStudentBag(request);
    return studentBagJson({ bag: await bag.studentBag(id, { includeUsed: true }) });
  } catch (error) {
    return studentBagFailure(error, 'student-bag');
  }
}
