import Link from "next/link";
import type { Metadata } from "next";
import { CreditCard, KeySquare, ListChecks } from "lucide-react";
import { Crest } from "@/components/crest";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Dept-Flow — attendance and dues",
  description:
    "Record your lecture attendance, clear your departmental dues, and see whether you're on track for the 75% exam-eligibility threshold.",
};

const CARDS = [
  {
    icon: KeySquare,
    title: "Record attendance",
    body: "Your lecturer opens two checkpoints during each lecture. Enter the code on the board at each one.",
  },
  {
    icon: CreditCard,
    title: "Clear your dues",
    body: "Pay by card or bank transfer. Clearing counts every session you've already attended, all at once.",
  },
  {
    icon: ListChecks,
    title: "Track eligibility",
    body: "See your attendance against the 75% line for every course, and what it would take to get back above it.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-dvh bg-surface">
      <main className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
        <div className="flex flex-col items-center text-center">
          <Crest size={208} />
          <p className="mt-5 text-[13px] font-semibold tracking-[0.09em] text-muted uppercase">
            Department of Mathematics and Computer Science
          </p>
          <h1 className="mt-3 text-[32px] leading-[1.15] font-semibold tracking-[-0.025em] text-ink">
            Dept-Flow
          </h1>
          <p className="mt-4 max-w-[46ch] text-[17px] leading-relaxed text-slate">
            Attendance that counts once your departmental dues are cleared — and a clear view of
            whether you&apos;ll be eligible to sit your exams.
          </p>
        </div>

        <div className="mt-8 flex flex-col gap-3 sm:mx-auto sm:max-w-sm">
          <Button asChild size="lg">
            <Link href="/login">Log in</Link>
          </Button>
          <Button asChild size="lg" variant="secondary">
            <Link href="/register">Create account</Link>
          </Button>
          <Link
            href="/check"
            className="mt-1 text-center text-[15px] text-brand-text underline underline-offset-2 hover:text-brand-pressed"
          >
            Check if my matric number is registered
          </Link>
        </div>

        <ul className="mt-12 grid gap-3 sm:grid-cols-3">
          {CARDS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="rounded-lg border border-line bg-surface-sunken p-5">
              <Icon className="h-5 w-5 text-brand-text" aria-hidden="true" />
              <h2 className="mt-3 text-[15px] font-semibold text-ink">{title}</h2>
              <p className="mt-1.5 text-[14px] leading-relaxed text-slate">{body}</p>
            </li>
          ))}
        </ul>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-8 text-[13px] text-muted">
          <p>
            Department of Mathematics and Computer Science · Departmental office, Faculty of Science
          </p>
          <p>
            Your location is checked once, at the moment you submit attendance. It is never tracked
            continuously.{" "}
            <Link
              href="/privacy"
              className="text-brand-text underline underline-offset-2 hover:text-brand-pressed"
            >
              Privacy notice
            </Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
