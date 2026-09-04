import { isGeneratorDeployment } from '@/server/deploymentMode';
import { getGeneratorGrantFromRequest, getGoogleSessionFromRequest } from '@/server/googleOAuth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isGeneratorDeployment()) {
    return Response.json({ ready: false }, { status: 404 });
  }

  const session = getGoogleSessionFromRequest(request);
  if (!session) {
    return Response.json({ ready: false }, { status: 401 });
  }

  return Response.json({
    ready: Boolean(getGeneratorGrantFromRequest(request, session)),
  });
}
