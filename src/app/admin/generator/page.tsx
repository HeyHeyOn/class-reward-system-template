import { notFound } from 'next/navigation';
import { AdminGeneratorPage } from '@/components/AdminGeneratorPage';
import { isSystemDeployment } from '@/server/deploymentMode';

export const metadata = { title: '학급 보상 시스템' };

export default function Page() {
  if (isSystemDeployment()) {
    notFound();
  }

  return <AdminGeneratorPage />;
}
