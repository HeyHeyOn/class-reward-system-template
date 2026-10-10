'use client';

import { useId, type ReactNode } from 'react';
import { cx, focusRing } from '../ui/classes';
import { Icon } from '../ui/icons';
import {
  AVATAR_PART_KEYS, AVATAR_PART_LABELS, AVATAR_PARTS, AVATAR_PRESETS,
  describeAvatar, isSameAvatar, type AvatarConfig, type AvatarPartKey,
} from './avatar';
import { UserAvatar } from './UserAvatar';

function withPart(config: AvatarConfig, part: AvatarPartKey, id: string): AvatarConfig {
  return { ...config, [part]: id };
}

const gridClass = 'grid grid-cols-[repeat(auto-fill,minmax(68px,1fr))] gap-2';

function OptionButton({ label, visibleLabel, preview, active, onClick }: { label: string; visibleLabel: string; preview: AvatarConfig; active: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} aria-pressed={active} onClick={onClick}
      className={cx(
        'relative flex min-w-0 flex-col items-center gap-1 rounded-[14px] border px-1 pb-1.5 pt-2 text-center transition-[background-color,border-color,box-shadow] duration-150',
        focusRing,
        active
          ? 'border-[var(--theme-accent-text)] bg-[var(--theme-accent-soft)] shadow-[inset_0_0_0_1px_var(--theme-accent-text)]'
          : 'border-[var(--crs-line)] bg-[var(--theme-surface)] hover:border-[var(--crs-line-strong)] hover:bg-[var(--crs-subtle-hover)]',
      )}>
      <UserAvatar config={preview} size={44} title="" />
      <span className={cx('block w-full break-keep text-[11.5px] leading-[15px]',
        active ? 'font-bold text-[var(--theme-accent-text)]' : 'font-semibold text-[var(--theme-muted-text)]')}>
        {visibleLabel}
      </span>
      {active ? (
        <span aria-hidden="true" className="absolute -right-1.5 -top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--theme-accent-text)] text-[var(--theme-surface)] shadow-[var(--crs-shadow-sm)]">
          <Icon name="check" size={12} strokeWidth={3} />
        </span>
      ) : null}
    </button>
  );
}

function OptionGroup({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div role="group" aria-labelledby={id} className="min-w-0">
      <h3 id={id} className="mb-2 text-[13px] font-bold text-[var(--theme-text)]">{title}</h3>
      <div className={gridClass}>{children}</div>
    </div>
  );
}

export function AvatarEditor({ value, onChange }: { value: AvatarConfig; onChange: (next: AvatarConfig) => void }) {
  const uid = useId();
  const description = describeAvatar(value);
  return (
    <div className="grid min-w-0 gap-6 md:grid-cols-[200px_minmax(0,1fr)] md:items-start">
      <div className="flex items-center gap-4 rounded-[var(--crs-radius-lg)] border border-[var(--crs-line)] bg-[var(--crs-subtle)] p-4 md:sticky md:top-4 md:flex-col md:py-6 md:text-center">
        <UserAvatar config={value} size={128} title="프로필 아이콘 미리보기" className="h-24 w-24 md:h-32 md:w-32" />
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-[var(--theme-text)]">미리보기</p>
          <p className="mt-0.5 break-keep text-xs leading-relaxed text-[var(--theme-muted-text)]">{description}</p>
        </div>
      </div>

      <div className="min-w-0 space-y-5">
        <OptionGroup id={`${uid}-presets`} title="추천 조합">
          {AVATAR_PRESETS.map((preset) => (
            <OptionButton key={preset.id} label={`추천 조합: ${preset.label}`} visibleLabel={preset.label} preview={preset.config}
              active={isSameAvatar(value, preset.config)} onClick={() => onChange(preset.config)} />
          ))}
        </OptionGroup>

        {AVATAR_PART_KEYS.map((part) => (
          <OptionGroup key={part} id={`${uid}-${part}`} title={AVATAR_PART_LABELS[part]}>
            {AVATAR_PARTS[part].map((option) => (
              <OptionButton key={option.id} label={`${AVATAR_PART_LABELS[part]}: ${option.label}`} visibleLabel={option.label}
                preview={withPart(value, part, option.id)} active={value[part] === option.id}
                onClick={() => onChange(withPart(value, part, option.id))} />
            ))}
          </OptionGroup>
        ))}
      </div>
    </div>
  );
}
