import type { Metadata } from "next";
import Link from "next/link";
import { SiteMark } from "@/components/site-mark";

export const metadata: Metadata = {
  title: "Privacy notice",
};

/**
 * Plain language, because the people it describes are the people reading it.
 *
 * The honest thing this page has to convey is the shape of the location
 * handling: a single reading at the moment of submission, no tracking between
 * lectures, and deletion on a schedule. Anything vaguer would be a worse
 * promise than the system actually makes.
 */
export default function PrivacyPage() {
  return (
    <div className="min-h-dvh bg-surface">
      <main className="mx-auto max-w-2xl px-4 py-10 sm:py-14">
        <Link href="/" className="flex w-fit items-center gap-2 rounded-md">
          <SiteMark size={24} />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Dept-Flow</span>
        </Link>

        <h1 className="mt-8 text-[28px] leading-tight font-semibold tracking-[-0.02em] text-ink">
          What we collect, and what we don&apos;t
        </h1>
        <p className="mt-3 text-[16px] leading-relaxed text-slate">
          Dept-Flow is run by the Department of Mathematics and Computer Science to record lecture
          attendance and departmental dues. This notice explains what it holds about you, why, and
          for how long. It follows the Nigeria Data Protection Act 2023.
        </p>

        <Section title="Who you are">
          <p>
            Your matric number, surname, first name and other names, level, and phone number. Your
            matric number, surname and level come from the department&apos;s register; the rest you
            give us when you create your account.
          </p>
          <p>
            Your programme is not stored separately — it is read from your matric number, which is
            why we never ask you to pick it.
          </p>
        </Section>

        <Section title="Your attendance">
          <p>
            For each lecture we record which checkpoints you submitted a code for, and the score
            that produces: 1.0 for both, 0.5 for one, 0 for neither. We also record submissions that
            were rejected, and why, so you can dispute one if it was wrong.
          </p>
        </Section>

        <Section title="Your location — the important part">
          <p>
            When you submit a checkpoint code, your browser asks for your location{" "}
            <strong className="font-semibold text-ink">once, at that moment</strong>. We use it to
            check whether you are inside the lecture hall, and nothing else.
          </p>
          <ul className="ml-5 list-disc space-y-1.5">
            <li>You are not tracked between lectures, or at any other time.</li>
            <li>There is no background location access — closing the page ends it entirely.</li>
            <li>
              Your coordinates are deleted after a short period, set by the department and never
              longer than 30 days. After that only the pass-or-fail result and the distance remain.
            </li>
            <li>
              No screen in Dept-Flow shows anyone your coordinates — not lecturers, not the HOD, not
              administrators.
            </li>
          </ul>
        </Section>

        <Section title="What we never collect">
          <p>
            No fingerprints, no face or selfie capture, no biometrics of any kind. No photographs.
            No access to your contacts, messages, files or camera. Dept-Flow is a website, so it has
            no ability to reach any of that even if it wanted to.
          </p>
        </Section>

        <Section title="Your payments">
          <p>
            Payments are handled by Paystack. We store the amount, the channel you used, a reference
            number and whether it succeeded.{" "}
            <strong className="font-semibold text-ink">
              We never see or store your card details
            </strong>{" "}
            — those go directly to Paystack.
          </p>
        </Section>

        <Section title="Who can see what">
          <p>
            Your lecturers see your attendance for their own courses. The Head of Department sees
            your attendance, your dues status and any decisions made about your record.
            Administrators manage accounts, payments and the timetable, and see aggregate figures
            rather than individual risk assessments.
          </p>
          <p>
            Every decision a member of staff makes about your record — clearing your dues without
            payment, correcting a disputed session, deactivating an account — is written to a log
            that names who did it and why.
          </p>
        </Section>

        <Section title="How long it is kept">
          <p>
            Attendance and payment records are kept for as long as the department needs them for
            academic records. Location coordinates are deleted on the schedule above. If your
            account is deactivated, your history is retained but you can no longer log in.
          </p>
        </Section>

        <Section title="Asking us about your data">
          <p>
            You can ask the department office what is held about you, and ask for a correction if
            something is wrong. Attendance corrections go through the Head of Department, who can
            change a record when a dispute is upheld.
          </p>
        </Section>

        <p className="mt-10 border-t border-line pt-6 text-[14px] text-muted">
          Department of Mathematics and Computer Science · Departmental office, Faculty of Science
        </p>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-[19px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
      <div className="mt-2 flex flex-col gap-3 text-[16px] leading-relaxed text-slate">
        {children}
      </div>
    </section>
  );
}
