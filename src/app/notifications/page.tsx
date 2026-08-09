import type { Metadata } from "next";
import { Bell, CalendarClock, CreditCard, ShieldCheck, TrendingDown } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { loadNotifications } from "@/lib/data/student";
import { MarkReadButton } from "./mark-read-button";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Notifications",
};

export const dynamic = "force-dynamic";

const ICONS = {
  payment_reminder: CreditCard,
  payment_confirmed: CreditCard,
  clearance_granted: ShieldCheck,
  risk_nudge: TrendingDown,
  grace_period: ShieldCheck,
  schedule_change: CalendarClock,
} as const;

export default async function NotificationsPage() {
  const notifications = await loadNotifications();
  const unread = notifications.filter((item) => !item.readAt).length;

  return (
    <AppShell role="student">
      <PageHeader
        title="Notifications"
        subtitle={unread > 0 ? `${unread} unread` : "You're up to date."}
        action={<MarkReadButton unread={unread} />}
      />

      {notifications.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={Bell}
          headline="Nothing yet"
          body="Payment reminders, schedule changes and attendance nudges appear here."
        />
      ) : (
        <ul className="mt-6 flex flex-col gap-2">
          {notifications.map((item) => {
            const Icon = ICONS[item.kind] ?? Bell;
            const isUnread = !item.readAt;
            return (
              <li
                key={item.id}
                className={cn(
                  "flex gap-3 rounded-lg border bg-surface p-4",
                  // Unread is carried by a border weight and the word
                  // "Unread", not by colour alone.
                  isUnread ? "border-l-2 border-l-brand border-line" : "border-line",
                )}
              >
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-slate" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-[15px] leading-snug font-semibold text-ink">
                      {item.title}
                    </h2>
                    {isUnread ? (
                      <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[11px] font-semibold text-slate">
                        Unread
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[14px] leading-relaxed text-slate">{item.body}</p>
                  <p className="mt-1.5 text-[12px] text-muted tabular">
                    {formatDateTime(item.createdAt)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </AppShell>
  );
}
