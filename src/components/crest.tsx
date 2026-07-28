import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * The full SAMACOSS crest — login page, landing page and printed reports only.
 * Everywhere else uses the simplified site mark.
 *
 * The supplied file is a raster on an opaque white background, so it shows a
 * white box on a tinted panel and breaks in dark mode. It is deliberately
 * placed only on white surfaces until a transparent original arrives; see
 * docs/decisions.md.
 *
 * Never recolour it, never stretch it, and never put it on an orange fill —
 * the shield disappears.
 */
export function Crest({ size = 200, className }: { size?: number; className?: string }) {
  return (
    <Image
      src="/samacoss-crest.png"
      alt="Student Association of Mathematics, Computer Science and Statistics"
      width={size}
      height={size}
      priority
      className={cn("rounded-md", className)}
    />
  );
}
