import { isGoogleOAuthEnabled } from '@/server/googleOAuth';
import { getTeacherGoogleSessionFromRequest } from '@/server/teacherSession';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isGoogleOAuthEnabled()) {
    return Response.json({ enabled: false, authenticated: false });
  }

  const session = await getTeacherGoogleSessionFromRequest(request);
  return Response.json({
    enabled: true,
    authenticated: Boolean(session),
    email: session?.email,
    name: session?.name,
  }, { headers: { 'cache-control': 'no-store' } });
}
