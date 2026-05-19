import { Suspense } from 'react';
import { AdminLoginPage } from '@/components/AdminLoginPage';

export default function AdminLoginRoute() {
  return (
    <Suspense fallback={null}>
      <AdminLoginPage />
    </Suspense>
  );
}
