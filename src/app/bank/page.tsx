import { BankApp } from '@/components/BankApp';

export const metadata = { title: '학급 은행' };

export const dynamic = 'force-dynamic';

export default function BankPage() {
  return <BankApp />;
}
