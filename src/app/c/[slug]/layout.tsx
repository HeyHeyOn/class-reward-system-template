import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { parseTenantSlug, TenantContextError } from '@/server/tenantContext';

export default async function TenantLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ slug: string }>;
}>) {
  const { slug } = await params;
  try {
    parseTenantSlug(slug);
  } catch (error) {
    if (!(error instanceof TenantContextError)) throw error;
    notFound();
  }
  return children;
}
