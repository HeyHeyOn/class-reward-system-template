import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LegacyMigrationNotice } from '@/server/LegacyMigrationNotice';
import './globals.css';

export const metadata: Metadata = {
  title: '학급 매점',
  description: '학급 화폐 기반 매점 키오스크',
  icons: {
    icon: '/icon.png',
    apple: '/apple-icon.png',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        {children}
        <Suspense fallback={null}><LegacyMigrationNotice /></Suspense>
      </body>
    </html>
  );
}
