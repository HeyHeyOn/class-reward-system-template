import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { Suspense } from 'react';
import { LegacyMigrationNotice } from '@/server/LegacyMigrationNotice';
import './globals.css';

// Pretendard (SIL OFL 1.1, fonts/pretendard/LICENSE.txt), self-hosted as one variable font.
const pretendard = localFont({
  src: './fonts/pretendard/PretendardVariable.woff2',
  weight: '45 920',
  display: 'swap',
  variable: '--font-pretendard',
});

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
    <html lang="ko" className={pretendard.variable}>
      <body>
        {children}
        <Suspense fallback={null}><LegacyMigrationNotice /></Suspense>
      </body>
    </html>
  );
}
