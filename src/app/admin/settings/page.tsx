import { redirect } from 'next/navigation';

export const metadata = { title: '학급 보상 시스템' };

export default function AdminSettingsPage() {
  redirect('/admin');
}
