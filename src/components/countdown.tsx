"use client";

import { useEffect, useState } from "react";
import { formatCountdown } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Token expiry, OTP resend cooldown, grace-period expiry.
 *
 * Rendered only after mount. A countdown computed on the server and again in
 * the browser will disagree by however long the request took, and this product
 * has a hard midnight boundary where that stops being cosmetic.
 */
export function Countdown({
  expiresAt,
  onExpire,
  prefix,
  expiredLabel = "Expired",
  className,
}: {
  expiresAt: string | Date;
  onExpire?: () => void;
  prefix?: string;
  expiredLabel?: string;
  className?: string;
}) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    const target = new Date(expiresAt).getTime();

    const tick = () => {
      const seconds = Math.max(0, Math.round((target - Date.now()) / 1000));
      setRemaining(seconds);
      return seconds;
    };

    if (tick() === 0) {
      onExpire?.();
      return;
    }

    const id = window.setInterval(() => {
      if (tick() === 0) {
        window.clearInterval(id);
        onExpire?.();
      }
    }, 1000);

    return () => window.clearInterval(id);
    // onExpire is intentionally not a dependency: callers pass inline handlers
    // and re-subscribing every render would reset the interval each second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);

  if (remaining === null) {
    // Reserves the same width, so nothing shifts when the number arrives.
    return <span className={cn("tabular", className)}>&nbsp;</span>;
  }

  const expired = remaining === 0;

  return (
    <span
      className={cn("tabular", expired && "text-danger", className)}
      // Announced at a human pace rather than once a second.
      aria-live="polite"
      aria-atomic="true"
    >
      {expired ? expiredLabel : `${prefix ? `${prefix} ` : ""}${formatCountdown(remaining)}`}
    </span>
  );
}
