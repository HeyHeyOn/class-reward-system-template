import * as QRCode from 'qrcode';
import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredStudentReader } from '@/server/repositories/configuredStudents';
import { createSignedStudentQr, StudentQrConfigurationError, StudentQrValidationError } from '@/server/studentQr';
import { getOptionalTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';

export const dynamic = 'force-dynamic';

const GENERATION_ERROR = 'QR 코드를 생성하지 못했습니다.';
const STUDENT_ID_MAX_BYTES = 128;
const ADMIN_PASSWORD_MAX_BYTES = 512;

export function GET() {
  return Response.json({ error: GENERATION_ERROR }, {
    status: 405,
    headers: { Allow: 'POST' },
  });
}

export async function POST(request: Request) {
  if (new URL(request.url).search !== '') {
    return Response.json({ error: GENERATION_ERROR }, { status: 400 });
  }
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();
  const body = await parseBody(request);
  if (!body) return Response.json({ error: GENERATION_ERROR }, { status: 400 });

  try {
    let value: string;
    if (body.kind === 'admin') {
      value = `class-store-admin:${body.password}`;
    } else {
      const reader = await createConfiguredStudentReader();
      let student;
      try {
        student = await reader.getStudentById(body.studentId);
      } catch {
        return Response.json({ error: GENERATION_ERROR }, { status: 404 });
      }
      if (!student || student.status !== 'ACTIVE' || student.studentId !== body.studentId) {
        return Response.json({ error: GENERATION_ERROR }, { status: 404 });
      }
      const trustedTenant = getOptionalTrustedTenantRequestContext();
      value = trustedTenant
        ? createSignedStudentQr({ tenantId: trustedTenant.tenant.id, studentId: student.studentId })
        : student.studentId;
    }

    const svg = await QRCode.toString(value, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 256,
    });
    return new Response(svg, {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof StudentQrValidationError) {
      return Response.json({ error: GENERATION_ERROR }, { status: 400 });
    }
    if (error instanceof StudentQrConfigurationError) {
      return Response.json({ error: 'QR 코드 설정을 확인해 주세요.' }, { status: 503 });
    }
    return Response.json({ error: GENERATION_ERROR }, { status: 500 });
  }
}

type QrBody =
  | Readonly<{ kind: 'student'; studentId: string }>
  | Readonly<{ kind: 'admin'; password: string }>;

async function parseBody(request: Request): Promise<QrBody | null> {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return null;
  try {
    const value: unknown = await request.json();
    if (!isPlainObject(value)) return null;
    const keys = Object.keys(value);
    if (value.kind === 'student' && keys.length === 2 && keys.includes('studentId')
      && typeof value.studentId === 'string' && value.studentId === value.studentId.trim()
      && isBoundedSafe(value.studentId, STUDENT_ID_MAX_BYTES)) {
      return { kind: 'student', studentId: value.studentId };
    }
    if (value.kind === 'admin' && keys.length === 2 && keys.includes('password')
      && typeof value.password === 'string' && isBoundedSafe(value.password, ADMIN_PASSWORD_MAX_BYTES)
      && !value.password.startsWith('class-store-admin:')) {
      return { kind: 'admin', password: value.password };
    }
    return null;
  } catch {
    return null;
  }
}

function isBoundedSafe(value: string, maximumBytes: number): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && !/[\uD800-\uDFFF]/u.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
