import { getGoogleSessionFromRequest, isGoogleOAuthEnabled } from '@/server/googleOAuth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isGoogleOAuthEnabled()) {
    return Response.json({ enabled: false, authenticated: false });
  }

  const session = getGoogleSessionFromRequest(request);
  return Response.json({
    enabled: true,
    authenticated: Boolean(session),
    email: session?.email,
    name: session?.name,
  });
}
