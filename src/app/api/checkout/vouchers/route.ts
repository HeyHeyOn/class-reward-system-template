import { createConfiguredStudentBag } from '@/server/repositories/configuredStudentBag';
import { resolveStudentQrForCurrentTenant, StudentQrValidationError } from '@/server/studentQr';
import { studentBagFailure, studentBagJson } from '@/server/studentBagHttp';

export const dynamic = 'force-dynamic';

const MAX_PRODUCTS = 100;

/**
 * The kiosk asks, after the student's QR scan, which of the student's 교환권 fit the cart. Knowing the
 * QR is what pays at the kiosk anyway, so it is enough to see them.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const { studentId: qr, productIds } = record;
  if (typeof qr !== 'string' || !qr.trim() || !Array.isArray(productIds) || productIds.length === 0 || productIds.length > MAX_PRODUCTS
    || productIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 200)) {
    return studentBagJson({ error: '결제 요청 형식이 올바르지 않아요.', code: 'INVALID_INPUT' }, 400);
  }
  try {
    const { studentId } = resolveStudentQrForCurrentTenant(qr.trim());
    const bag = await createConfiguredStudentBag(request);
    return studentBagJson({ vouchers: await bag.checkoutVouchers(studentId, (productIds as string[]).map((id) => id.trim())) });
  } catch (error) {
    if (error instanceof StudentQrValidationError) {
      return studentBagJson({ error: '학생 정보를 찾을 수 없어요.', code: 'STUDENT_NOT_FOUND' }, 400);
    }
    return studentBagFailure(error, 'checkout-vouchers');
  }
}
