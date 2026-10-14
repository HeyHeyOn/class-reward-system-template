import { redirect } from 'next/navigation';

export const metadata = { title: '딴쌤 클래스' };

export default function AdminSettingsPage() {
  redirect('/admin');
}
