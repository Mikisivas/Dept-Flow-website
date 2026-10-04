import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * The logo of Rev. Fr. Moses Orshio Adasu University, Makurdi.
 *
 * One mark, used whole, at every size. It is the university's, not this
 * system's, so it is never cropped, recoloured, redrawn or stretched, and
 * never placed on a brand-blue fill, where the blue T disappears into it.
 *
 * The file has a transparent background, so it sits on white and on a tinted
 * panel as it is. In dark mode it sits on a small white tile instead: its
 * outer ring is black, and on a black page the ring — the shape that makes it
 * this university's mark — vanishes. Below about 48px the ring text cannot be read;
 * that is accepted in the header and the tab, where the red ring and blue T
 * are what identify it, and every page that shows it small also names the
 * university in text.
 */
export function UniversityLogo({
  size = 200,
  className,
  priority = false,
  decorative = false,
}: {
  size?: number;
  className?: string;
  priority?: boolean;
  /** Beside text that already names the university, the logo adds nothing for a screen reader. */
  decorative?: boolean;
}) {
  return (
    <Image
      src="/university-logo.png"
      alt={decorative ? "" : "Rev. Fr. Moses Orshio Adasu University, Makurdi"}
      width={size}
      height={size}
      priority={priority}
      style={{ "--logo-pad": `${Math.max(2, Math.round(size * 0.05))}px` } as React.CSSProperties}
      className={cn(
        "shrink-0 dark:rounded-[calc(var(--logo-pad)*2)] dark:bg-white dark:p-[var(--logo-pad)]",
        className,
      )}
    />
  );
}
