import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One icon, a headline, one sentence, and the next action.
 *
 * No illustrations anywhere in this product — empty states are typographic
 * plus a single icon. An error state is the same shell: it states the fix
 * rather than apologising.
 */
export function EmptyState({
  icon: Icon,
  headline,
  body,
  action,
  tone = "empty",
  className,
}: {
  icon: LucideIcon;
  headline: string;
  body: string;
  action?: React.ReactNode;
  tone?: "empty" | "error";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-line bg-surface px-6 py-12 text-center",
        className,
      )}
      role={tone === "error" ? "alert" : undefined}
    >
      <Icon
        className={cn("h-7 w-7", tone === "error" ? "text-danger" : "text-muted")}
        aria-hidden="true"
      />
      <h2 className="text-[17px] font-semibold text-ink">{headline}</h2>
      <p className="max-w-[42ch] text-[15px] leading-relaxed text-slate">{body}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
