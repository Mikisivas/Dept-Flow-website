import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { LogOutButton } from "@/components/log-out-button";
import { requireStudent } from "@/lib/data/require-student";
import { displayNameRegister, programmeFromMatric } from "@/lib/format";

export const metadata: Metadata = {
  title: "Your profile",
};

/**
 * Read-only where the register is authoritative. A student cannot edit their
 * own matric number, name or level — those come from the department's record,
 * and letting them drift would break the one thing the register is for.
 *
 * No location history, no coordinates, no map. There is nothing here to show:
 * position is read at submission and purged on a schedule.
 */
export default async function ProfilePage() {
  const { student } = await requireStudent();

  return (
    <AppShell role="student">
      <PageHeader title="Your profile" />

      <section className="mt-6 rounded-lg border border-line bg-surface">
        <dl className="divide-y divide-line">
          <Row label="Name" value={displayNameRegister(student)} />
          <Row label="Matric number" value={student.matricNo} monospace />
          <Row label="Programme" value={programmeFromMatric(student.matricNo) ?? "—"} />
          <Row label="Level" value={`${student.level} level`} />
        </dl>
        <p className="border-t border-line px-4 py-3 text-[13px] leading-relaxed text-muted">
          These come from the department&apos;s register. If something is wrong, the department
          office can correct it.
        </p>
      </section>

      <section className="mt-6 rounded-lg border border-line bg-surface">
        <dl className="divide-y divide-line">
          <Row
            label="Phone number"
            value={student.phone}
            monospace
            action={
              <Button variant="ghost" className="h-9 px-2 text-[14px]">
                Change
              </Button>
            }
          />
        </dl>
        <p className="border-t border-line px-4 py-3 text-[13px] leading-relaxed text-muted">
          Changing your number sends a code to the new one before it takes effect.
        </p>
      </section>

      <section className="mt-6 flex flex-col gap-2">
        <Button variant="secondary" className="justify-start">
          Change password
        </Button>
        <Button asChild variant="secondary" className="justify-start">
          <Link href="/notifications">Notification preferences</Link>
        </Button>
        <Button asChild variant="secondary" className="justify-start">
          <Link href="/privacy">Privacy notice</Link>
        </Button>
      </section>

      <div className="mt-8">
        <LogOutButton variant="destructive" className="w-full" />
      </div>
    </AppShell>
  );
}

function Row({
  label,
  value,
  monospace,
  action,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <dt className="text-[13px] text-muted">{label}</dt>
        <dd
          className={monospace ? "mt-0.5 text-[15px] text-ink tabular" : "mt-0.5 text-[15px] text-ink"}
          translate={monospace ? "no" : undefined}
        >
          {value}
        </dd>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
