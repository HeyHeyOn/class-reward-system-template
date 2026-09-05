import { createConfiguredBankReader } from '@/server/repositories/configuredBank';
import { resolveStudentQrForCurrentTenant, StudentQrValidationError } from '@/server/studentQr';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const qrValue = String(searchParams.get('studentId') ?? '').trim();
    if (!qrValue) return Response.json({ error: '학생 QR을 인식해 주세요.' }, { status: 400 });
    const { studentId } = resolveStudentQrForCurrentTenant(qrValue);

    const reader = await createConfiguredBankReader(request);
    const { student, transactions: allTransactions } = await reader.getBalance(studentId);
    if (!student || student.status !== 'ACTIVE') return Response.json({ error: '학생 정보를 찾을 수 없습니다.' }, { status: 404 });

    const transactions = allTransactions
      .filter((transaction) => transaction.studentId === student.studentId)
      .slice(0, 10);

    return Response.json({ studentId: student.studentId, name: student.name, balance: student.balance, transactions });
  } catch (error) {
    if (error instanceof StudentQrValidationError) {
      return Response.json({ error: '학생 정보를 찾을 수 없습니다.' }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : '잔액을 불러오지 못했습니다.';
    return Response.json({ error: message }, { status: 500 });
  }
}
