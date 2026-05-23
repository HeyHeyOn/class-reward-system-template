import { redirect } from 'next/navigation';

export const metadata = { title: '설정' };

export default function AdminSettingsPage() {
  redirect('/admin');
}
