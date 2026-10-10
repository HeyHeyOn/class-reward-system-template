import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { classTreeAdminRequired, classTreeFailure, classTreeJson } from '@/server/classTreeHttp';
import { createConfiguredClassTree } from '@/server/repositories/configuredClassTree';

export const dynamic = 'force-dynamic';

/** The teacher's class tree screen: settings, the growing tree, contributions, harvests and coupons. */
export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return classTreeAdminRequired();
  try {
    const tree = await createConfiguredClassTree(request);
    return classTreeJson(await tree.adminBoard());
  } catch (error) {
    return classTreeFailure(error, 'board');
  }
}
