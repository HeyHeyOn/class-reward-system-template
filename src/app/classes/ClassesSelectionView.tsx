import Link from 'next/link';
import type { ClassMembershipPageModel } from '@/server/classMembershipPageAccess';

export function ClassesSelectionView({
  model,
}: Readonly<{ model: ClassMembershipPageModel }>) {
  return (
    <main className="mx-auto min-h-screen max-w-2xl px-5 py-12 sm:px-8">
      <h1 className="text-3xl font-bold text-gray-900">내 학급</h1>

      {model.kind === 'LOGIN_REQUIRED' ? (
        <section className="mt-8 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <p className="text-gray-600">소속 학급을 확인하려면 Google 계정으로 로그인해 주세요.</p>
          <a
            className="mt-5 inline-flex rounded-xl bg-blue-600 px-5 py-3 font-semibold text-white hover:bg-blue-700"
            href={model.loginHref}
          >
            Google 계정으로 로그인
          </a>
        </section>
      ) : (
        <section className="mt-8">
          <p className="text-sm text-gray-600">
            <span className="font-medium text-gray-900">{model.accountLabel}</span> 계정의 학급입니다.
          </p>

          {model.memberships.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-gray-200 bg-white p-6 text-gray-600 shadow-sm">
              등록된 학급이 없습니다.
            </div>
          ) : (
            <ul className="mt-5 space-y-4">
              {model.memberships.map((membership) => (
                <li key={membership.slug} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-xl font-semibold text-gray-900">{membership.displayName}</h2>
                      <div className="mt-2 flex gap-2 text-sm">
                        <span className="rounded-full bg-gray-100 px-3 py-1 text-gray-700">{membership.roleLabel}</span>
                        <span className="rounded-full bg-gray-100 px-3 py-1 text-gray-700">{membership.lifecycleLabel}</span>
                      </div>
                    </div>
                    {membership.selectable && membership.href ? (
                      <Link
                        aria-label={`${membership.displayName} 학급으로 이동`}
                        className="rounded-xl bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700"
                        href={membership.href}
                      >
                        선택
                      </Link>
                    ) : (
                      <span className="text-sm font-medium text-gray-500">현재 선택할 수 없습니다.</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
