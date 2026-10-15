// The 딴쌤 mark (A-1) and logotype (P-1), drawn from the brand files as they are: never imitated
// with a font, never stretched (the logotype is 111:54).

/** The mark: a blue rounded square with a white ㄷ and a light blue ㄷ. */
export function DdanssaemMark({ size }: Readonly<{ size: number }>) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
      <rect width="64" height="64" rx="18" fill="#2B6DE8" />
      <path d="M28.5 20H16.5V44H28.5" fill="none" stroke="#FFFFFF" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M47.5 20H35.5V44H47.5" fill="none" stroke="#B9D1FF" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The logotype '딴쌤' in one color (#2B2D31, or white on a dark ground). */
export function DdanssaemLogotype({ height, color = '#2B2D31' }: Readonly<{ height: number; color?: string }>) {
  return (
    <svg width={Math.round(height * 111 / 54 * 10) / 10} height={height} viewBox="0 0 111 54" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
      <g fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15.5 3.5H3.5V27.5H15.5" />
        <path d="M34.5 3.5H22.5V27.5H34.5" />
        <path d="M45.5 3.5V36.5M45.5 17H50.5" />
        <path d="M3.5 40.5V50.5H45.5" />
        <path d="M66.5 3.5V14C66.5 19.5 64.79 24 60.5 27.5M66.5 14C66.5 16.22 67.1 18.24 68.94 20.31" />
        <path d="M79.5 3.5V14C79.5 19.5 77.79 24 73.5 27.5M79.5 14C79.5 19.5 81.21 24 85.5 27.5" />
        <path d="M96 3.5V27.5M96 14H107.5M107.5 3.5V27.5" />
        <path d="M63.5 37.5H107.5V50.5H63.5Z" />
      </g>
    </svg>
  );
}

/** Mark and logotype side by side at the brand's spacing: text height mark × 54/64, gap mark × 17/64. */
export function DdanssaemLockup({ markSize }: Readonly<{ markSize: number }>) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(markSize * 17 / 64) }}>
      <DdanssaemMark size={markSize} />
      <DdanssaemLogotype height={Math.round(markSize * 54 / 64 * 10) / 10} />
    </span>
  );
}
