'use client';

import { AdminGeneratorPage } from './AdminGeneratorPage';
import { KioskApp } from './KioskApp';

export function HomePage() {
  if (process.env.NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT === 'generator') {
    return <AdminGeneratorPage />;
  }

  return <KioskApp />;
}
