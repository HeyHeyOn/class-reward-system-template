import { parseClassTreeSettings } from '@/domain/classTree';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { classTreeAdminRequired, classTreeFailure, classTreeJson, readClassTreeJson } from '@/server/classTreeHttp';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredClassTree } from '@/server/repositories/configuredClassTree';

export const dynamic = 'force-dynamic';

/** Saves the class tree settings; turning it on the first time plants tree No. 1. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return classTreeAdminRequired();
  const body = await readClassTreeJson(request);
  if (body instanceof Response) return body;
  const parsed = parseClassTreeSettings(body.value.settings);
  if (!parsed.ok) return classTreeJson({ error: parsed.error, code: 'INVALID_INPUT' }, 400);
  try {
    const tree = await createConfiguredClassTree(request);
    return classTreeJson(await tree.saveSettings(parsed.settings));
  } catch (error) {
    return classTreeFailure(error, 'settings');
  }
}
