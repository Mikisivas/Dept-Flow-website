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
 * It used to restore attendance access to students locked out by DUES. It now
 * restores it to students shut out by the REGISTRATION deadline — the same
 * mechanism, repointed, and narrowed at the bottom end to a single student,
 * because "hospitalised through the registration window" is the case the
 * department actually meets and reopening a whole level for it would be absurd.
 *
 * The HOD is entitled to do this, so the screen does not argue — but it must
 * not be possible to do it without seeing exactly who it touches. The impact
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
  impact: { shutOut: number; lecturesMissed: number };
  levelCounts: Record<string, number>;
}) {
  const [scope, setScope] = useState<"department" | "level" | "student">("student");
  const [level, setLevel] = useState("400");
  const [matricNo, setMatricNo] = useState("");
  const [matricError, setMatricError] = useState<string | null>(null);
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

  const affected =
    scope === "department"
      ? impact.shutOut
      : scope === "level"
        ? (levelCounts[level] ?? 0)
        : // One, by definition — and the server will refuse the matric number
          // if it names nobody, so the screen does not pretend to know better.
          1;

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
        <h2 className="text-[15px] font-semibold text-ink">No exception is open</h2>
        <p className="mt-1 text-[14px] leading-relaxed text-slate">
          <strong className="font-semibold text-ink tabular">{impact.shutOut}</strong>{" "}
          {impact.shutOut === 1 ? "student is" : "students are"} shut out of recording attendance
          because a registration deadline passed without them confirming.{" "}
          <strong className="font-semibold text-ink tabular">{impact.lecturesMissed}</strong>{" "}
          {impact.lecturesMissed === 1 ? "lecture has" : "lectures have"} been recorded against them
          as absences in the meantime.
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
                ["student", "One student"],
                ["level", "A single level"],
                ["department", "The whole department"],
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

        {scope === "student" ? (
          <Field
            label="Matric number"
            htmlFor="matric"
            hint="The student this exception is for. Nobody else is affected."
            error={matricError ?? undefined}
          >
            <Input
              id="matric"
              value={matricNo}
              onChange={(event) => setMatricNo(event.target.value.toUpperCase())}
              placeholder="CMP/2021/047"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
        ) : null}

        {scope === "level" ? (
          <Field label="Level" htmlFor="level">
            <select
              value={level}
              onChange={(event) => setLevel(event.target.value)}
              className="h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
            >
              {["100", "200", "300", "400"].map((value) => (
                <option key={value} value={value}>
                  {value} level · {levelCounts[value] ?? 0} shut out
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
            This will let{" "}
            <strong className="font-semibold text-ink tabular">
              {scope === "student"
                ? matricNo || "one student"
                : `${affected} shut-out student${affected === 1 ? "" : "s"}`}
            </strong>{" "}
            record attendance again
            {expiresOn ? (
              <>
                {" "}
                until <strong className="font-semibold text-ink">{formatDate(expiresOn)}</strong>
              </>
            ) : null}
            . It does not register them — the exception suspends the consequence rather than
            forging the record, so they should still confirm.
          </p>
        </div>

        <Button
          size="lg"
          onClick={() => {
            if (scope === "student" && !/^(MTH|CMP|STA)\/\d{4}\/\d{3,4}$/.test(matricNo.trim())) {
              setMatricError("Enter a matric number like CMP/2021/047.");
              return;
            }
            setMatricError(null);

            if (!expiresOn) {
              setDateError("Choose the date the exception ends.");
              return;
            }
            setDateError(null);
            setError(null);
            setConfirming(true);
          }}
        >
          Open registration exception
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
        title={
          scope === "student"
            ? `Open a registration exception for ${matricNo}?`
            : `Open a registration exception for ${affected} shut-out students?`
        }
        description={
          <>
            They can record attendance again until{" "}
            <strong className="font-semibold text-ink">
              {expiresOn ? formatDate(expiresOn) : "—"}
            </strong>
            . This does not register them — they should still confirm, and the absences already
            recorded against them stay recorded.
          </>
        }
        impact={[
          {
            label: "Covers",
            value:
              scope === "student"
                ? matricNo
                : scope === "level"
                  ? `Level ${level}`
                  : "Whole department",
          },
          { label: "Students affected", value: String(affected) },
          { label: "Ends", value: expiresOn ? formatDate(expiresOn) : "—" },
        ]}
        reasonHint="Required. Senior staff can see who granted this and why."
        confirmLabel="Open exception"
        working={working}
        onConfirm={async (reason) => {
          await send({
            action: "open",
            scope,
            level: Number(level),
            matricNo: matricNo.trim(),
            expiresOn,
            reason,
          });
          setConfirming(false);
        }}
      />
    </>
  );
}
