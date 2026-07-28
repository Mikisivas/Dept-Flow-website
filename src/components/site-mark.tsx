/**
 * The simplified site mark — shield and monitor only, no ribbons, no banner
 * text. This is what appears at header and favicon size.
 *
 * The full SAMACOSS crest belongs on the login page, the landing page and
 * printed reports, and nowhere else: its ribbon outlines are hairlines and its
 * banner text turns to mud below about 200px.
 *
 * This is a geometric reduction drawn to survive 32px. It should be redrawn as
 * a proper SVG from the original crest before launch.
 */
export function SiteMark({
  size = 26,
  className,
  title,
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <path
        d="M12 2 4 4.6v7.1c0 4.9 3.3 8.6 8 10.3 4.7-1.7 8-5.4 8-10.3V4.6z"
        fill="var(--brand)"
        stroke="var(--on-brand)"
        strokeWidth="1.5"
      />
      <rect x="8" y="9" width="8" height="5.4" fill="var(--on-brand)" />
      <rect x="10.4" y="15" width="3.2" height="1.5" fill="var(--on-brand)" />
    </svg>
  );
}
