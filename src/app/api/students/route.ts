import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { createStudent, getStudents } from '@/server/sheetsRepository';

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

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const store = await createConfiguredSheetsStore();
    const payload = await request.json();
    const student = await createStudent(store, {
      studentId: String(payload.studentId ?? ''),
      name: String(payload.name ?? ''),
      balance: Number(payload.balance),
      status: payload.status,
    });

    return Response.json(student, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '학생을 추가하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}
