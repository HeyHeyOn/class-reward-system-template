'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon, type IconName } from '../ui';
import { buttonClass } from '../ui/classes';
import { isShown } from './tutorialDom';

/*
 * A button named in a help text ([학생 추가]) is shown as that very button, only smaller: the real
 * button on the screen is copied with its look (colors, border, icon) frozen into inline styles.
 * A button that is not on the screen yet (it appears once a dialog opens) is drawn from what it is
 * known to look like; anything else falls back to a plain key cap.
 */

/** Height the copy is scaled toward, and the smallest scale (so its words stay readable). */
const CHIP_HEIGHT = 30;
const MIN_SCALE = 0.62;

const STYLE_PROPS = [
  'color', 'background-color', 'background-image', 'opacity',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-left', 'margin-right',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'white-space', 'text-decoration-line',
  'display', 'flex-direction', 'align-items', 'justify-content', 'gap', 'column-gap', 'row-gap', 'flex-shrink',
  'height', 'min-height', 'box-shadow', 'vertical-align',
  'width', 'fill', 'stroke', 'stroke-width',
] as const;

const transparent = (color: string) => color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color);

/** Freezes the computed look of `source` (and of every element inside it) onto `copy`. */
function freeze(source: Element, copy: Element, root: boolean) {
  const style = getComputedStyle(source);
  const target = copy as HTMLElement | SVGElement;
  for (const prop of STYLE_PROPS) {
    // The copy sizes itself: the root's width would stretch a full-width button across the text.
    if (prop === 'width' && (root || !(source instanceof SVGElement))) continue;
    target.style.setProperty(prop, style.getPropertyValue(prop));
  }
  if (source instanceof SVGElement) target.style.setProperty('width', style.getPropertyValue('width'));
  target.removeAttribute('id');
  target.removeAttribute('class');
  for (let index = 0; index < source.children.length; index += 1) {
    const child = copy.children[index];
    if (child) freeze(source.children[index], child, false);
  }
}

function backgroundBehind(element: Element): string {
  for (let node: Element | null = element.parentElement; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (!transparent(color)) return color;
  }
  return 'transparent';
}

/** A copy of the real button, frozen and scaled, that cannot be used. */
function copyOf(real: HTMLElement): HTMLElement {
  const copy = real.cloneNode(true) as HTMLElement;
  freeze(real, copy, true);
  for (const node of [copy, ...copy.querySelectorAll('*')]) {
    for (const name of [...node.getAttributeNames()]) {
      if (name !== 'style' && name !== 'viewBox' && name !== 'd' && name !== 'width' && name !== 'height' && name !== 'fill'
        && name !== 'stroke' && name !== 'stroke-width' && name !== 'stroke-linecap' && name !== 'stroke-linejoin'
        && name !== 'xmlns' && name !== 'points' && name !== 'cx' && name !== 'cy' && name !== 'r' && name !== 'x' && name !== 'y'
        && name !== 'rx' && name !== 'x1' && name !== 'x2' && name !== 'y1' && name !== 'y2' && name !== 'transform') node.removeAttribute(name);
    }
  }
  const style = getComputedStyle(real);
  const height = real.getBoundingClientRect().height || parseFloat(style.height) || CHIP_HEIGHT;
  const scale = Math.min(1, Math.max(MIN_SCALE, CHIP_HEIGHT / height));
  // A button that is plain on its own background (a ghost button, a bar button) keeps that
  // background, and a faint edge so it still reads as a button in a sentence.
  const plain = transparent(style.backgroundColor) && parseFloat(style.borderTopWidth) === 0;
  if (plain) {
    copy.style.backgroundColor = backgroundBehind(real);
    copy.style.boxShadow = '0 0 0 1px var(--crs-line-strong)';
  }
  // A button that fills its cell (no side padding of its own) gets some, once it no longer does.
  if (parseFloat(style.paddingLeft) < 8 && parseFloat(style.paddingRight) < 8) {
    copy.style.paddingLeft = '14px';
    copy.style.paddingRight = '14px';
  }
  copy.style.display = style.display === 'none' ? 'inline-flex' : style.display.includes('flex') ? 'inline-flex' : 'inline-block';
  copy.style.opacity = '1';
  copy.style.width = 'auto';
  copy.style.maxWidth = 'none';
  copy.style.margin = '0';
  copy.style.verticalAlign = 'middle';
  copy.style.pointerEvents = 'none';
  copy.style.setProperty('zoom', String(scale));
  return copy;
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/** `N명 저장` matches 3명 저장; a count or amount after the word (전체 8, 더하기 +5) is allowed. */
function matcher(label: string): (text: string) => boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\bN(?=[명개])/g, '\\d+');
  const pattern = new RegExp(`^${escaped}(?: ?[+−-]?[\\d,]+)?$`);
  return (text) => pattern.test(text);
}

const CANDIDATES = 'button, a[href], [role="tab"], [role="radio"]';

/** The real button for a label: shown before hidden, enabled before disabled, then the nearest to the step. */
export function findButton(label: string, near: Element | null): HTMLElement | null {
  const matches = matcher(label);
  // A cheap first look at the raw text before measuring what is shown.
  const stem = label.replace(/\bN(?=[명개])/g, '').split(' ').sort((a, b) => b.length - a.length)[0];
  let best: { element: HTMLElement; rank: number } | null = null;
  const anchor = near?.getBoundingClientRect();
  for (const element of document.querySelectorAll<HTMLElement>(CANDIDATES)) {
    if (element.closest('[data-testid="tutorial"]')) continue;
    if (!(element.textContent ?? '').includes(stem) && element.getAttribute('aria-label') !== label) continue;
    const text = normalize(element.innerText || element.textContent || '');
    if (!matches(text) && !(text === '' && element.getAttribute('aria-label') === label)) continue;
    const shown = isShown(element);
    const enabled = !(element as HTMLButtonElement).disabled;
    let rank = (shown ? 0 : 2_000_000) + (enabled ? 0 : 1_000_000);
    if (anchor && shown) {
      const box = element.getBoundingClientRect();
      rank += Math.hypot(box.x + box.width / 2 - (anchor.x + anchor.width / 2), box.y + box.height / 2 - (anchor.y + anchor.height / 2));
    }
    if (!best || rank < best.rank) best = { element, rank };
  }
  return best?.element ?? null;
}

type Look = Readonly<{ variant?: 'primary' | 'secondary' | 'ghost' | 'soft' | 'danger' | 'dangerGhost'; size?: 'sm' | 'md' | 'lg';
  icon?: IconName; iconRight?: IconName; bar?: boolean; style?: CSSProperties }>;

/** How buttons look that are often not on the screen when a step names them. */
const KNOWN: Readonly<Record<string, Look>> = {
  다음: { variant: 'primary', size: 'sm', iconRight: 'chevronRight' },
  이전: { variant: 'ghost', size: 'sm', icon: 'chevronLeft' },
  인쇄: { variant: 'primary', icon: 'printer' },
  'QR 카드 인쇄하기': { variant: 'primary' },
  '설정 저장': { variant: 'primary', icon: 'check' },
  '이 설정으로 시작하기': { variant: 'primary', icon: 'sprout' },
  저장: { variant: 'primary', icon: 'check' },
  'N명 저장': { variant: 'primary', icon: 'check' },
  '학생 N명 추가': { variant: 'primary', icon: 'check' },
  '다른 파일 선택': { variant: 'secondary' },
  비활성화: { variant: 'ghost', size: 'sm' },
  재활성화: { variant: 'ghost', size: 'sm' },
  '사용 취소': { variant: 'ghost', size: 'sm' },
  사용함: { variant: 'secondary', size: 'sm' },
  고치기: { variant: 'primary', size: 'sm' },
  '완료 가능으로': { variant: 'soft', size: 'sm' },
  수확하기: { variant: 'primary', icon: 'gift' },
  '연결 끊기': { variant: 'dangerGhost' },
  '키 저장': { variant: 'primary' },
  돌아가기: { variant: 'ghost' },
  '거래 취소 확정': { variant: 'danger' },
  '도움말 목록': { variant: 'secondary' },
  'QR 카드 발급': { bar: true, icon: 'qr' },
  '보관함에 넣기': { bar: true, icon: 'package' },
  '잔액 변경': { bar: true, icon: 'coins' },
  '반복 설정': { bar: true, icon: 'repeat' },
  '완료 단계': { bar: true, icon: 'users' },
  '지금 초기화': { bar: true, icon: 'restore' },
  // The class list's red-edged button (its own stylesheet).
  '완전히 삭제': { variant: 'secondary', icon: 'trash', style: { color: '#be123c', borderColor: '#f3c3cf', borderRadius: 12, boxShadow: 'none' } },
};

/** The look of a known button: the app's own button styles, or the dark selection bar's. */
function KnownButton({ label, look }: { label: string; look: Look }) {
  const size = look.size ?? 'md';
  const iconSize = size === 'sm' ? 15 : 17;
  const scale = Math.min(1, Math.max(MIN_SCALE, CHIP_HEIGHT / (size === 'sm' ? 32 : size === 'lg' ? 48 : 40)));
  const words = label.replace(/\bN(?=[명개])/g, 'N');
  if (look.bar) {
    return (
      <span data-chip="known" className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[9px] bg-[var(--theme-text)] px-3 align-middle text-[13px] font-bold text-[var(--theme-surface)]"
        style={{ zoom: Math.max(MIN_SCALE, CHIP_HEIGHT / 32) } as CSSProperties}>
        {look.icon ? <Icon name={look.icon} size={15} /> : null}{words}
      </span>
    );
  }
  return (
    <span data-chip="known" className={buttonClass({ variant: look.variant, size, className: 'align-middle' })}
      style={{ zoom: scale, ...(look.variant === 'ghost' || look.variant === 'dangerGhost' ? { boxShadow: '0 0 0 1px var(--crs-line-strong)' } : {}), ...look.style } as CSSProperties}>
      {look.icon ? <Icon name={look.icon} size={iconSize} /> : null}{words}{look.iconRight ? <Icon name={look.iconRight} size={iconSize} /> : null}
    </span>
  );
}

/** Last resort: a key cap with the button's name. */
function PlainChip({ label }: { label: string }) {
  return (
    <span data-chip="plain" className="inline-block whitespace-nowrap rounded-[7px] border border-[var(--crs-line-strong)] bg-[var(--theme-surface)] px-1.5 align-middle text-[0.93em] font-bold text-[var(--theme-text)] shadow-[0_1px_0_var(--crs-line-strong)]">
      {label}
    </span>
  );
}

/** The help box's own buttons: never searched for on the page. */
const OWN = new Set(['다음', '이전', '마치기']);

/** [버튼 이름] in a help text: the real button's look when it can be found, retried while the step shows. */
export function ButtonChip({ label, near }: { label: string; near?: Element | null }) {
  const host = useRef<HTMLSpanElement>(null);
  const [copied, setCopied] = useState(false);
  const known = KNOWN[label];
  useEffect(() => {
    if (OWN.has(label)) return;
    let alive = true;
    let timer = 0;
    const attempt = () => {
      if (!alive) return;
      const real = findButton(label, near ?? null);
      if (real && host.current) {
        host.current.replaceChildren(copyOf(real));
        setCopied(true);
        return;
      }
      // It may still appear (a dialog opening, a row being picked).
      timer = window.setTimeout(attempt, 1000);
    };
    attempt();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [label, near]);
  return (
    <span className="mx-0.5 inline-block align-middle" data-chip-label={label} data-chip-source={copied ? 'live' : known ? 'known' : 'plain'}>
      <span ref={host} aria-hidden="true" inert className={copied ? 'inline-block' : 'hidden'} />
      {copied ? <span className="sr-only">{label}</span> : known ? <KnownButton label={label} look={known} /> : <PlainChip label={label} />}
    </span>
  );
}
