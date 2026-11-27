import Link from "next/link";
import { UniversityLogo } from "@/components/university-logo";
import { Button } from "@/components/ui/button";

/** Typographic, logo, link home. No illustrations anywhere. */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-surface px-4 text-center">
      <UniversityLogo size={48} />
      <h1 className="mt-6 text-[26px] font-semibold tracking-[-0.02em] text-ink">
        This page isn&apos;t here
      </h1>
      <p className="mt-2 max-w-[42ch] text-[15px] leading-relaxed text-slate">
        The link may be out of date, or the page may have moved. Your attendance and payment records
        are unaffected.
      </p>
      <Button asChild className="mt-6">
        <Link href="/">Go to the home page</Link>
      </Button>
    </div>
  );
}
