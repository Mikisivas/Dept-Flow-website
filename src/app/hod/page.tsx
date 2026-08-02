import type { Metadata } from "next";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getHodOverview } from "@/lib/data/queries";
import { formatDate, formatPercent } from "@/lib/format";

export const metadata: Metadata = {
  title: "Department overview",
};

export default async function HodDashboardPage() {
  const { totalStudents, belowThreshold, trendingBelow, compliance, activeGrace, pending } =
    await getHodOverview();

  const counted = compliance.cleared + compliance.provisional + compliance.locked + compliance.pending;

  return (
    <AppShell role="hod" counts={{ "/hod/risk": belowThreshold, "/hod/waivers": pending.waivers, "/hod/disputes": pending.disputes }}>
      <PageHeader
        title="Department overview"
        subtitle={`${totalStudents} students across the active session`}
      />

      {activeGrace ? (
        <section className="mt-6 rounded-lg border-2 border-brand bg-brand-tint p-4">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <ShieldAlert className="h-4 w-4" aria-hidden="true" />
            Grace period active
          </p>
          <p className="mt-2 text-[15px] leading-relaxed text-slate">
            {activeGrace.scope} · restores attendance access for{" "}
            <strong className="font-semibold text-ink tabular">
              {activeGrace.studentsAffected}
            </strong>{" "}
            students until <strong className="font-semibold text-ink">{formatDate(activeGrace.expiresOn)}</strong>.
          </p>
        </section>
      ) : null}

      <section aria-labelledby="risk-heading" className="mt-8">
        <h2 id="risk-heading" className="text-[13px] font-semibold text-slate">
          Exam eligibility risk
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Stat
            label="Below 75% now"
            value={belowThreshold}
            detail={`${formatPercent(Math.round((belowThreshold / totalStudents) * 100))} of the department`}
            emphasis
          />
          <Stat
            label="Trending below"
            value={trendingBelow}
            detail="Predicted to finish under 75%. Advisory only."
          />
        </div>
        <Button asChild variant="secondary" className="mt-3">
          <Link href="/hod/risk">See at-risk students</Link>
        </Button>
      </section>

      <section aria-labelledby="compliance-heading" className="mt-8">
        <h2 id="compliance-heading" className="text-[13px] font-semibold text-slate">
          Dues compliance
        </h2>
        <ul className="mt-3 flex flex-col gap-2">
          {[
            { variant: "confirmed" as const, label: "Cleared", value: compliance.cleared },
            { variant: "provisional" as const, label: "Not yet cleared", value: compliance.provisional },
            { variant: "pending" as const, label: "Payment being checked", value: compliance.pending },
            { variant: "locked" as const, label: "Locked", value: compliance.locked },
          ].map((row) => (
            <li
              key={row.label}
              className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3"
            >
              <span className="flex min-w-0 items-center gap-3">
                <StatusBadge variant={row.variant} />
                <span className="truncate text-[14px] text-slate">{row.label}</span>
              </span>
              <span className="shrink-0 text-[17px] font-semibold text-ink tabular">
                {row.value}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[13px] text-muted tabular">
          {counted} of {totalStudents} students accounted for
        </p>
      </section>

      <section aria-labelledby="pending-heading" className="mt-8">
        <h2 id="pending-heading" className="text-[13px] font-semibold text-slate">
          Waiting on you
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <LinkStat href="/hod/disputes" label="Attendance disputes" value={pending.disputes} />
          <LinkStat href="/hod/waivers" label="Waiver requests" value={pending.waivers} />
        </div>
      </section>
    </AppShell>
  );
}

function Stat({
  label,
  value,
  detail,
  emphasis,
}: {
  label: string;
  value: number;
  detail: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-[13px] text-muted">{label}</p>
      <p
        className={
          emphasis
            ? "mt-1 text-[32px] leading-none font-semibold text-danger tabular"
            : "mt-1 text-[32px] leading-none font-semibold text-ink tabular"
        }
      >
        {value}
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-slate">{detail}</p>
    </div>
  );
}

function LinkStat({ href, label, value }: { href: string; label: string; value: number }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface p-4 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
    >
      <span className="text-[15px] text-ink">{label}</span>
      <span className="text-[22px] font-semibold text-ink tabular">{value}</span>
    </Link>
  );
}
