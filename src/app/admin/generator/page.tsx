import { notFound } from 'next/navigation';
import { AdminGeneratorPage } from '@/components/AdminGeneratorPage';

export default function Page() {
  if (process.env.GOOGLE_REFRESH_TOKEN?.trim()) {
    notFound();
  }

  return <AdminGeneratorPage />;
}
