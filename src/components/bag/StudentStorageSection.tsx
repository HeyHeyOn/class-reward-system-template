'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DIGITAL_KIND_LABELS, bagStackImage, bagStackOrigin, isVoucherItem, stackBagItems, type BagItemDto, type BagItemStack,
} from '@/lib/studentBagApi';
import { Button, Callout, Icon, SegmentedControl, Spinner } from '../ui';
import { fetchStudentBag, giveBagItems, revokeBagItem, setBagItemUsed } from './bagClient';
import { GiveProductFields, giveOptionItemName, type GiveOption } from './GiveProductFields';
import { ItemPicture } from './ItemPicture';

const dateLabel = (iso: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' }).format(new Date(iso));
const newest = (items: readonly BagItemDto[], at: (item: BagItemDto) => string) =>
  [...items].sort((left, right) => at(right).localeCompare(at(left)) || right.itemId.localeCompare(left.itemId))[0];


/**
 * One student's 보관함 inside the student details. 사용 가능 shows what the student can still use
 * (the same product stacked as ×N); the teacher marks a 소모품 used, takes an item back or puts digital
 * products in. 사용 완료 keeps used items so a mistaken use can be taken back.
 */
export function StudentStorageSection({ studentId, name, notify, giveOptions }: Readonly<{
  studentId: string; name: string; notify: (message: string) => void; giveOptions: readonly GiveOption[];
}>) {
  const [items, setItems] = useState<BagItemDto[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [tab, setTab] = useState<'usable' | 'used'>('usable');
  const [confirmRevoke, setConfirmRevoke] = useState('');
  const [giveProductId, setGiveProductId] = useState('');
  const [giveCount, setGiveCount] = useState(1);
  const giveAttempt = useRef<{ key: string; operationId: string } | null>(null);

  const load = useCallback(async () => {
    setError('');
    const result = await fetchStudentBag(studentId);
    if (result.ok) setItems([...result.data.items]);
    else setError(result.error);
  }, [studentId]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function markUsed(stack: BagItemStack, used: boolean) {
    // 사용함 uses the oldest unit; 사용 취소 takes back the latest use made here (not one at a checkout).
    const item = used
      ? [...stack.items].sort((left, right) => left.issuedAt.localeCompare(right.issuedAt) || left.itemId.localeCompare(right.itemId))[0]
      : newest(stack.items.filter((entry) => !entry.usedAtCheckout), (entry) => entry.usedAt ?? '');
    if (!item) return;
    setBusy(stack.key);
    setError('');
    const result = await setBagItemUsed(item.itemId, used);
    setBusy('');
    if (!result.ok) { setError(result.error); return; }
    setItems((current) => current?.map((entry) => (entry.itemId === item.itemId ? result.data : entry)) ?? current);
    notify(used ? `${name} 학생의 '${item.title}' 1개를 사용함으로 저장했어요.` : `${name} 학생의 '${item.title}' 사용 표시를 1개 되돌려 저장했어요.`);
  }

  async function revoke(stack: BagItemStack) {
    const item = newest(stack.items, (entry) => entry.issuedAt);
    setBusy(stack.key);
    setError('');
    const result = await revokeBagItem(item.itemId);
    setBusy('');
    setConfirmRevoke('');
    if (!result.ok) { setError(result.error); return; }
    setItems((current) => current?.filter((entry) => entry.itemId !== item.itemId) ?? current);
    notify(`${name} 학생의 보관함에서 '${item.title}' 1개를 회수했어요.`);
  }

  async function give() {
    const option = giveOptions.find((entry) => entry.productId === giveProductId);
    if (!option) { setError('넣을 상품을 골라 주세요.'); return; }
    // The same request retried after a network failure reuses its operation ID, so nothing is given twice.
    const key = `${giveProductId}:${giveCount}`;
    if (giveAttempt.current?.key !== key) giveAttempt.current = { key, operationId: crypto.randomUUID() };
    setBusy('give');
    setError('');
    const result = await giveBagItems({ studentId, productId: giveProductId, count: giveCount, operationId: giveAttempt.current.operationId });
    setBusy('');
    if (!result.ok) { setError(result.error); return; }
    giveAttempt.current = null;
    setGiveProductId('');
    setGiveCount(1);
    setItems([...result.data.items]);
    setTab('usable');
    notify(`${name} 학생의 보관함에 '${giveOptionItemName(option)}' ${giveCount}개를 넣었어요.`);
  }

  const usable = (items ?? []).filter((item) => item.usedAt === null);
  const used = (items ?? []).filter((item) => item.usedAt !== null);
  const stacks = stackBagItems(tab === 'usable' ? usable : used);

  return (
    <section aria-labelledby={`storage-${studentId}`} data-tour="storage" className="space-y-3 border-t border-[var(--crs-line)] pt-5">
      <div data-tour="storage-head" className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`storage-${studentId}`} className="flex items-center gap-1.5 text-[15px] font-black tracking-[-0.02em]"><Icon name="package" size={18} />보관함</h3>
        {items ? (
          <SegmentedControl ariaLabel="보관함 보기" size="sm" value={tab} onChange={(value) => { setTab(value); setConfirmRevoke(''); }}
            options={[{ value: 'usable', label: '사용 가능', count: usable.length }, { value: 'used', label: '사용 완료', count: used.length }]} />
        ) : null}
      </div>
      <p data-tour="storage-note" className="text-xs leading-relaxed text-[var(--theme-muted-text)]">
        {tab === 'usable'
          ? '학생이 소모품을 쓰면 \'사용함\'을 눌러 주세요. 교환권은 학생이 매점에서 결제할 때 직접 쓸 수도 있어요. 수집품은 모아 두는 아이템이에요.'
          : '쓴 아이템이에요. 잘못 사용 처리했다면 \'사용 취소\'로 되돌릴 수 있어요. 결제에 쓴 교환권은 그 결제를 취소하면 돌아와요.'}
      </p>
      {error ? <div role="alert"><Callout tone="danger">{error}</Callout></div> : null}
      {items === null && !error ? (
        <div role="status" className="flex items-center gap-2 text-sm font-semibold text-[var(--theme-muted-text)]"><Spinner size={16} />보관함을 여는 중이에요.</div>
      ) : null}
      {items && stacks.length === 0 ? (
        <p className="rounded-[var(--crs-radius)] bg-[var(--crs-subtle)] px-4 py-3 text-sm text-[var(--theme-muted-text)]">
          {tab === 'usable' ? '쓸 수 있는 아이템이 없어요. 학급 나무를 수확하거나 매점에서 디지털 상품을 사면 여기에 모여요.' : '사용한 아이템이 없어요.'}
        </p>
      ) : null}
      {stacks.length > 0 ? (
        <ul className="divide-y divide-[var(--crs-line)]">
          {stacks.map((stack) => {
            const item = stack.first;
            const count = stack.items.length;
            const latestUse = tab === 'used' ? newest(stack.items, (entry) => entry.usedAt ?? '') : null;
            return (
              <li key={stack.key} className="flex flex-wrap items-center gap-3 py-2.5">
                <ItemPicture imageUrl={bagStackImage(stack)} kind={item.kind} voucher={isVoucherItem(item)} size={44} dimmed={tab === 'used'} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-bold">{item.title}</span>
                    {count > 1 ? <span className="shrink-0 rounded-full bg-[var(--theme-accent-soft)] px-2 py-px text-xs font-black tabular-nums text-[var(--theme-accent-text)]">×{count}</span> : null}
                  </span>
                  <span className="block truncate text-xs text-[var(--theme-muted-text)]">
                    {isVoucherItem(item) ? `교환권 (${item.voucherProductName ?? '상품'})` : DIGITAL_KIND_LABELS[item.kind]} · {bagStackOrigin(stack)}
                    {latestUse?.usedAt ? ` · ${dateLabel(latestUse.usedAt)} ${latestUse.usedAtCheckout ? '결제에 사용' : '사용'}` : ` · ${dateLabel(item.issuedAt)}`}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {tab === 'usable' && confirmRevoke === stack.key ? (
                    <>
                      <span className="text-xs font-bold text-[var(--theme-muted-text)]">1개 회수할까요?</span>
                      <Button size="sm" variant="ghost" disabled={busy !== ''} onClick={() => setConfirmRevoke('')}>취소</Button>
                      <Button size="sm" variant="danger" loading={busy === stack.key} disabled={busy !== ''} onClick={() => void revoke(stack)}>회수</Button>
                    </>
                  ) : tab === 'usable' ? (
                    <>
                      <Button size="sm" variant="ghost" data-tour="storage-revoke" disabled={busy !== ''} onClick={() => setConfirmRevoke(stack.key)}>회수</Button>
                      {item.kind === 'CONSUMABLE'
                        ? <Button size="sm" data-tour="storage-use" loading={busy === stack.key} disabled={busy !== ''} onClick={() => void markUsed(stack, true)}>사용함</Button>
                        : null}
                    </>
                  ) : item.kind === 'CONSUMABLE' && stack.items.some((entry) => !entry.usedAtCheckout) ? (
                    <Button size="sm" variant="ghost" loading={busy === stack.key} disabled={busy !== ''} onClick={() => void markUsed(stack, false)}>사용 취소</Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {items && tab === 'usable' ? (
        <div data-tour="storage-give" className="rounded-[var(--crs-radius)] border border-dashed border-[var(--crs-line)] p-3">
          {giveOptions.length === 0 ? (
            <p className="text-xs leading-relaxed text-[var(--theme-muted-text)]">매점에 상품을 등록하면 여기서 학생 보관함에 바로 넣을 수 있어요.</p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs font-bold">보관함에 넣기 <span className="font-medium text-[var(--theme-muted-text)]">· 실물 상품은 교환권으로 들어가요.</span></p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <GiveProductFields idPrefix={`give-${studentId}`} options={giveOptions} productId={giveProductId} count={giveCount}
                    onProductChange={setGiveProductId} onCountChange={setGiveCount} disabled={busy !== ''} />
                </div>
                <Button icon="plus" loading={busy === 'give'} disabled={busy !== '' || !giveProductId} onClick={() => void give()}>넣기</Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
