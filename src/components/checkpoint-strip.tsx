import type { SessionCell } from "@/lib/types";
import { formatDateShort } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The signature component.
 *
 * A lecture is scored out of two checkpoints, so a lecture draws as two cells.
 * Filled means captured, hollow means missed, dashed means recorded but not
 * yet counted. This is the one place the design spends its boldness — keep
 * everything around it quiet.
 *
 *   ▮▮  1.0        ▮▯  0.5        ▯▯  0        ⌐⌐  provisional
 *
 * A lecture where the lecturer only issued one token renders as ONE WIDE CELL,
 * so it is visibly not a pair. Never fake a second cell.
 */

type Size = "sm" | "md";

const CELL_SIZE: Record<Size, string> = {
  sm: "h-4 w-2.5",
  md: "h-6 w-4",
};

const WIDE_CELL_SIZE: Record<Size, string> = {
  sm: "h-4 w-[1.375rem]",
  md: "h-6 w-[2.125rem]",
};

function describe(session: SessionCell): string {
  const when = `${session.label}, ${formatDateShort(session.heldOn)}`;

  const capture =
    session.mode === "single"
      ? session.checkpointOne
        ? "single checkpoint captured"
        : "single checkpoint missed"
      : session.checkpointOne && session.checkpointTwo
        ? "both checkpoints captured"
        : session.checkpointOne
          ? "first checkpoint captured, second missed"
          : session.checkpointTwo
            ? "second checkpoint captured, first missed"
            : "neither checkpoint captured";

  const counted = session.status === "provisional" ? ", recorded but not yet counted" : "";
  const paper = session.source === "manually_entered" ? ", recorded from paper register" : "";

  return `${when}: ${capture}${counted}${paper}`;
}

function Cell({
  captured,
  provisional,
  wide,
  size,
}: {
  captured: boolean;
  provisional: boolean;
  wide?: boolean;
  size: Size;
}) {
  return (
    <span
      className={cn(
        wide ? WIDE_CELL_SIZE[size] : CELL_SIZE[size],
        "rounded-[2px] border transition-colors duration-300",
        provisional
          ? // Hollow with a dashed edge. Once the student clears, these fill
            // solid — the most important visual moment in the product.
            "border-dashed border-cell-provisional bg-transparent"
          : captured
            ? "border-transparent bg-brand"
            : "border-solid border-cell-missed bg-transparent",
      )}
    />
  );
}

export function CheckpointStrip({
  sessions,
  size = "md",
  className,
}: {
  sessions: SessionCell[];
  size?: Size;
  className?: string;
}) {
  return (
    <ol className={cn("flex flex-wrap items-center gap-x-2 gap-y-1.5", className)}>
      {sessions.map((session) => {
        const provisional = session.status === "provisional";

        return (
          <li
            key={session.id}
            className="relative flex items-center gap-0.5"
            // The motif is never the only carrier of meaning.
            aria-label={describe(session)}
          >
            {session.mode === "single" ? (
              <Cell captured={session.checkpointOne} provisional={provisional} wide size={size} />
            ) : (
              <>
                <Cell captured={session.checkpointOne} provisional={provisional} size={size} />
                <Cell captured={session.checkpointTwo} provisional={provisional} size={size} />
              </>
            )}

            {/* Paper batches carry a corner mark, so a roster of them is
                visible at a glance rather than buried in a source column. */}
            {session.source === "manually_entered" ? (
              <span
                aria-hidden="true"
                className="absolute -top-1 -right-1 h-1.5 w-1.5 rounded-full bg-slate"
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** The key that makes the motif legible the first time someone meets it. */
export function CheckpointLegend({ className }: { className?: string }) {
  const items = [
    { label: "Full", detail: "1.0", one: true, two: true, provisional: false },
    { label: "Half", detail: "0.5", one: true, two: false, provisional: false },
    { label: "Absent", detail: "0", one: false, two: false, provisional: false },
    { label: "Not yet counted", detail: "", one: false, two: false, provisional: true },
  ];

  return (
    <ul className={cn("flex flex-wrap gap-x-5 gap-y-2", className)}>
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2">
          <span className="flex gap-0.5" aria-hidden="true">
            <Cell captured={item.one} provisional={item.provisional} size="sm" />
            <Cell captured={item.two} provisional={item.provisional} size="sm" />
          </span>
          <span className="text-[13px] text-slate">
            {item.label}
            {item.detail ? <span className="text-muted"> · {item.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
