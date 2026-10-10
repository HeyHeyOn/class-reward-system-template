// Server-safe (no hooks): the signed-in teacher's icon and nickname, linking to the profile page.
import type { AvatarConfig } from '../profile/avatar';
import { UserAvatar } from '../profile/UserAvatar';
import { cx } from '../ui/classes';

export function AccountLink({ nickname, avatar, className, compact = false }: Readonly<{ nickname: string; avatar: AvatarConfig; className?: string; compact?: boolean }>) {
  return (
    <a href="/profile" aria-label={`내 프로필: ${nickname}`} title="내 프로필"
      className={cx('inline-flex min-w-0 items-center gap-2 rounded-full py-1 pl-1 font-semibold text-[var(--theme-text)] transition-colors hover:bg-[var(--crs-subtle-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]',
        compact ? 'pr-1' : 'pr-3', className)}>
      <UserAvatar config={avatar} size={compact ? 32 : 36} title="" />
      {compact ? null : <span className="max-w-[180px] truncate">{nickname}</span>}
    </a>
  );
}
