import Link from 'next/link';
import { SettingsForm } from '@/components/SettingsForm';

export default function AdminSettingsPage() {
  return (
    <main className="min-h-screen bg-[#f6f1e8] px-6 py-8 text-slate-950">
      <section className="mx-auto max-w-3xl">
        <Link href="/" className="font-bold text-slate-600 hover:text-slate-950">
          ← 키오스크로 돌아가기
        </Link>

        <div className="mt-6 rounded-[2rem] bg-slate-950 p-6 text-white shadow-xl">
          <p className="text-sm font-bold tracking-[0.3em] text-amber-300">ADMIN</p>
          <h1 className="mt-2 text-4xl font-black">관리자 설정</h1>
          <p className="mt-3 text-slate-300">
            학급마다 다른 Google Sheets를 연결할 수 있도록 이 화면에서 시트 ID를 저장합니다.
          </p>
        </div>

        <div className="mt-6">
          <SettingsForm />
        </div>

        <section className="mt-6 rounded-[2rem] bg-white p-6 shadow-sm ring-1 ring-black/5">
          <h2 className="text-2xl font-black">사용 전 확인</h2>
          <ul className="mt-4 list-disc space-y-2 pl-6 text-slate-600">
            <li>스프레드시트에는 Students, Products, Transactions, Adjustments 시트가 있어야 합니다.</li>
            <li>서비스 계정 이메일을 해당 스프레드시트에 편집자로 공유해야 합니다.</li>
            <li>QR 코드에는 학생 이름이 아니라 S001 같은 studentId만 넣습니다.</li>
          </ul>
        </section>
      </section>
    </main>
  );
}
