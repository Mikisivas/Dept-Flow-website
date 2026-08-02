"use client";

import { SiteMark } from "@/components/site-mark";
import { Button } from "@/components/ui/button";

/**
 * Typographic, site mark, one action. No illustrations.
 *
 * It says explicitly that records are untouched, because the thing a student
 * fears when this screen appears is that their attendance went with it.
 */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-surface px-4 text-center">
      <SiteMark size={40} />
      <h1 className="mt-6 text-[26px] font-semibold tracking-[-0.02em] text-ink">
        Something broke on our side
      </h1>
      <p className="mt-2 max-w-[42ch] text-[15px] leading-relaxed text-slate">
        This one is us, not you. Your attendance and payment records are unaffected — try again in a
        moment.
      </p>
      <Button className="mt-6" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
