import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { loadSystemConfig } from "@/lib/data/admin";
import { formatDate, naira } from "@/lib/format";

export const metadata: Metadata = { title: "Configuration" };

export const dynamic = "force-dynamic";

/**
 * Every value here changes how the system treats every student, so each one is
 * shown with what it actually does rather than as a bare field. The geo-fence
 * is admin-only: the HOD cannot read venue coordinates at all, enforced in RLS
 * as well as by this page's absence from their nav.
 */
export default async function ConfigPage() {
  const config = await loadSystemConfig();

  return (
    <AppShell role="admin">
      <PageHeader
        title="System configuration"
        subtitle="Every change is confirmed and written to the audit log."
      />

      {config.resumptionDate === null ? (
        <p
          role="alert"
          className="mt-6 rounded-lg border border-danger bg-danger-tint p-4 text-[14px] leading-relaxed text-ink"
        >
          No dues period is set for the active session. Until one is, there is no day 0 to count
          from — nobody enters the buffer, nobody locks, and the payment portal never closes.
        </p>
      ) : null}

      <section aria-labelledby="dues-heading" className="mt-6">
        <h2 id="dues-heading" className="text-[13px] font-semibold text-slate">
          Dues and the compliance window
        </h2>
        <dl className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          <Row
            label="Dues amount"
            value={config.duesAmountKobo === null ? "Not set" : naira(config.duesAmountKobo)}
            detail="What every student is asked to pay this session."
          />
          <Row
            label="Resumption date"
            value={config.resumptionDate === null ? "Not set" : formatDate(config.resumptionDate)}
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

      <section aria-labelledby="rules-heading" className="mt-8">
        <h2 id="rules-heading" className="text-[13px] font-semibold text-slate">
          Eligibility and registration
        </h2>
        <dl className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          <Row
            label="Exam eligibility threshold"
            value={`${config.attendanceThresholdPct}%`}
            detail="Counted attendance below this bars a student from the paper."
          />
          <Row
            label="Credit unit cap"
            value={`${config.maxCreditUnits} units`}
            detail="Per semester, counting core, electives and carry-overs alike."
          />
          <Row
            label="Checkpoint code lifetime"
            value={`${config.tokenTtlSeconds} seconds`}
            detail="How long an issued code stays valid. Short enough that it cannot usefully be sent to someone outside."
          />
          <Row
            label="Timetable tolerance"
            value={`${config.timetableToleranceMinutes} minutes`}
            detail="How far from the scheduled slot a lecture may be opened before it counts as a reschedule."
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
