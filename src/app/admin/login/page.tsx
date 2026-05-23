import { Suspense } from 'react';
import { AdminLoginPage } from '@/components/AdminLoginPage';

export const metadata = { title: '학급 보상 시스템' };
import { isGeneratorDeployment } from '@/server/deploymentMode';

export default function AdminLoginRoute() {
  const googleLoginEnabled = isGeneratorDeployment() || !process.env.GOOGLE_REFRESH_TOKEN?.trim();
  return (
    <Suspense fallback={null}>
      <AdminLoginPage googleLoginEnabled={googleLoginEnabled} />
    </Suspense>
  );
}
