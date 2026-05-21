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
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CreateRequestBody;
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
        '운영 Vercel 프로젝트에 GOOGLE_SHEET_ID를 새 스프레드시트 ID로 설정합니다.',
        'ADMIN_PASSWORD와 AUTH_SECRET을 production 환경변수로 설정한 뒤 재배포합니다.',
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '시스템을 생성하지 못했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
