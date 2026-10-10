// Inline-SVG profile icon. No 'use client' and no hooks: server components
// render it directly. Pure shapes only (no emoji/fonts) so every OS draws it
// identically. Layer order: background → back of face (ears) → head →
// face details → cheeks → eyes → mouth → front of face → accessory → rim.

import type { ReactNode } from 'react';
import { AVATAR_PARTS, type AvatarConfig, type AvatarPartKey } from './avatar';

const INK = '#2E2A35';
const MOUTH_FILL = '#6B2737';
const TONGUE = '#F47C8E';
const BLUSH = '#FF8FA3';
const OUTLINE = 1.5;
const FEATURE = 2.2;

// Geometry shared by every face so parts line up.
const HEAD = { cx: 32, cy: 37, rx: 19.5, ry: 18.5 } as const;
const EYE_Y = 36.5;
const EYE_L = 25;
const EYE_R = 39;

const BACKGROUNDS: Record<string, string> = {
  sky: '#BFE2F6',
  pink: '#F8CCDA',
  mint: '#BCE9D6',
  yellow: '#FBE7A1',
  lavender: '#D8CEF4',
  peach: '#FBD3BD',
  lime: '#D4EBAE',
  gray: '#D7DCE3',
  navy: '#5E70AC',
  orange: '#FFC48E',
};

type FaceArt = { back?: ReactNode; base: ReactNode; detail?: ReactNode; front?: ReactNode };

function head(fill: string, stroke: string) {
  return <ellipse cx={HEAD.cx} cy={HEAD.cy} rx={HEAD.rx} ry={HEAD.ry} fill={fill} stroke={stroke} strokeWidth={OUTLINE} />;
}

function human(skin: string, shade: string, hair: string): FaceArt {
  return {
    back: (
      <>
        <ellipse cx={12.9} cy={38.5} rx={3.3} ry={4.3} fill={skin} stroke={shade} strokeWidth={OUTLINE} />
        <ellipse cx={51.1} cy={38.5} rx={3.3} ry={4.3} fill={skin} stroke={shade} strokeWidth={OUTLINE} />
      </>
    ),
    base: head(skin, shade),
    detail: (
      <>
        <path fill={hair} d="M12.4 37.6C10.8 24.6 19.4 16.4 32 16.4S53.2 24.6 51.6 37.6C50 32 47.8 28.8 44.8 26.9 39.6 29.9 30.4 30.4 22.6 27.5 19.2 30 14.4 32.6 12.4 37.6Z" />
        <path d="M21.5 21.6Q25.6 18.9 30 18.6" fill="none" stroke="#fff" strokeOpacity={0.22} strokeWidth={1.6} strokeLinecap="round" />
      </>
    ),
  };
}

function muzzleNose(muzzle: string, nose: string) {
  return (
    <>
      <ellipse cx={32} cy={45.4} rx={8.6} ry={6.6} fill={muzzle} />
      <ellipse cx={32} cy={41.2} rx={2.7} ry={1.9} fill={nose} />
      <ellipse cx={31.1} cy={40.6} rx={0.85} ry={0.45} fill="#fff" fillOpacity={0.6} />
    </>
  );
}

const FACES: Record<string, FaceArt> = {
  'skin-light': human('#FCE1CD', '#E3B596', '#5B3A29'),
  'skin-medium': human('#E9B48A', '#C68A60', '#3A2620'),
  'skin-dark': human('#9C6646', '#784A30', '#231A17'),
  bear: {
    back: (
      <>
        <circle cx={16.2} cy={22.2} r={6.8} fill="#C48A5C" stroke="#9A6740" strokeWidth={OUTLINE} />
        <circle cx={47.8} cy={22.2} r={6.8} fill="#C48A5C" stroke="#9A6740" strokeWidth={OUTLINE} />
        <circle cx={16.9} cy={22.9} r={3.5} fill="#EBC6A0" />
        <circle cx={47.1} cy={22.9} r={3.5} fill="#EBC6A0" />
      </>
    ),
    base: head('#C48A5C', '#9A6740'),
    detail: muzzleNose('#EED0AC', '#3B2B25'),
  },
  cat: {
    back: (
      <g strokeLinejoin="round">
        <path d="M14 29.5 15.2 12.6 28.6 20.4Z" fill="#F3B46A" stroke="#C98538" strokeWidth={OUTLINE} />
        <path d="M50 29.5 48.8 12.6 35.4 20.4Z" fill="#F3B46A" stroke="#C98538" strokeWidth={OUTLINE} />
        <path d="M17.4 24.4 17.9 16.7 24.3 20.6Z" fill="#F7A6A8" stroke="#F7A6A8" strokeWidth={1.2} />
        <path d="M46.6 24.4 46.1 16.7 39.7 20.6Z" fill="#F7A6A8" stroke="#F7A6A8" strokeWidth={1.2} />
      </g>
    ),
    base: head('#F3B46A', '#C98538'),
    detail: (
      <>
        <g fill="none" stroke="#D88E3C" strokeWidth={1.9} strokeLinecap="round">
          <path d="M32 19.6v4.4" />
          <path d="M27.1 20.3l.8 3.4" />
          <path d="M36.9 20.3l-.8 3.4" />
        </g>
        <path d="M30.1 40.3h3.8L32 42.4Z" fill="#F08A97" stroke="#F08A97" strokeWidth={1.1} strokeLinejoin="round" />
      </>
    ),
    front: (
      <g fill="none" stroke="#9A6430" strokeOpacity={0.75} strokeWidth={1.2} strokeLinecap="round">
        <path d="M10.2 40.4 17.2 41.8" />
        <path d="M10.6 45.2 17.4 44.2" />
        <path d="M53.8 40.4 46.8 41.8" />
        <path d="M53.4 45.2 46.6 44.2" />
      </g>
    ),
  },
  rabbit: {
    back: (
      <>
        <ellipse cx={24.6} cy={14.4} rx={5.3} ry={12} transform="rotate(-10 24.6 14.4)" fill="#F8F4F1" stroke="#D3C7C0" strokeWidth={OUTLINE} />
        <ellipse cx={39.4} cy={14.4} rx={5.3} ry={12} transform="rotate(10 39.4 14.4)" fill="#F8F4F1" stroke="#D3C7C0" strokeWidth={OUTLINE} />
        <ellipse cx={24.8} cy={15.4} rx={2.5} ry={8.6} transform="rotate(-10 24.8 15.4)" fill="#F7B5C3" />
        <ellipse cx={39.2} cy={15.4} rx={2.5} ry={8.6} transform="rotate(10 39.2 15.4)" fill="#F7B5C3" />
      </>
    ),
    base: head('#F8F4F1', '#D3C7C0'),
    detail: <ellipse cx={32} cy={41.4} rx={2} ry={1.4} fill="#F28FA3" />,
  },
  dog: {
    base: head('#F0D4AF', '#C9A070'),
    detail: (
      <>
        <ellipse cx={39.6} cy={35.2} rx={5.4} ry={4.8} fill="#DDB487" />
        {muzzleNose('#FBEEDC', '#3B2B25')}
      </>
    ),
    front: (
      <>
        <ellipse cx={13.8} cy={30.5} rx={5.4} ry={10.6} transform="rotate(18 13.8 30.5)" fill="#A87350" stroke="#8A5A3A" strokeWidth={OUTLINE} />
        <ellipse cx={50.2} cy={30.5} rx={5.4} ry={10.6} transform="rotate(-18 50.2 30.5)" fill="#A87350" stroke="#8A5A3A" strokeWidth={OUTLINE} />
      </>
    ),
  },
  penguin: {
    base: head('#3E4A5E', '#2B3443'),
    detail: (
      <>
        <path d="M30.6 18.9Q30.8 14.6 34.4 14.9 32.4 16.4 33.2 18.8" fill="#3E4A5E" stroke="#2B3443" strokeWidth={1.2} strokeLinejoin="round" />
        <path fill="#FBFBFD" d="M32 28.6C28.6 24.6 16.4 25.2 15.6 36.6 15 46.6 22.6 53.4 32 53.4S49 46.6 48.4 36.6C47.6 25.2 35.4 24.6 32 28.6Z" />
        <path d="M28.6 40Q32 37.9 35.4 40 33.6 43 32 43T28.6 40Z" fill="#F7A93B" stroke="#DB8A22" strokeWidth={1} strokeLinejoin="round" />
      </>
    ),
  },
};

function openEye(x: number) {
  return (
    <>
      <ellipse cx={x} cy={EYE_Y} rx={2.5} ry={2.9} fill={INK} />
      <circle cx={x + 0.8} cy={EYE_Y - 1} r={0.9} fill="#fff" />
    </>
  );
}

function arcEye(x: number) {
  return <path d={`M${x - 3} ${EYE_Y + 1}Q${x} ${EYE_Y - 3.4} ${x + 3} ${EYE_Y + 1}`} fill="none" stroke={INK} strokeWidth={FEATURE} strokeLinecap="round" />;
}

function sparkleEye(x: number) {
  return (
    <>
      <ellipse cx={x} cy={EYE_Y} rx={3.1} ry={3.6} fill={INK} />
      <circle cx={x + 1.1} cy={EYE_Y - 1.3} r={1.25} fill="#fff" />
      <circle cx={x - 1.1} cy={EYE_Y + 1.4} r={0.6} fill="#fff" />
    </>
  );
}

function sleepyEye(x: number) {
  return <path d={`M${x - 3} ${EYE_Y - 0.4}Q${x} ${EYE_Y + 2.8} ${x + 3} ${EYE_Y - 0.4}`} fill="none" stroke={INK} strokeWidth={FEATURE} strokeLinecap="round" />;
}

const EYES: Record<string, ReactNode> = {
  basic: <>{openEye(EYE_L)}{openEye(EYE_R)}</>,
  happy: <>{arcEye(EYE_L)}{arcEye(EYE_R)}</>,
  sparkle: <>{sparkleEye(EYE_L)}{sparkleEye(EYE_R)}</>,
  sleepy: <>{sleepyEye(EYE_L)}{sleepyEye(EYE_R)}</>,
  wink: <>{openEye(EYE_L)}{arcEye(EYE_R)}</>,
};

const smileStroke = { fill: 'none', stroke: INK, strokeWidth: FEATURE, strokeLinecap: 'round' } as const;

const MOUTHS: Record<string, ReactNode> = {
  smile: <path d="M27.6 44.6Q32 48.8 36.4 44.6" {...smileStroke} />,
  grin: (
    <>
      <path d="M26.8 44H37.2C37.2 48.6 34.9 51 32 51S26.8 48.6 26.8 44Z" fill={MOUTH_FILL} stroke={INK} strokeWidth={1.4} strokeLinejoin="round" />
      <path d="M29.2 49.3C30.6 47.6 33.4 47.6 34.8 49.3 34 50.4 33 50.9 32 50.9S30 50.4 29.2 49.3Z" fill={TONGUE} />
    </>
  ),
  surprised: <ellipse cx={32} cy={46.6} rx={2.5} ry={3} fill={MOUTH_FILL} stroke={INK} strokeWidth={1.4} />,
  neutral: <path d="M28.6 46.4H35.4" {...smileStroke} />,
  tongue: (
    <>
      <g transform="rotate(-10 33.6 47)">
        <path d="M31.4 46.2h4.4v2.4a2.2 2.2 0 0 1-4.4 0Z" fill={TONGUE} stroke="#D95A6F" strokeWidth={1} strokeLinejoin="round" />
        <path d="M33.6 46.8v1.7" stroke="#D95A6F" strokeWidth={0.9} strokeLinecap="round" />
      </g>
      <path d="M27.6 44.6Q32 48.4 36.4 44.6" {...smileStroke} />
    </>
  ),
};

const ACCESSORIES: Record<string, ReactNode> = {
  none: null,
  glasses: (
    <g fill="none" stroke="#2F3645" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <circle cx={EYE_L} cy={EYE_Y} r={5.8} fill="#fff" fillOpacity={0.18} />
      <circle cx={EYE_R} cy={EYE_Y} r={5.8} fill="#fff" fillOpacity={0.18} />
      <path d="M30.8 35.8Q32 34.6 33.2 35.8" />
      <path d="M19.2 35.6 13.4 34.4" />
      <path d="M44.8 35.6 50.6 34.4" />
    </g>
  ),
  crown: (
    <>
      <path d="M20.6 22.4 19.2 10.8 25.9 15.8 32 7.6 38.1 15.8 44.8 10.8 43.4 22.4Z" fill="#FFCB3D" stroke="#DFA213" strokeWidth={OUTLINE} strokeLinejoin="round" />
      <path d="M20.9 19.3H43.1" stroke="#DFA213" strokeWidth={1.2} />
      <circle cx={19.2} cy={10.4} r={1.7} fill="#FFCB3D" stroke="#DFA213" strokeWidth={1.1} />
      <circle cx={32} cy={7.2} r={1.9} fill="#FFCB3D" stroke="#DFA213" strokeWidth={1.1} />
      <circle cx={44.8} cy={10.4} r={1.7} fill="#FFCB3D" stroke="#DFA213" strokeWidth={1.1} />
      <circle cx={32} cy={15.6} r={2} fill="#FF6F91" />
      <circle cx={25.4} cy={18} r={1.2} fill="#6CC7F5" />
      <circle cx={38.6} cy={18} r={1.2} fill="#6CC7F5" />
    </>
  ),
  ribbon: (
    <g transform="rotate(-14 44.6 19.8)" stroke="#DE4F76" strokeWidth={1.3} strokeLinejoin="round">
      <path d="M44.6 19.8C41.2 15.2 35.8 15.4 36.2 19.8S41.2 24.4 44.6 19.8Z" fill="#FF6F91" />
      <path d="M44.6 19.8C48 15.2 53.4 15.4 53 19.8S48 24.4 44.6 19.8Z" fill="#FF6F91" />
      <circle cx={44.6} cy={19.8} r={2.4} fill="#FF8FA8" />
    </g>
  ),
  hat: (
    <>
      <path d="M13.8 26C13.8 15.2 21.8 9.8 32 9.8S50.2 15.2 50.2 26Z" fill="#F06A6A" stroke="#CF4E4C" strokeWidth={OUTLINE} strokeLinejoin="round" />
      <path d="M26 12.2Q24.4 18 25 25M38 12.2Q39.6 18 39 25" fill="none" stroke="#CF4E4C" strokeOpacity={0.55} strokeWidth={1.2} strokeLinecap="round" />
      <rect x={12.2} y={22.4} width={39.6} height={6.6} rx={3.3} fill="#FFF3E6" stroke="#E6D3BE" strokeWidth={OUTLINE} />
      <circle cx={32} cy={8.6} r={3.9} fill="#FFF3E6" stroke="#E6D3BE" strokeWidth={OUTLINE} />
    </>
  ),
  headphones: (
    <>
      <path d="M11.8 36C11 10.6 53 10.6 52.2 36" fill="none" stroke="#2F3645" strokeWidth={4.2} strokeLinecap="round" />
      <path d="M11.8 36C11 10.6 53 10.6 52.2 36" fill="none" stroke="#F2727F" strokeWidth={2.4} strokeLinecap="round" />
      <rect x={7.4} y={30.4} width={8.4} height={13.2} rx={3.6} fill="#F2727F" stroke="#2F3645" strokeWidth={OUTLINE} />
      <rect x={48.2} y={30.4} width={8.4} height={13.2} rx={3.6} fill="#F2727F" stroke="#2F3645" strokeWidth={OUTLINE} />
      <rect x={13.2} y={32.4} width={3.2} height={9.2} rx={1.6} fill="#2F3645" />
      <rect x={47.6} y={32.4} width={3.2} height={9.2} rx={1.6} fill="#2F3645" />
    </>
  ),
  flower: (
    <g>
      <ellipse cx={24.8} cy={24.4} rx={1.9} ry={3.6} transform="rotate(50 24.8 24.4)" fill="#7CC47F" />
      <g fill="#FF9DBA" stroke="#EE7A9D" strokeWidth={1}>
        {[0, 72, 144, 216, 288].map((angle) => (
          <ellipse key={angle} cx={19.6} cy={17} rx={2.9} ry={3.5} transform={`rotate(${angle} 19.6 20.6)`} />
        ))}
      </g>
      <circle cx={19.6} cy={20.6} r={2.5} fill="#FFD55E" stroke="#EDB52F" strokeWidth={1} />
    </g>
  ),
};

function pick<T>(map: Record<string, T>, part: AvatarPartKey, id: string): T {
  return Object.hasOwn(map, id) ? map[id] : map[AVATAR_PARTS[part][0].id];
}

export function UserAvatar({ config, size = 40, title, className }: { config: AvatarConfig; size?: number; title?: string; className?: string }) {
  const face = pick(FACES, 'face', config.face);
  const decorative = title === '';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      style={{ borderRadius: '50%', overflow: 'hidden', flexShrink: 0, verticalAlign: 'middle' }}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': title ?? '프로필 아이콘' })}
      focusable="false"
      data-avatar={`${config.background} ${config.face} ${config.eyes} ${config.mouth} ${config.accessory}`}
    >
      <circle cx={32} cy={32} r={32} fill={pick(BACKGROUNDS, 'background', config.background)} />
      {face.back}
      {face.base}
      {face.detail}
      <ellipse cx={20.6} cy={43} rx={3.1} ry={1.9} fill={BLUSH} fillOpacity={0.45} />
      <ellipse cx={43.4} cy={43} rx={3.1} ry={1.9} fill={BLUSH} fillOpacity={0.45} />
      {pick(EYES, 'eyes', config.eyes)}
      {pick(MOUTHS, 'mouth', config.mouth)}
      {face.front}
      {pick(ACCESSORIES, 'accessory', config.accessory)}
      <circle cx={32} cy={32} r={31.5} fill="none" stroke="#0F172A" strokeOpacity={0.08} strokeWidth={1} />
    </svg>
  );
}
