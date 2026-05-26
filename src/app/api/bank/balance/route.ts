import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { getStudentById, getTransactions } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const studentId = String(searchParams.get('studentId') ?? '').trim();
    if (!studentId) return Response.json({ error: '학생 QR을 인식해 주세요.' }, { status: 400 });

    const reader = await createConfiguredSheetsReader();
    const student = await getStudentById(reader, studentId);
    if (!student || student.status !== 'ACTIVE') return Response.json({ error: '학생 정보를 찾을 수 없습니다.' }, { status: 404 });

    const transactions = (await getTransactions(reader))
      .filter((transaction) => transaction.studentId === student.studentId)
      .slice(0, 10);

    return Response.json({ studentId: student.studentId, name: student.name, balance: student.balance, transactions });
  } catch (error) {
    const message = error instanceof Error ? error.message : '잔액을 불러오지 못했습니다.';
    return Response.json({ error: message }, { status: 500 });
  }
}
