import { HomePage } from '@/components/HomePage';
import { AdminGeneratorPage } from '@/components/AdminGeneratorPage';
import { isGeneratorDeployment } from '@/server/deploymentMode';

export function generateMetadata() {
  return { title: isGeneratorDeployment() ? '학급 보상 시스템 생성기' : '학급 매점' };
}

export default function Home() {
  if (isGeneratorDeployment()) {
    return <AdminGeneratorPage />;
  }

  return <HomePage />;
}
