import { createConfiguredBankReader, type BankReader } from '@/server/repositories/configuredBank';
import { resolveStudentQrForCurrentTenant, StudentQrValidationError } from '@/server/studentQr';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const qrValue = String(searchParams.get('studentId') ?? '').trim();
  return readBalance(qrValue, () => createConfiguredBankReader(request));
}

export async function POST(request: Request) {
  let qrValue: string;
  try {
    if (new URL(request.url).search !== ''
      || request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return Response.json({ error: '학생 QR을 인식해 주세요.' }, { status: 400 });
    }
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || !('studentQr' in body)
      || typeof body.studentQr !== 'string' || Buffer.byteLength(body.studentQr, 'utf8') > 512) {
      return Response.json({ error: '학생 QR을 인식해 주세요.' }, { status: 400 });
    }
    qrValue = body.studentQr.trim();
  } catch {
    return Response.json({ error: '학생 QR을 인식해 주세요.' }, { status: 400 });
  }
  return readBalance(qrValue, () => createConfiguredBankReader(request));
}

async function readBalance(qrValue: string, createReader: () => Promise<BankReader>) {
  try {
    if (!qrValue) return Response.json({ error: '학생 QR을 인식해 주세요.' }, { status: 400 });
    const { studentId } = resolveStudentQrForCurrentTenant(qrValue);

    const reader = await createReader();
    const { student, transactions: allTransactions } = await reader.getBalance(studentId);
    if (!student || student.status !== 'ACTIVE') return Response.json({ error: '학생 정보를 찾을 수 없어요.' }, { status: 404 });

    const transactions = allTransactions
      .filter((transaction) => transaction.studentId === student.studentId)
      .slice(0, 10);

    return Response.json({ studentId: student.studentId, name: student.name, balance: student.balance, transactions });
  } catch (error) {
    if (error instanceof StudentQrValidationError) {
      return Response.json({ error: '학생 정보를 찾을 수 없어요.' }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : '잔액을 불러오지 못했어요.';
    return Response.json({ error: message }, { status: 500 });
  }
}
