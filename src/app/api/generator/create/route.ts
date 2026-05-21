import { createClassRewardSpreadsheet } from '@/generator/createSpreadsheet';
import { normalizeClassRewardCreateOptions } from '@/generator/createOptions';
import { THEME_COLORS } from '@/generator/config/schema';

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
  try {
    const body = (await request.json()) as CreateRequestBody;
    if (body.selfServiceAcknowledged !== true) {
      return Response.json({ error: '개인 Google/Vercel 계정 사용 안내를 숙지했다는 확인이 필요합니다.' }, { status: 400 });
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
      return Response.json({ error: `지원하지 않는 테마입니다: ${options.themeColor}` }, { status: 400 });
    }

    const result = await createClassRewardSpreadsheet(options, request);
    return Response.json({
      ok: true,
      ...result,
      requiredVercelEnv: [
        { name: 'GOOGLE_SHEET_ID', value: result.spreadsheetId, secret: false },
        { name: 'ADMIN_PASSWORD', value: options.adminPasswordConfigured ? '생성 시 정한 관리자 암호' : '배포 전에 직접 설정 필요', secret: true },
        { name: 'AUTH_SECRET', value: '무작위 긴 문자열로 직접 설정', secret: true },
      ],
      nextSteps: [
        '생성된 스프레드시트의 Students/Products 시트에 학생과 상품을 입력합니다.',
        '선생님 개인 Vercel 계정에서 학급 매점 템플릿을 Import/Deploy합니다.',
        '운영 Vercel 프로젝트에 GOOGLE_SHEET_ID를 새 스프레드시트 ID로 설정합니다.',
        'ADMIN_PASSWORD와 AUTH_SECRET을 production 환경변수로 설정한 뒤 재배포합니다.',
      ],
      deploymentGuide: buildDeploymentGuide(result.spreadsheetId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '시스템을 생성하지 못했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function buildDeploymentGuide(spreadsheetId: string) {
  const templateRepositoryUrl = process.env.NEXT_PUBLIC_CLASS_STORE_TEMPLATE_REPO?.trim();
  const envDescription = '학급 매점 운영에 필요한 환경변수입니다. GOOGLE_SHEET_ID는 생성된 시트 ID를 넣고, ADMIN_PASSWORD와 AUTH_SECRET은 선생님이 직접 정합니다.';
  const vercelImportUrl = templateRepositoryUrl
    ? `https://vercel.com/new/clone?repository-url=${encodeURIComponent(templateRepositoryUrl)}&env=GOOGLE_SHEET_ID,ADMIN_PASSWORD,AUTH_SECRET&envDescription=${encodeURIComponent(envDescription)}`
    : 'https://vercel.com/new';

  return {
    ownership: '선생님 개인 Google 계정 + 선생님 개인 Vercel 프로젝트',
    vercelImportUrl,
    checklist: [
      templateRepositoryUrl ? '개인 Vercel 계정으로 Import Project를 진행합니다.' : '개인 Vercel 계정에서 New Project를 열고 학급 매점 템플릿 저장소를 Import합니다.',
      `GOOGLE_SHEET_ID에 ${spreadsheetId} 값을 입력합니다.`,
      'ADMIN_PASSWORD는 관리자 페이지에서 사용할 비밀번호로 직접 정합니다.',
      'AUTH_SECRET은 길고 무작위인 문자열로 직접 정합니다.',
      '배포 완료 후 /, /bank, /admin/login 주소가 열리는지 확인합니다.',
    ],
  };
}
