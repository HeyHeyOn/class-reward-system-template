import { Suspense } from 'react';
import { AdminLoginPage } from '@/components/AdminLoginPage';

export default function AdminLoginRoute() {
  const googleLoginEnabled = !process.env.GOOGLE_REFRESH_TOKEN?.trim();
  return (
    <Suspense fallback={null}>
      <AdminLoginPage googleLoginEnabled={googleLoginEnabled} />
    </Suspense>
  );
}
