import type { Metadata } from 'next';
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
      <body>{children}</body>
    </html>
  );
}
