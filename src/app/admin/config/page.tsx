import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { loadSystemConfig } from "@/lib/data/admin";
import { formatDate, naira } from "@/lib/format";
import { RegistrationWindowControl } from "./registration-window-control";

export const metadata: Metadata = { title: "Configuration" };

export const dynamic = "force-dynamic";

/**
 * Every value here changes how the system treats every student, so each one is
 * shown with what it actually does rather than as a bare field.
 *
 * Most of them are read-only on purpose: a threshold or a token lifetime is a
 * decision about the whole department, and it is changed deliberately in the
 * database, not between two clicks on a settings page. The registration window
 * is the exception, and has to be, because it is the one value that genuinely
 * changes every semester and whose absence is silent — an unconfigured window
 * reads as open, so a department that never set one loses the gate without ever
 * seeing an error.
 *
 * The geo-fence and the location-retention window used to live at the bottom
 * of this page. Both are gone with location enforcement, and the section that
 * replaced them is the hall list — which is now just a list of halls, because
 * a venue no longer holds anything a student could be measured against.
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
            label="Attendance code lifetime"
            value={`${config.tokenTtlSeconds} seconds`}
            detail="How long an issued code stays valid. With no location check behind it, this window is the whole of what stops a code being useful to someone who left."
          />
          <Row
            label="Timetable tolerance"
            value={`${config.timetableToleranceMinutes} minutes`}
            detail="How far from the scheduled slot a lecture may be opened before it counts as a reschedule."
          />
        </dl>
      </section>

      <section aria-labelledby="registration-heading" className="mt-8">
        <h2 id="registration-heading" className="text-[13px] font-semibold text-slate">
          Registration windows
        </h2>
        <dl className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {config.registrationWindows.length === 0 ? (
            <Row
              label="Not set"
              value="—"
              detail="With no window configured, registration never closes and attendance is never gated on it. Nobody is locked out — which is the right way to fail, but it is not the intended state."
            />
          ) : (
            config.registrationWindows.map((window) => (
              <Row
                key={window.semester}
                label={`${window.semester === 1 ? "First" : "Second"} semester`}
                value={`${formatDate(window.opensOn)} – ${formatDate(window.closesOn)}`}
                detail="After the closing date, a student who has not confirmed cannot record attendance on any course, and confirming late records an absence for every lecture already held."
              />
            ))
          )}
        </dl>

        <RegistrationWindowControl windows={config.registrationWindows} />
      </section>

      <section aria-labelledby="venues-heading" className="mt-8">
        <h2 id="venues-heading" className="text-[13px] font-semibold text-slate">
          Halls
        </h2>
        <dl className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {config.venues.map((venue) => (
            <Row
              key={venue.id}
              label={venue.name}
              value="—"
              detail="Where a lecture is held. Nothing is measured against it."
            />
          ))}
        </dl>
        <p className="mt-3 text-[13px] leading-relaxed text-muted">
          Attendance records no location, so this system stores none — no coordinates for a hall, and
          none for a student. There is nothing here to retain and nothing to purge.
        </p>
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
