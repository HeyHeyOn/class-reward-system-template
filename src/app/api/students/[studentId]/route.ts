import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { deleteStudent, getStudentById, updateStudentDetails } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ studentId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
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

export async function PATCH(request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const { studentId } = await context.params;
    const store = await createConfiguredSheetsStore();
    const payload = await request.json();
    const student = await updateStudentDetails(store, decodeURIComponent(studentId), {
      name: String(payload.name ?? ''),
      number: Number(payload.number),
      balance: Number(payload.balance),
      status: payload.status,
    });

    return Response.json(student);
  } catch (error) {
    const message = error instanceof Error ? error.message : '학생 정보를 저장하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}


export async function DELETE(request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const { studentId } = await context.params;
    const store = await createConfiguredSheetsStore();
    const result = await deleteStudent(store, decodeURIComponent(studentId));

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '학생을 삭제하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}
