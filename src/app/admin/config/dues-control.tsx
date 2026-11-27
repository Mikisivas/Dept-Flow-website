"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Coins } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatDate, naira } from "@/lib/format";

/**
 * The session's dues, and the resumption date they are counted from.
 *
 * One row per session rather than per semester: departmental dues are charged
 * for the year, and the balance is looked up by session alone. The registration
 * window above is the per-semester control, and the two sitting on one screen is
 * exactly why this says which it is.
 *
 * The amount is typed in naira and sent in kobo. Asking an administrator to
 * enter 500000 for a five-thousand-naira fee is how a fee becomes five hundred
 * thousand naira by a factor nobody notices until a student cannot pay it.
 *
 * The impact line is the point of the screen. Every reader of this figure
 * computes from it live, so raising it puts every fully-paid student back in
 * debt the instant it saves and stops their exam permits, with no other
 * symptom. That count is fetched from the server as the amount is typed.
 */
export function DuesControl({
  amountKobo,
  resumptionDate,
}: {
  amountKobo: number | null;
  resumptionDate: string | null;
}) {
  const router = useRouter();
  const [nairaAmount, setNairaAmount] = useState(
    amountKobo === null ? "" : String(Math.round(amountKobo) / 100),
  );
  const [resumesOn, setResumesOn] = useState(resumptionDate ?? "");
  const [impact, setImpact] = useState<{ key: string; newlyOwing: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const kobo = Math.round(Number(nairaAmount) * 100);
  const valid = nairaAmount.trim().length > 0 && Number.isFinite(kobo) && kobo > 0;
  const impactKey = String(kobo);

  /**
   * Asked of the server, never computed here. Who has paid how much is not
   * something the browser knows, and the number that gates a permit should not
   * be an estimate on the screen that changes it.
   */
  useEffect(() => {
    if (!valid) return;

    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/admin/dues-period", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "impact", amountKobo: kobo }),
        });
        const payload = await response.json();
        if (cancelled || !response.ok) return;
        setImpact({ key: impactKey, newlyOwing: Number(payload.newlyOwing ?? 0) });
      } catch {
        // Left as it was. The key below discards a stale answer, and blanking
        // it here would replace a number with nothing.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [kobo, valid, impactKey]);

  const newlyOwing = impact?.key === impactKey ? impact.newlyOwing : null;

  async function save(reason: string) {
    setWorking(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/dues-period", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountKobo: kobo, resumptionDate: resumesOn, reason }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "That didn't save.");
        setWorking(false);
        return;
      }

      setResult(`Dues for this session are ${naira(kobo)}.`);
      setConfirming(false);
      router.refresh();
    } catch {
      setError("No connection. Nothing was saved.");
    }

    setWorking(false);
  }

  const ready = valid && resumesOn.length > 0;

  return (
    <section aria-labelledby="dues-control-heading" className="mt-4">
      <h3 id="dues-control-heading" className="text-[13px] font-semibold text-slate">
        Set this session&rsquo;s dues
      </h3>

      <div className="mt-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-col gap-4">
          <p className="text-[14px] leading-relaxed text-slate">
            Charged once for the session, not per semester. Changing the figure takes effect
            everywhere at once, because every balance is worked out from it rather than stored.
          </p>

          <div className="flex flex-col gap-4 sm:flex-row">
            <Field label="Dues amount (naira)" htmlFor="dues-amount">
              <Input
                id="dues-amount"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={nairaAmount}
                onChange={(event) => setNairaAmount(event.target.value)}
              />
            </Field>
            <Field label="Resumption date" htmlFor="resumes-on">
              <Input
                id="resumes-on"
                type="date"
                value={resumesOn}
                onChange={(event) => setResumesOn(event.target.value)}
              />
            </Field>
          </div>

          {/* Before the button, not after it. A raise that puts forty students
              back in debt should shape the decision, not explain it. */}
          {newlyOwing !== null && newlyOwing > 0 ? (
            <p
              role="status"
              className="rounded-lg border border-danger bg-danger-tint p-3 text-[14px] leading-relaxed text-ink"
            >
              <strong className="font-semibold tabular">{newlyOwing}</strong>{" "}
              {newlyOwing === 1 ? "student owes" : "students owe"} nothing today and would owe at
              this figure. Each of them loses an exam permit they can print this morning.
            </p>
          ) : null}

          {result ? (
            <p role="status" className="text-[14px] leading-relaxed text-ink">
              {result}
            </p>
          ) : null}

          <div>
            <Button type="button" disabled={!ready} onClick={() => setConfirming(true)}>
              <Coins className="h-4 w-4" aria-hidden="true" />
              {amountKobo === null ? "Set the dues" : "Change the dues"}
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={amountKobo === null ? "Set this session's dues?" : "Change this session's dues?"}
        description={
          <>
            Every student&rsquo;s outstanding balance is worked out from this figure when it is
            read, so the change applies immediately and everywhere. It does not alter attendance:
            dues and attendance meet only at the exam permit, which needs both.
          </>
        }
        impact={[
          { label: "Dues amount", value: valid ? naira(kobo) : "—" },
          {
            label: "Was",
            value: amountKobo === null ? "Not set" : naira(amountKobo),
          },
          { label: "Resumption date", value: resumesOn ? formatDate(resumesOn) : "—" },
          ...(newlyOwing !== null && newlyOwing > 0
            ? [{ label: "Put back in debt", value: `${newlyOwing}` }]
            : []),
        ]}
        error={error}
        confirmLabel={amountKobo === null ? "Set dues" : "Change dues"}
        working={working}
        onConfirm={save}
      />
    </section>
  );
}
