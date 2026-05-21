import { notFound } from 'next/navigation';
import { AdminGeneratorPage } from '@/components/AdminGeneratorPage';
import { isSystemDeployment } from '@/server/deploymentMode';

export default function Page() {
  if (isSystemDeployment() && process.env.GOOGLE_REFRESH_TOKEN?.trim()) {
    notFound();
  }

  return <AdminGeneratorPage />;
}
