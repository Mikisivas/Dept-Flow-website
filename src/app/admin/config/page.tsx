import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { getSystemConfig } from "@/lib/data/queries";
import { formatDate, naira } from "@/lib/format";

export const metadata: Metadata = { title: "Configuration" };

/**
 * Every value here changes how the system treats every student, so each one is
 * shown with what it actually does rather than as a bare field. The geo-fence
 * is admin-only: the HOD cannot read venue coordinates at all, enforced in RLS
 * as well as by this page's absence from their nav.
 */
export default async function ConfigPage() {
  const config = await getSystemConfig();

  return (
    <AppShell role="admin">
      <PageHeader
        title="System configuration"
        subtitle="Every change is confirmed and written to the audit log."
      />

      <section aria-labelledby="dues-heading" className="mt-6">
        <h2 id="dues-heading" className="text-[13px] font-semibold text-slate">
          Dues and the compliance window
        </h2>
        <dl className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          <Row
            label="Dues amount"
            value={naira(config.duesAmountKobo)}
            detail="What every student is asked to pay this session."
          />
          <Row
            label="Resumption date"
            value={formatDate(config.resumptionDate)}
            detail="Day 0. The provisional window is counted from here."
          />
          <Row
            label="Provisional window"
            value={`${config.provisionalWindowDays} days`}
            detail="Attendance records but does not count. On day 31 unpaid students enter the buffer."
          />
          <Row
            label="Verification buffer"
            value={`${config.pendingBufferHours} hours`}
            detail="How long a late payment has to land before the account locks. Bounded 6–12 hours."
          />
          <Row
            label="Grace window"
            value={`${config.graceWindowDays} days`}
            detail="Default length the HOD is offered when opening a grace period."
          />
        </dl>
      </section>

      <section aria-labelledby="geo-heading" className="mt-8">
        <h2 id="geo-heading" className="text-[13px] font-semibold text-slate">
          Geo-fence
        </h2>
        <dl className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          <Row
            label="Default radius"
            value={`${config.defaultRadiusM} m`}
            detail="Bounded 30–50 m. Wider counts the corridor; narrower rejects a student in their seat."
          />
          {config.venues.map((venue) => (
            <Row
              key={venue.id}
              label={venue.name}
              value={`${venue.radiusM} m`}
              detail="Coordinates are held for the hall, never for a student."
            />
          ))}
        </dl>
      </section>

      <section aria-labelledby="retention-heading" className="mt-8">
        <h2 id="retention-heading" className="text-[13px] font-semibold text-slate">
          Retention
        </h2>
        <dl className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          <Row
            label="Location retention"
            value={`${config.gpsRetentionDays} days`}
            detail="After this, raw coordinates are deleted and only the pass/fail and distance remain. Bounded 7–30 days."
          />
        </dl>
      </section>
    </AppShell>
  );
}

function Row({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <dt className="text-[15px] font-medium text-ink">{label}</dt>
        <dd className="text-[15px] font-semibold text-ink tabular">{value}</dd>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-slate">{detail}</p>
    </div>
  );
}
