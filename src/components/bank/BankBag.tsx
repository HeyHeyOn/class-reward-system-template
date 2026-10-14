'use client';

/* eslint-disable @next/next/no-img-element */
import { forwardRef, useState } from 'react';
import { DIGITAL_KIND_LABELS, bagItemOrigin, bagItemUse, bagStackImage, isVoucherItem, stackBagItems, type BagItemStack } from '@/lib/studentBagApi';
import { Callout, EmptyState, Icon, IconButton, Modal, Spinner } from '../ui';
import { ItemPicture } from '../bag/ItemPicture';
import type { StudentBagDto } from './bankClient';
import { formatSeoulDateTime } from './format';

/** The '내 보관함' menu on the bank home: how many items the student can use. */
export function BankBagMenu({ bag, onOpen }: Readonly<{ bag: StudentBagDto; onOpen: () => void }>) {
  const count = bag.items.length;
  const summary = count > 0 ? `아이템 ${count}개` : '아직 비어 있어요';
  return (
    <button type="button" onClick={onOpen} aria-label={`내 보관함, ${summary}`}
      className="mt-4 flex w-full items-center gap-4 rounded-[22px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-5 text-left shadow-[var(--crs-shadow-sm)] transition-[transform,background-color] duration-150 hover:bg-[var(--crs-subtle-hover)] active:scale-[0.99]">
      <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--theme-accent-soft)] text-[var(--theme-accent-text)]">
        <Icon name="package" size={24} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[18px] font-black tracking-[-0.02em]">내 보관함</span>
        <span className="mt-0.5 block text-[13px] font-semibold text-[var(--theme-muted-text)]">{summary}</span>
      </span>
      <Icon name="chevronRight" size={20} className="shrink-0 text-[var(--theme-muted-text)]" />
    </button>
  );
}

/** A tapped item: its big picture, how to use it and the teacher's description. */
function ItemDetail({ stack, onClose }: Readonly<{ stack: BagItemStack; onClose: () => void }>) {
  const item = stack.first;
  const count = stack.items.length;
  const picture = bagStackImage(stack);
  return (
    <Modal title={item.title} onClose={onClose} size="sm"
      description={`${isVoucherItem(item) ? '교환권' : DIGITAL_KIND_LABELS[item.kind]}${count > 1 ? `, ${count}개 가지고 있어요` : ''}`}>
      <div className="space-y-4">
        <div className="mx-auto flex aspect-square w-full max-w-[280px] items-center justify-center overflow-hidden rounded-[22px] border border-[var(--crs-line)] bg-[var(--crs-subtle)]">
          {picture
            ? <img src={picture} alt={`${item.title} 그림`} className="h-full w-full object-contain" />
            : <Icon name={item.kind === 'COLLECTIBLE' ? 'sparkle' : 'ticket'} size={88} className="text-[var(--theme-accent-text)]" />}
        </div>
        {item.description ? <p className="whitespace-pre-line text-[15px] leading-relaxed">{item.description}</p> : null}
        <p className="rounded-[14px] bg-[var(--crs-subtle)] px-4 py-3 text-[14px] font-semibold leading-relaxed text-[var(--theme-muted-text)]">{bagItemUse(item)}</p>
        <ul className="space-y-1 text-[13px] text-[var(--theme-muted-text)]">
          {stack.items.slice(0, 20).map((entry) => (
            <li key={entry.itemId}>{bagItemOrigin(entry)}, {formatSeoulDateTime(entry.issuedAt)}</li>
          ))}
          {count > 20 ? <li>그 밖에 {count - 20}개</li> : null}
        </ul>
      </div>
    </Modal>
  );
}

type BankBagViewProps = Readonly<{ bag: StudentBagDto | null; loading: boolean; error: string; onBack: () => void; onRefresh: () => void }>;

/** The student's 보관함: the items they can still use, the same product stacked as ×N. Used items disappear. */
export const BankBagView = forwardRef<HTMLHeadingElement, BankBagViewProps>(function BankBagView({ bag, loading, error, onBack, onRefresh }, headingRef) {
  const [openKey, setOpenKey] = useState('');
  const stacks = stackBagItems((bag?.items ?? []).filter((item) => item.usedAt === null));
  const opened = stacks.find((stack) => stack.key === openKey);
  return (
    <div className="pb-[max(2rem,calc(env(safe-area-inset-bottom)+1.5rem))] pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-center gap-2">
        <IconButton icon="chevronLeft" label="홈으로 돌아가기" onClick={onBack} className="-ml-2" size="lg" />
        <h2 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 truncate text-[22px] font-black tracking-[-0.03em] outline-none">내 보관함</h2>
        <IconButton icon="refresh" label="보관함 새로고침" onClick={onRefresh} disabled={loading} />
      </header>
      {error ? <div role="alert" className="mt-4"><Callout tone="danger">{error}</Callout></div> : null}
      {!bag && loading ? (
        <div role="status" className="mt-10 flex flex-col items-center gap-3 text-[15px] font-bold text-[var(--theme-muted-text)]">
          <Spinner size={26} className="text-[var(--theme-accent-text)]" />보관함을 여는 중이에요.
        </div>
      ) : null}
      {bag && stacks.length === 0 ? (
        <div className="mt-6"><EmptyState icon="package" title="보관함이 비어 있어요" description="학급 나무를 수확하거나 매점에서 디지털 상품을 사면 여기에 모여요." /></div>
      ) : null}
      {stacks.length > 0 ? (
        <>
          <p className="mt-3 text-[14px] font-semibold text-[var(--theme-muted-text)]">아이템을 누르면 자세히 볼 수 있어요.</p>
          <ul className="mt-4 space-y-2">
            {stacks.map((stack) => {
              const item = stack.first;
              return (
                <li key={stack.key}>
                  <button type="button" onClick={() => setOpenKey(stack.key)} aria-label={`${item.title}${stack.items.length > 1 ? ` ${stack.items.length}개` : ''}, 자세히 보기`}
                    className="flex w-full items-center gap-3 rounded-[18px] border border-[var(--crs-line)] bg-[var(--theme-surface)] px-4 py-3 text-left shadow-[var(--crs-shadow-sm)] transition-[transform,background-color] duration-150 hover:bg-[var(--crs-subtle-hover)] active:scale-[0.99]">
                    <ItemPicture imageUrl={bagStackImage(stack)} kind={item.kind} voucher={isVoucherItem(item)} size={52} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[16px] font-extrabold">{item.title}</span>
                      <span className="block truncate text-[12px] font-semibold text-[var(--theme-muted-text)]">{bagItemUse(item)}</span>
                    </span>
                    {stack.items.length > 1 ? <span className="shrink-0 rounded-full bg-[var(--theme-accent-soft)] px-2.5 py-0.5 text-[14px] font-black tabular-nums text-[var(--theme-accent-text)]">×{stack.items.length}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {opened ? <ItemDetail stack={opened} onClose={() => setOpenKey('')} /> : null}
    </div>
  );
});
