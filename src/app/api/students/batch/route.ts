import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { deleteStudentsBatch, updateStudentDetailsBatch } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const store = await createConfiguredSheetsStore(request);
    const payload = await request.json();
    const students = Array.isArray(payload.students)
      ? payload.students.map((student: Record<string, unknown>) => ({
          studentId: String(student.studentId ?? ''),
          name: String(student.name ?? ''),
          balance: Number(student.balance),
          status: student.status,
        }))
      : [];
    const result = await updateStudentDetailsBatch(store, students);

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '학생 명단을 일괄 저장하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const store = await createConfiguredSheetsStore(request);
    const payload = await request.json();
    const result = await deleteStudentsBatch(
      store,
      Array.isArray(payload.studentIds) ? payload.studentIds.map((id: unknown) => String(id)) : [],
    );

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '학생을 일괄 삭제하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}
