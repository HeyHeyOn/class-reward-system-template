import { Suspense } from 'react';
import { AdminLoginPage } from '@/components/AdminLoginPage';
import { isGeneratorDeployment } from '@/server/deploymentMode';

export default function AdminLoginRoute() {
  const googleLoginEnabled = isGeneratorDeployment() || !process.env.GOOGLE_REFRESH_TOKEN?.trim();
  return (
    <Suspense fallback={null}>
      <AdminLoginPage googleLoginEnabled={googleLoginEnabled} />
    </Suspense>
  );
}
