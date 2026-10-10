import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { readClassTreeJson } from '@/server/classTreeHttp';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredStudentBag } from '@/server/repositories/configuredStudentBag';
import { studentBagAdminRequired, studentBagFailure, studentBagJson } from '@/server/studentBagHttp';

export const dynamic = 'force-dynamic';

/** 디지털 상품: store products whose purchase goes into the buyer's 보관함, with their type (the kiosk marks them). */
export async function GET(request: Request) {
  try {
    const bag = await createConfiguredStudentBag(request);
    return studentBagJson({ products: await bag.digitalProducts() });
  } catch (error) {
    return studentBagFailure(error, 'digital-products');
  }
}

/** Makes a store product digital (소모품 / 수집품) or physical again (`digital: null`). */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return studentBagAdminRequired();
  const body = await readClassTreeJson(request);
  if (body instanceof Response) return body;
  try {
    const bag = await createConfiguredStudentBag(request);
    return studentBagJson({ products: await bag.setDigitalProduct({ productId: body.value.productId, digital: body.value.digital }) });
  } catch (error) {
    return studentBagFailure(error, 'digital-product');
  }
}
