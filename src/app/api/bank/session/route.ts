import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import {
  authenticateStudentBankRequest,
  clearedStudentBankSessionCookie,
  confirmStudentBankStudent,
  createStudentBankSession,
  isStudentBankSessionConfigured,
  resolveStudentBankScope,
  studentBankJson,
  studentBankProfile,
  studentBankScopeUnavailable,
  studentBankSessionCookie,
  studentBankUnavailable,
} from '@/server/studentBankSession';
import {
  resolveStudentQrForCurrentTenant,
  StudentQrConfigurationError,
} from '@/server/studentQr';

export const dynamic = 'force-dynamic';

const MAX_QR_BYTES = 512;
const INVALID_LOGIN = { error: 'QR 코드를 다시 찍어 주세요.', code: 'INVALID_REQUEST' };
const UNKNOWN_STUDENT = { error: '등록된 학생 QR 코드가 아니에요. 다시 확인해 주세요.', code: 'STUDENT_NOT_FOUND' };
const QR_UNAVAILABLE = { error: 'QR을 확인할 수 없어요. 선생님께 알려 주세요.', code: 'QR_UNAVAILABLE' };
const SESSION_UNAVAILABLE = { error: '지금은 은행에 로그인할 수 없어요. 선생님께 알려 주세요.', code: 'BANK_SESSION_UNAVAILABLE' };

/** Who is logged in on this device: name and current balance, re-read on every call. */
export async function GET(request: Request) {
  const auth = authenticateStudentBankRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const reader = await createConfiguredStudentBankReader(request);
    const checked = await confirmStudentBankStudent(auth, reader);
    if (!checked.ok) return checked.response;
    return studentBankJson(studentBankProfile(checked.student, auth.session));
  } catch {
    return studentBankUnavailable();
  }
}

/** Log in with the student's own QR value. This is the only bank request that carries the QR. */
export async function POST(request: Request) {
  const scope = resolveStudentBankScope();
  if (!scope) return studentBankScopeUnavailable();

  let qrValue: string;
  try {
    if (new URL(request.url).search !== ''
      || request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return studentBankJson(INVALID_LOGIN, { status: 400 });
    }
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'studentQr')) {
      return studentBankJson(INVALID_LOGIN, { status: 400 });
    }
    const studentQr: unknown = (body as Record<string, unknown>).studentQr;
    if (typeof studentQr !== 'string' || Buffer.byteLength(studentQr, 'utf8') > MAX_QR_BYTES || !studentQr.trim()) {
      return studentBankJson(INVALID_LOGIN, { status: 400 });
    }
    qrValue = studentQr.trim();
  } catch {
    return studentBankJson(INVALID_LOGIN, { status: 400 });
  }

  if (!isStudentBankSessionConfigured()) return studentBankJson(SESSION_UNAVAILABLE, { status: 503 });

  let studentId: string;
  try {
    studentId = (await resolveStudentQrForCurrentTenant(qrValue)).studentId;
  } catch (error) {
    if (error instanceof StudentQrConfigurationError) {
      // The problem code names the failed check only; it never contains key material.
      console.error('[student-qr] signing configuration invalid', error.problem ?? 'UNKNOWN');
      return studentBankJson(QR_UNAVAILABLE, { status: 503 });
    }
    return studentBankJson(UNKNOWN_STUDENT, { status: 404 });
  }

  try {
    const reader = await createConfiguredStudentBankReader(request);
    const lookup = await reader.confirmStudent(studentId);
    if (lookup.status === 'UNAVAILABLE') return studentBankUnavailable();
    if (lookup.status !== 'FOUND' || lookup.student.studentId !== studentId || lookup.student.status !== 'ACTIVE') {
      return studentBankJson(UNKNOWN_STUDENT, { status: 404 });
    }
    const session = createStudentBankSession(scope, lookup.student.studentId);
    return studentBankJson(studentBankProfile(lookup.student, session), {
      setCookie: studentBankSessionCookie(session, scope),
    });
  } catch {
    return studentBankUnavailable();
  }
}

/** Log out on this device. Always clears the cookie, valid or not. */
export async function DELETE(request: Request) {
  void request;
  const scope = resolveStudentBankScope();
  if (!scope) return studentBankScopeUnavailable();
  return studentBankJson({ ok: true }, { setCookie: clearedStudentBankSessionCookie(scope) });
}
