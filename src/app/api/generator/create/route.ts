import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClassRewardSpreadsheet } from '@/generator/createSpreadsheet';
import { normalizeClassRewardCreateOptions } from '@/generator/createOptions';
import { THEME_COLORS } from '@/generator/config/schema';
import { isGeneratorDeployment } from '@/server/deploymentMode';
import { claimGeneratorGrant } from '@/server/repositories/configuredGeneratorGrantClaims';
import {
  clearGeneratorGrantCookie,
  getGeneratorGrantFromRequest,
  getGoogleSessionFromRequest,
  revokeGeneratorGrant,
  type GeneratorGrant,
  type GoogleSession,
} from '@/server/googleOAuth';

export const dynamic = 'force-dynamic';

type CreateRequestBody = {
  className?: unknown;
  appTitle?: unknown;
  bankTitle?: unknown;
  currencyUnit?: unknown;
  themeColor?: unknown;
  adminPasswordConfigured?: unknown;
  selfServiceAcknowledged?: unknown;
};

export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse('generator-sheets');
  if (frozen) return frozen;

  let grant: GeneratorGrant | null = null;
  try {
    if (!isGeneratorDeployment()) {
      return grantResponse({ error: '생성 API는 생성기 배포에서만 사용할 수 있습니다.' }, 404);
    }

    const session = getGoogleSessionFromRequest(request);
    if (!session) {
      return grantResponse({ error: '먼저 Google 계정으로 로그인해 주세요.' }, 401);
    }
    grant = getGeneratorGrantFromRequest(request, session);
    if (!grant) {
      return grantResponse({ error: 'Google Sheets 생성 권한이 없거나 만료되었습니다. 같은 Google 계정으로 권한을 다시 승인해 주세요.' }, 401);
    }

    const claimed = await claimGeneratorGrant(grant);
    if (!claimed) {
      return grantResponse({ error: 'Google Sheets 생성 권한이 이미 사용되었거나 만료되었습니다. 권한을 다시 승인해 주세요.' }, 401);
    }

    const body = (await request.json()) as CreateRequestBody;
    if (body.selfServiceAcknowledged !== true) {
      throw new Error('개인 Google/Vercel 계정 사용 안내를 숙지했다는 확인이 필요합니다.');
    }

    const options = normalizeClassRewardCreateOptions({
      className: optionalString(body.className),
      appTitle: optionalString(body.appTitle),
      bankTitle: optionalString(body.bankTitle),
      currencyUnit: optionalString(body.currencyUnit),
      themeColor: optionalString(body.themeColor),
      adminPasswordConfigured: body.adminPasswordConfigured === true,
    });

    if (!THEME_COLORS.includes(options.themeColor as (typeof THEME_COLORS)[number])) {
      throw new Error(`지원하지 않는 테마입니다: ${options.themeColor}`);
    }

    const result = await createClassRewardSpreadsheet(options, request, grant);
    const deploymentEnv = buildRequiredVercelEnv(result.spreadsheetId, session, grant);
    return grantResponse({
      ok: true,
      ...result,
      requiredVercelEnv: deploymentEnv,
      nextSteps: [
        '생성된 스프레드시트의 Students/Products 시트에 학생과 상품을 입력합니다.',
        '선생님 개인 Vercel 계정에서 학급 보상 시스템 템플릿을 Import/Deploy합니다.',
        '운영 Vercel 프로젝트에 아래 환경변수 6개를 모두 입력합니다.',
        '배포 완료 후 /, /bank, /admin/login 주소가 열리고 시트 데이터가 표시되는지 확인합니다.',
      ],
      deploymentGuide: buildDeploymentGuide(result.spreadsheetId),
    });
  } catch (error) {
    if (grant) {
      await revokeGeneratorGrant(grant).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : '시스템을 생성하지 못했습니다.';
    return grantResponse({ error: message }, 400);
  }
}

function grantResponse(body: unknown, status = 200) {
  const response = NextResponse.json(body, { status });
  // The browser cannot retry with a consumed grant after either success or failure.
  clearGeneratorGrantCookie(response);
  return response;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function buildRequiredVercelEnv(spreadsheetId: string, session: GoogleSession, grant: GeneratorGrant) {
  const clientId = process.env.GENERATOR_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GENERATOR_GOOGLE_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error('운영 앱 배포에 필요한 생성기 Google OAuth 인증값을 만들지 못했습니다.');
  }

  return [
    { name: 'GOOGLE_SHEET_ID', value: spreadsheetId, secret: false },
    { name: 'GOOGLE_CLIENT_ID', value: clientId, secret: false },
    // Intentionally distributed only to this consenting user's generated deployment.
    { name: 'GOOGLE_CLIENT_SECRET', value: clientSecret, secret: true },
    { name: 'GOOGLE_REFRESH_TOKEN', value: grant.refreshToken, secret: true },
    { name: 'ADMIN_PASSWORD', value: session.email, secret: true },
    { name: 'AUTH_SECRET', value: randomBytes(32).toString('base64url'), secret: true },
  ];
}

function buildDeploymentGuide(spreadsheetId: string) {
  const templateRepositoryUrl = process.env.NEXT_PUBLIC_CLASS_STORE_TEMPLATE_REPO?.trim();
  const envNames = ['GOOGLE_SHEET_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'ADMIN_PASSWORD', 'AUTH_SECRET'];
  const envDescription = '학급 보상 시스템 운영에 필요한 환경변수입니다. 6개 값을 모두 입력해야 배포된 앱이 Google Sheets를 읽고 쓸 수 있습니다.';
  const vercelImportUrl = templateRepositoryUrl
    ? `https://vercel.com/new/clone?${new URLSearchParams({
        'repository-url': templateRepositoryUrl,
        env: envNames.join(','),
        envDescription,
      }).toString()}`
    : 'https://vercel.com/new';

  return {
    ownership: '선생님 개인 Google 계정 + 선생님 개인 Vercel 프로젝트',
    vercelImportUrl,
    checklist: [
      templateRepositoryUrl ? '개인 Vercel 계정으로 Import Project를 진행합니다.' : '개인 Vercel 계정에서 New Project를 열고 학급 보상 시스템 템플릿 저장소를 Import합니다.',
      `GOOGLE_SHEET_ID에 ${spreadsheetId} 값을 입력합니다.`,
      'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN도 함께 입력해야 운영 앱이 시트를 읽고 쓸 수 있습니다.',
      'ADMIN_PASSWORD는 생성기에 로그인한 Google 이메일 주소로 자동 입력합니다. 배포 후 관리자 설정에서 변경할 수 있습니다.',
      'AUTH_SECRET은 생성기가 만든 무작위 문자열을 그대로 붙여넣습니다. 외울 필요는 없습니다.',
      '배포 완료 후 /, /bank, /admin/login 주소가 열리는지 확인합니다.',
    ],
  };
}
