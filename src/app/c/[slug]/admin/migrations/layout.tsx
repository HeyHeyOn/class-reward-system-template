import type { ReactNode } from 'react';
import { TeacherHeader } from '@/components/brand/TeacherHeader';

/** The 딴쌤 header over the data import pages. */
export default function MigrationsLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <><TeacherHeader />{children}</>;
}
