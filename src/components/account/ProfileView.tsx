'use client';

import { useState } from 'react';
import { SiteFooter } from '../SiteFooter';
import { AvatarEditor } from '../profile/AvatarEditor';
import { isSameAvatar, type AvatarConfig } from '../profile/avatar';
import { UserAvatar } from '../profile/UserAvatar';
import { Button, Modal } from '../ui';
import { controlClass, cx } from '../ui/classes';
import { Icon } from '../ui/icons';
import { themeStyles } from '../uiTheme';
import { accountRequest } from './accountApi';
import { LegalAgreementGate, type LegalNoticeView } from './LegalAgreementGate';
import { WithdrawalConfirm } from './WithdrawalConfirm';

const theme = themeStyles('white');

export type ProfileViewModel = Readonly<{
  email: string;
  profile: Readonly<{ nickname: string; avatar: AvatarConfig }>;
  /** `agreedAtLabel` is formatted on the server, so the page renders the same text in the browser. */
  agreement: Readonly<{ effectiveLabel: string; agreedAtLabel: string }> | null;
  classNames: readonly string[];
  notice: LegalNoticeView;
}>;

function Section({ title, description, children, tone }: Readonly<{ title: string; description?: string; children: React.ReactNode; tone?: 'danger' }>) {
  return (
    <section aria-label={title} className={cx('rounded-[22px] border bg-[var(--theme-surface)] p-5 shadow-[var(--crs-shadow-sm)] sm:p-6',
      tone === 'danger' ? 'border-[var(--crs-danger-bg)]' : 'border-[var(--crs-line)]')}>
      <h2 className={cx('text-[17px] font-extrabold tracking-[-0.02em]', tone === 'danger' && 'text-[var(--crs-danger-text)]')}>{title}</h2>
      {description ? <p className="mt-1 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function ProfileView({ model }: Readonly<{ model: ProfileViewModel }>) {
  const [saved, setSaved] = useState(model.profile);
  const [nickname, setNickname] = useState(model.profile.nickname);
  const [avatar, setAvatar] = useState(model.profile.avatar);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const trimmed = nickname.trim().replace(/\s+/g, ' ');
  const nicknameValid = trimmed.length > 0 && [...trimmed].length <= 20;
  const changed = trimmed !== saved.nickname || !isSameAvatar(avatar, saved.avatar);

  async function save() {
    setBusy(true);
    setStatus('');
    setError('');
    const reply = await accountRequest('/api/account/profile', 'POST', { nickname: trimmed, avatar, expectedSessionId: model.notice.expectedSessionId });
    setBusy(false);
    if (!reply.ok) {
      setError(reply.error ?? '프로필을 저장하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
      return;
    }
    setSaved({ nickname: trimmed, avatar });
    setNickname(trimmed);
    setStatus('프로필을 저장했어요.');
  }

  async function logout() {
    setLogoutBusy(true);
    try {
      const response = await fetch('/api/google/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error();
      window.location.replace('/classes');
    } catch {
      setLogoutBusy(false);
      setError('로그아웃하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
    }
  }

  return (
    <main style={theme.variables} className="min-h-screen bg-[var(--theme-shell)] px-4 py-6 text-[var(--theme-text)] sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-3xl">
        <a href="/classes" className="inline-flex items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-[13px] font-semibold text-[var(--theme-muted-text)] transition-colors hover:bg-[var(--crs-subtle-hover)] hover:text-[var(--theme-text)]">
          <Icon name="chevronLeft" size={16} />메인 화면으로
        </a>
        <header className="mt-4 flex items-center gap-4">
          <UserAvatar config={saved.avatar} size={64} title={`${saved.nickname}의 프로필 아이콘`} />
          <div className="min-w-0">
            <h1 className="truncate text-[26px] font-black tracking-[-0.035em]">{saved.nickname}</h1>
            <p className="truncate text-[13px] text-[var(--theme-muted-text)]">{model.email}</p>
          </div>
        </header>

        <div className="mt-6 space-y-5">
          <Section title="프로필" description="학급 화면과 메인 화면에 보이는 이름과 아이콘이에요.">
            <label htmlFor="profile-nickname" className="mb-1.5 block text-[13px] font-bold">닉네임</label>
            <input id="profile-nickname" value={nickname} maxLength={20} onChange={(event) => setNickname(event.target.value)}
              aria-invalid={!nicknameValid} className={cx(controlClass, 'h-11 max-w-sm text-[15px]')} />
            <p className={cx('mt-1.5 text-[12px]', nicknameValid ? 'text-[var(--theme-muted-text)]' : 'text-[var(--crs-danger-text)]')}>
              {nicknameValid ? `1~20자 (${[...trimmed].length}/20)` : '닉네임은 1~20자로 써 주세요.'}
            </p>
            <h3 className="mb-2 mt-5 text-[13px] font-bold">프로필 아이콘</h3>
            <AvatarEditor value={avatar} onChange={setAvatar} />
            <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
              <p role="status" className="mr-auto text-[13px] font-semibold text-[var(--theme-muted-text)]">{status}</p>
              {error ? <p role="alert" className="text-[13px] font-semibold text-[var(--crs-danger-text)]">{error}</p> : null}
              <Button variant="primary" icon="check" onClick={() => void save()} disabled={!changed || !nicknameValid || busy} loading={busy}>저장하기</Button>
            </div>
          </Section>

          <Section title="계정">
            <dl className="grid gap-y-3 text-[14px] sm:grid-cols-[140px_minmax(0,1fr)]">
              <dt className="font-bold">로그인 계정</dt>
              <dd className="min-w-0 break-all text-[var(--theme-muted-text)]">{model.email} (Google)</dd>
              <dt className="font-bold">약관 동의</dt>
              <dd className="text-[var(--theme-muted-text)]">
                {model.agreement
                  ? <>{model.agreement.effectiveLabel} 시행 이용약관·개인정보처리방침 ({model.agreement.agreedAtLabel} 동의)</>
                  : '동의 기록이 없어요.'}
                <span className="mt-1 flex gap-3 text-[13px]">
                  <a href="/terms" className="font-semibold text-[var(--theme-accent-text)] underline underline-offset-2">이용약관</a>
                  <a href="/privacy" className="font-semibold text-[var(--theme-accent-text)] underline underline-offset-2">개인정보처리방침</a>
                </span>
              </dd>
            </dl>
            <div className="mt-4 flex justify-end">
              <Button variant="secondary" icon="logout" onClick={() => void logout()} disabled={logoutBusy} loading={logoutBusy}>로그아웃</Button>
            </div>
          </Section>

          <Section title="회원 탈퇴" tone="danger" description="탈퇴하면 계정과 내가 만든 학급이 모두 정리되고, 되살릴 수 없어요.">
            <Button variant="dangerGhost" icon="alert" onClick={() => setWithdrawOpen(true)}>탈퇴하기</Button>
          </Section>
        </div>
        <SiteFooter className="mt-8 border-t border-[var(--crs-line)] px-1 pt-6 pb-3 text-[11px] text-[var(--theme-muted-text)]" />
      </div>

      {withdrawOpen ? (
        <Modal title="정말 탈퇴할까요?" description="탈퇴하면 아래처럼 처리돼요." onClose={() => setWithdrawOpen(false)} size="md" tone="danger">
          <WithdrawalConfirm classNames={model.classNames} expectedSessionId={model.notice.expectedSessionId} onCancel={() => setWithdrawOpen(false)} />
        </Modal>
      ) : null}
      <LegalAgreementGate notice={model.notice} classNames={model.classNames} />
    </main>
  );
}
