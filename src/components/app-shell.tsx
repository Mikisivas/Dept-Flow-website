"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BadgeCheck,
  CalendarDays,
  ClipboardList,
  CreditCard,
  Gauge,
  GraduationCap,
  House,
  KeySquare,
  ListChecks,
  Radio,
  ScrollText,
  Settings,
  ShieldAlert,
  TriangleAlert,
  UserRound,
  Users,
} from "lucide-react";
import type { AppRole } from "@/lib/types";
import { SiteMark } from "@/components/site-mark";
import { cn } from "@/lib/utils";

/**
 * Students hold a phone one-handed, so they get a bottom bar. Lecturers
 * operate session control standing in front of a class, which is the same
 * constraint, so they get one too. HOD and admin get a desktop sidebar.
 *
 * This is a website, not an app: the bottom bar is a sticky nav of real links
 * to real routes. Every tab is a URL that can be pasted into a class WhatsApp
 * group, and back/forward behave the way the browser's do.
 *
 * Navigation differs per role by OMISSION, never by disabled items — the HOD
 * sidebar has no configuration entry at all, rather than a greyed-out one that
 * advertises a capability they will never have.
 */

type NavItem = {
  href: string;
  label: string;
  icon: typeof House;
  /** Nav count badges are the only numbers in the shell. */
  count?: number;
};

const NAV: Record<AppRole, NavItem[]> = {
  student: [
    { href: "/dashboard", label: "Home", icon: House },
    { href: "/attend", label: "Enter code", icon: KeySquare },
    { href: "/dues", label: "Dues", icon: CreditCard },
    { href: "/profile", label: "You", icon: UserRound },
  ],
  lecturer: [
    { href: "/lecturer", label: "Today", icon: House },
    { href: "/lecturer/session", label: "Session", icon: Radio },
    { href: "/lecturer/schedule", label: "Schedule", icon: CalendarDays },
    { href: "/lecturer/courses", label: "Courses", icon: GraduationCap },
  ],
  hod: [
    { href: "/hod", label: "Overview", icon: Gauge },
    { href: "/hod/risk", label: "At-risk students", icon: TriangleAlert },
    { href: "/hod/grace", label: "Grace period", icon: ShieldAlert },
    { href: "/hod/waivers", label: "Waivers", icon: BadgeCheck },
    { href: "/hod/disputes", label: "Disputes", icon: ClipboardList },
    { href: "/hod/eligibility", label: "Eligibility list", icon: ListChecks },
    { href: "/hod/lecturers", label: "Lecturers", icon: Users },
  ],
  admin: [
    { href: "/admin", label: "Overview", icon: Gauge },
    { href: "/admin/whitelist", label: "Register", icon: ClipboardList },
    { href: "/admin/students", label: "Students", icon: Users },
    { href: "/admin/payments", label: "Payments", icon: CreditCard },
    { href: "/admin/timetable", label: "Timetable", icon: CalendarDays },
    { href: "/admin/config", label: "Configuration", icon: Settings },
    { href: "/admin/audit", label: "Audit log", icon: ScrollText },
  ],
};

const ROLE_LABEL: Record<AppRole, string> = {
  student: "Student",
  lecturer: "Lecturer",
  hod: "HOD",
  admin: "Admin",
};

/**
 * Exactly one tab is active at a time.
 *
 * A plain prefix test marks two: on /lecturer/session/123 both "/lecturer" and
 * "/lecturer/session" match, and the shell lights up two tabs at once. The
 * longest matching href is the real destination.
 */
function useActiveHref(items: NavItem[]) {
  const pathname = usePathname();

  return items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

export function AppShell({
  role,
  counts,
  children,
}: {
  role: AppRole;
  /** Keyed by href — "38" next to At-risk students. */
  counts?: Record<string, number>;
  children: React.ReactNode;
}) {
  const items = NAV[role].map((item) => ({ ...item, count: counts?.[item.href] }));
  const usesBottomBar = role === "student" || role === "lecturer";

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className={cn(
          "sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-100",
          "focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-ink focus:shadow-lg",
        )}
      >
        Skip to content
      </a>

      {usesBottomBar ? (
        <BottomBarLayout role={role} items={items}>
          {children}
        </BottomBarLayout>
      ) : (
        <SidebarLayout role={role} items={items}>
          {children}
        </SidebarLayout>
      )}
    </div>
  );
}

function BottomBarLayout({
  role,
  items,
  children,
}: {
  role: AppRole;
  items: NavItem[];
  children: React.ReactNode;
}) {
  const activeHref = useActiveHref(items);

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-2 px-4">
          <SiteMark size={24} />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Dept-Flow</span>
          <span className="ml-auto text-[13px] text-muted">{ROLE_LABEL[role]}</span>
        </div>
      </header>

      <main
        id="main"
        className="mx-auto max-w-3xl px-4 pt-5 pb-[calc(5rem+env(safe-area-inset-bottom))]"
      >
        {children}
      </main>

      <nav
        aria-label="Primary"
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface",
          "pb-[env(safe-area-inset-bottom)]",
        )}
      >
        <ul className="mx-auto flex max-w-3xl">
          {items.map(({ href, label, icon: Icon }) => {
            const active = href === activeHref;
            return (
              <li key={href} className="flex-1">
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    // 44px minimum, and the active state is a rule plus a
                    // weight change — never colour alone.
                    "relative flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 py-2",
                    "text-[11px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--brand-text)]",
                    active ? "font-semibold text-ink" : "font-medium text-muted",
                  )}
                >
                  {active ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-brand"
                    />
                  ) : null}
                  <Icon className="h-5 w-5" aria-hidden="true" />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}

function SidebarLayout({
  role,
  items,
  children,
}: {
  role: AppRole;
  items: NavItem[];
  children: React.ReactNode;
}) {
  const activeHref = useActiveHref(items);

  return (
    <div className="lg:grid lg:grid-cols-[16rem_1fr]">
      <header className="border-b border-line bg-surface lg:sticky lg:top-0 lg:h-dvh lg:border-r lg:border-b-0">
        <div className="flex h-14 items-center gap-2 px-4 lg:h-16">
          <SiteMark size={24} />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Dept-Flow</span>
          <span className="ml-auto text-[13px] text-muted lg:ml-2">{ROLE_LABEL[role]}</span>
        </div>

        <nav aria-label="Primary" className="px-2 pb-3 lg:pb-0">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {items.map(({ href, label, icon: Icon, count }) => {
              const active = href === activeHref;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 items-center gap-2.5 rounded-md px-3 text-[14px] whitespace-nowrap",
                      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--brand-text)]",
                      active
                        ? "border-l-2 border-brand bg-brand-tint font-semibold text-ink lg:rounded-l-none"
                        : "font-medium text-slate hover:bg-surface-sunken",
                    )}
                  >
                    <Icon className="h-4.5 w-4.5 shrink-0" aria-hidden="true" />
                    <span className="flex-1">{label}</span>
                    {count !== undefined ? (
                      <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[12px] font-semibold text-slate tabular">
                        {count}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>

      <main id="main" className="mx-auto w-full max-w-5xl px-4 py-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
