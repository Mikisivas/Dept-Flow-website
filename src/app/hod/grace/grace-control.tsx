"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { GracePeriodRecord } from "@/lib/data/hod";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The highest-consequence control on the site.
 *
 * A grace period restores attendance access to every locked student in scope.
 * The HOD is entitled to do it, so the screen does not argue — but it must not
 * be possible to do it without seeing exactly who it touches. The impact
 * numbers are computed before the confirmation, shown inside it, and stored
 * with the record, so the history shows what the HOD was told at the moment
 * they decided rather than what the numbers look like now.
 */

export function GraceControl({
  active,
  history,
  impact,
  levelCounts,
}: {
  active: GracePeriodRecord | null;
  history: GracePeriodRecord[];
  impact: { lockedStudents: number; sessionsWaiting: number };
  levelCounts: Record<string, number>;
}) {
  const [scope, setScope] = useState<"department" | "level">("department");
  const [level, setLevel] = useState("400");
  const [expiresOn, setExpiresOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Kept apart from `error`: one is about this field, the other about the request. */
  const [dateError, setDateError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [working, setWorking] = useState(false);
  const router = useRouter();

  /**
   * Both directions go through the same endpoint, and neither decides
   * anything: the database refuses an overlapping period, a date in the past,
   * or a reason too short to be one, and its sentence is what appears here.
   */
  async function send(payload: Record<string, unknown>) {
    setWorking(true);
    setError(null);

    try {
      const response = await fetch("/api/hod/grace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();

      if (!response.ok) {
        setError(body.error ?? "That didn't work.");
        setWorking(false);
        return false;
      }

      router.refresh();
      setWorking(false);
      return true;
    } catch {
      setError("No connection. Nothing was changed.");
      setWorking(false);
      return false;
    }
  }

  const affected = scope === "department" ? impact.lockedStudents : (levelCounts[level] ?? 0);
  const sessionsWaiting =
    scope === "department"
      ? impact.sessionsWaiting
      : Math.round((impact.sessionsWaiting * affected) / Math.max(impact.lockedStudents, 1));

  if (active) {
    return (
      <section className="rounded-lg border-2 border-brand bg-brand-tint p-4">
        <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
          <ShieldAlert className="h-4 w-4" aria-hidden="true" />
          Grace period active
        </p>
        <p className="mt-2 text-[15px] leading-relaxed text-slate">
          {active.scope}, until{" "}
          <strong className="font-semibold text-ink">{formatDate(active.expiresOn)}</strong>.{" "}
          <span className="tabular">{active.studentsAffected}</span> students were locked when it
          was opened.
        </p>
        <p className="mt-2 text-[14px] leading-relaxed text-slate">{active.reason}</p>
        <p className="mt-1 text-[12px] text-muted">
          Opened by {active.grantedBy} on {formatDate(active.grantedAt)}
        </p>

        {error ? (
          <p role="alert" className="mt-3 text-[14px] font-medium text-danger">
            {error}
          </p>
        ) : null}

        <Button
          variant="secondary"
          className="mt-4"
          onClick={() => setRevoking(true)}
          aria-disabled={working}
        >
          End it early
        </Button>

        {/* Ending early re-locks everyone it was covering, so it demands the
            same reason and writes the same kind of audit row as opening it. */}
        <ConfirmDialog
          open={revoking}
          onOpenChange={setRevoking}
          variant="destructive"
          title="End this grace period now?"
          description={
            <>
              Students it covers go back to being locked out of recording attendance immediately.
              Nothing already recorded is lost.
            </>
          }
          impact={[
            { label: "Scope", value: active.scope },
            { label: "Was due to end", value: formatDate(active.expiresOn) },
            { label: "Students affected", value: String(active.studentsAffected) },
          ]}
          reasonLabel="Why is it ending early?"
          reasonHint="Required. Senior staff can see who ended this and why."
          confirmLabel="End grace period"
          working={working}
          onConfirm={async (reason) => {
            await send({ action: "revoke", graceId: active.id, reason });
            setRevoking(false);
          }}
        />
      </section>
    );
  }

  return (
    <>
      <section className="rounded-lg border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold text-ink">No grace period is open</h2>
        <p className="mt-1 text-[14px] leading-relaxed text-slate">
          <strong className="font-semibold text-ink tabular">{impact.lockedStudents}</strong>{" "}
          students are currently locked out of recording attendance, with{" "}
          <strong className="font-semibold text-ink tabular">{impact.sessionsWaiting}</strong>{" "}
          sessions waiting to be counted.
        </p>
      </section>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-danger bg-danger-tint p-4 text-[15px] text-ink"
        >
          {error}
        </p>
      ) : null}

      <section className="mt-6 flex flex-col gap-5">
        <fieldset>
          <legend className="text-[13px] font-semibold text-slate">Who does this cover?</legend>
          <div className="mt-3 flex flex-col gap-2">
            {(
              [
                ["department", "The whole department"],
                ["level", "A single level"],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg border p-4",
                  scope === value ? "border-2 border-brand bg-brand-tint" : "border border-line bg-surface",
                )}
              >
                <input
                  type="radio"
                  name="scope"
                  checked={scope === value}
                  onChange={() => setScope(value)}
                  className="h-4.5 w-4.5 accent-[var(--brand)]"
                />
                <span className="text-[15px] text-ink">{label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {scope === "level" ? (
          <Field label="Level" htmlFor="level">
            <select
              value={level}
              onChange={(event) => setLevel(event.target.value)}
              className="h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
            >
              {["100", "200", "300", "400"].map((value) => (
                <option key={value} value={value}>
                  {value} level · {levelCounts[value] ?? 0} locked
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <Field
          label="Open until"
          htmlFor="expires"
          hint="Attendance access returns immediately and ends at the close of this day."
          error={dateError ?? undefined}
        >
          <Input
            type="date"
            value={expiresOn}
            onChange={(event) => setExpiresOn(event.target.value)}
          />
        </Field>

        {/* Shown before the confirmation opens, not only inside it. */}
        <div className="rounded-lg border border-dashed border-cell-provisional p-4">
          <p className="text-[15px] leading-relaxed text-slate">
            This will restore attendance access for{" "}
            <strong className="font-semibold text-ink tabular">{affected} locked students</strong>
            {expiresOn ? (
              <>
                {" "}
                until <strong className="font-semibold text-ink">{formatDate(expiresOn)}</strong>
              </>
            ) : null}
            . Their provisional sessions stay uncounted until each student clears.
          </p>
        </div>

        <Button
          size="lg"
          onClick={() => {
            if (!expiresOn) {
              setDateError("Choose the date the grace period ends.");
              return;
            }
            setDateError(null);
            setError(null);
            setConfirming(true);
          }}
        >
          Open grace period
        </Button>
      </section>

      {history.length > 0 ? (
        <section aria-labelledby="history-heading" className="mt-10">
          <h2 id="history-heading" className="text-[13px] font-semibold text-slate">
            Previous grace periods
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {history.map((record) => (
              <li key={record.id} className="rounded-lg border border-line bg-surface p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[15px] font-semibold text-ink">{record.scope}</p>
                  <p className="text-[13px] text-muted tabular">
                    until {formatDate(record.expiresOn)}
                  </p>
                </div>
                <p className="mt-1.5 text-[14px] leading-relaxed text-slate">{record.reason}</p>
                <p className="mt-2 text-[12px] text-muted">
                  Granted by {record.grantedBy} on {formatDate(record.grantedAt)} ·{" "}
                  <span className="tabular">{record.studentsAffected}</span> students
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Open a grace period for ${affected} locked students?`}
        description={
          <>
            This restores attendance access until{" "}
            <strong className="font-semibold text-ink">
              {expiresOn ? formatDate(expiresOn) : "—"}
            </strong>
            . Their provisional sessions stay uncounted until each student clears.
          </>
        }
        impact={[
          { label: "Students affected", value: String(affected) },
          { label: "Scope", value: scope === "department" ? "Whole department" : `Level ${level} only` },
          { label: "Sessions waiting", value: String(sessionsWaiting) },
        ]}
        reasonHint="Required. Senior staff can see who granted this and why."
        confirmLabel="Open grace period"
        working={working}
        onConfirm={async (reason) => {
          await send({ action: "open", scope, level: Number(level), expiresOn, reason });
          setConfirming(false);
        }}
      />
    </>
  );
}
