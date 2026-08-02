import type { Metadata } from "next";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { getAdminOverview } from "@/lib/data/queries";
import { formatDate, formatPercent } from "@/lib/format";

export const metadata: Metadata = {
  title: "System overview",
};

/**
 * Operations and infrastructure. Aggregate signals only.
 *
 * There is deliberately no individual student risk here — that is HOD scope,
 * and showing it would break separation of duties. The database enforces the
 * same boundary by refusing admin the risk_predictions table.
 */
export default async function AdminDashboardPage() {
  const { byLevel, reconciliation, gpsRejectionRate, registration, duesWindow } =
    await getAdminOverview();

  const spiking = gpsRejectionRate.current > gpsRejectionRate.baseline * 2;
  const totals = byLevel.reduce(
    (acc, row) => ({
      cleared: acc.cleared + row.cleared,
      provisional: acc.provisional + row.provisional,
      locked: acc.locked + row.locked,
    }),
    { cleared: 0, provisional: 0, locked: 0 },
  );
  const all = totals.cleared + totals.provisional + totals.locked;

  return (
    <AppShell role="admin" counts={{ "/admin/students": registration.openDisputes }}>
      <PageHeader
        title="System overview"
        subtitle={`Dues window closes ${formatDate(duesWindow.deadline)} · ${duesWindow.daysRemaining} days left`}
      />

      {/* A steady GPS rejection rate is just GPS. A spike is people trying
          things, and it is the one thing on this screen worth interrupting
          for. */}
      {spiking ? (
        <section role="alert" className="mt-6 rounded-lg border border-danger bg-danger-tint p-4">
          <div className="flex gap-3">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
            <div>
              <h2 className="text-[15px] font-semibold text-ink">
                Location rejections are {Math.round(gpsRejectionRate.current / gpsRejectionRate.baseline)}× the usual rate
              </h2>
              <p className="mt-1 text-[14px] leading-relaxed text-slate">
                <span className="tabular">{formatPercent(gpsRejectionRate.current)}</span> of
                submissions were rejected as outside the hall, against a baseline of{" "}
                <span className="tabular">{formatPercent(gpsRejectionRate.baseline)}</span>. Worth
                checking the geo-fence for the venues involved before assuming it is students.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="compliance-heading" className="mt-8">
        <h2 id="compliance-heading" className="text-[13px] font-semibold text-slate">
          Dues compliance by level
        </h2>

        <ul className="mt-3 flex flex-col gap-2">
          {byLevel.map((row) => {
            const total = row.cleared + row.provisional + row.locked;
            return (
              <li key={row.level} className="rounded-lg border border-line bg-surface p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[15px] font-semibold text-ink">Level {row.level}</p>
                  <p className="text-[13px] text-muted tabular">{total} students</p>
                </div>

                {/* Proportions carry a label as well as a width — never a bar
                    that has to be measured by eye. */}
                <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-surface-sunken">
                  <span className="bg-ok" style={{ width: `${(row.cleared / total) * 100}%` }} />
                  <span
                    className="border-y border-dashed border-cell-provisional"
                    style={{ width: `${(row.provisional / total) * 100}%` }}
                  />
                  <span className="bg-danger" style={{ width: `${(row.locked / total) * 100}%` }} />
                </div>

                <dl className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                  <Pair label="Cleared" value={row.cleared} />
                  <Pair label="Not yet cleared" value={row.provisional} />
                  <Pair label="Locked" value={row.locked} />
                </dl>
              </li>
            );
          })}
        </ul>

        <p className="mt-2 text-[13px] text-muted tabular">
          {formatPercent(Math.round((totals.cleared / all) * 100))} of the department is cleared
        </p>
      </section>

      <section aria-labelledby="ops-heading" className="mt-8">
        <h2 id="ops-heading" className="text-[13px] font-semibold text-slate">
          Needs attention
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Card
            href="/admin/payments"
            label="Payments to reconcile"
            value={reconciliation.failedWebhooks + reconciliation.unverified}
            detail={`${reconciliation.failedWebhooks} failed webhooks · ${reconciliation.unverified} unverified`}
          />
          <Card
            href="/admin/whitelist"
            label="Register"
            value={registration.unclaimed}
            detail={`unclaimed rows · ${registration.openDisputes} open disputes`}
          />
        </div>
      </section>
    </AppShell>
  );
}

function Pair({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold text-ink tabular">{value}</dd>
    </div>
  );
}

function Card({
  href,
  label,
  value,
  detail,
}: {
  href: string;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-line bg-surface p-4 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
    >
      <p className="text-[13px] text-muted">{label}</p>
      <p className="mt-1 text-[32px] leading-none font-semibold text-ink tabular">{value}</p>
      <p className="mt-1.5 text-[13px] text-slate tabular">{detail}</p>
    </Link>
  );
}
