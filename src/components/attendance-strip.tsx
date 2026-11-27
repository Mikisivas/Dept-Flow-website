import type { SessionCell } from "@/lib/types";
import { formatDateShort } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The signature component.
 *
 * One lecture, one cell, in the order they were held. Filled means present,
 * hollow means absent, dashed means recorded but not yet counted. This is the
 * one place the design spends its boldness — keep everything around it quiet.
 *
 *   ▮▮▮▮▮▮▮▯▯▯     ten lectures, the last three missed
 *
 * It used to draw a lecture as a PAIR of cells, because a lecture was scored
 * out of two checkpoints and could be half attended. Trust-based attendance
 * has no half: the pair became one cell, and the strip became a great deal
 * easier to read across a term — which matters more now than it did, because
 * the shape of the term is the thing the warning system is reacting to. A
 * student looking at a run of hollow cells on the right-hand end is looking at
 * the reason they were flagged.
 */

type Size = "sm" | "md";

const CELL_SIZE: Record<Size, string> = {
  sm: "h-4 w-2.5",
  md: "h-6 w-4",
};

function describe(session: SessionCell): string {
  const when = `${session.label}, ${formatDateShort(session.heldOn)}`;
  const capture = session.attended ? "present" : "absent";
  const paper = session.source === "manually_entered" ? ", recorded from paper register" : "";

  return `${when}: ${capture}${paper}`;
}

function Cell({ attended, size }: { attended: boolean; size: Size }) {
  return (
    <span
      className={cn(
        CELL_SIZE[size],
        "rounded-[2px] border transition-colors duration-300",
        attended
          ? "border-transparent bg-brand"
          : "border-solid border-cell-missed bg-transparent",
      )}
    />
  );
}

export function AttendanceStrip({
  sessions,
  size = "md",
  className,
}: {
  sessions: SessionCell[];
  size?: Size;
  className?: string;
}) {
  return (
    <ol className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1.5", className)}>
      {sessions.map((session) => (
        <li
          key={session.id}
          className="relative flex items-center"
          // The motif is never the only carrier of meaning.
          aria-label={describe(session)}
        >
          <Cell attended={session.attended} size={size} />

          {/* Paper batches carry a corner mark, so a roster of them is
              visible at a glance rather than buried in a source column. */}
          {session.source === "manually_entered" ? (
            <span
              aria-hidden="true"
              className="absolute -top-1 -right-1 h-1.5 w-1.5 rounded-full bg-slate"
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** The key that makes the motif legible the first time someone meets it. */
export function AttendanceLegend({ className }: { className?: string }) {
  const items = [
    { label: "Present", attended: true },
    { label: "Absent", attended: false },
  ];

  return (
    <ul className={cn("flex flex-wrap gap-x-5 gap-y-2", className)}>
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2">
          <span aria-hidden="true" className="flex">
            <Cell attended={item.attended} size="sm" />
          </span>
          <span className="text-[13px] text-slate">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
