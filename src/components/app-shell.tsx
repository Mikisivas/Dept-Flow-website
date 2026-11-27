"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  ClipboardList,
  CreditCard,
  FileCheck,
  Gauge,
  GraduationCap,
  House,
  KeySquare,
  ListChecks,
  Radio,
  ScrollText,
  Send,
  Settings,
  ShieldAlert,
  ShieldQuestion,
  TriangleAlert,
  UserRound,
  Users,
} from "lucide-react";
import type { AppRole } from "@/lib/types";
import { LogOutButton } from "@/components/log-out-button";
import { UniversityLogo } from "@/components/university-logo";
import { INSTITUTION } from "@/lib/institution";
import { cn } from "@/lib/utils";

/**
 * Students hold a phone one-handed, so below 1024px they get a bottom bar.
 * Lecturers operate session control standing in front of a class, which is the
 * same constraint, so they get one too. HOD and admin get a strip of links
 * under the header on a phone. From 1024px up (a tablet held landscape, a
 * laptop, a monitor, a television) every role gets the same left sidebar, so
 * the layout never leaves a phone-width column floating in a wide screen.
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
    { href: "/permit", label: "Permit", icon: FileCheck },
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
    // Directly under the at-risk list, because that is the order the work
    // happens in: see who is falling behind, then tell them so.
    { href: "/hod/messages", label: "Message students", icon: Send },
    { href: "/hod/payments", label: "Payment compliance", icon: CreditCard },
    { href: "/hod/grace", label: "Exceptions", icon: ShieldAlert },
    { href: "/hod/disputes", label: "Disputes", icon: ClipboardList },
    { href: "/hod/eligibility", label: "Eligibility list", icon: ListChecks },
    { href: "/hod/lecturers", label: "Lecturers", icon: Users },
  ],
  admin: [
    { href: "/admin", label: "Overview", icon: Gauge },
    { href: "/admin/whitelist", label: "Register", icon: ClipboardList },
    { href: "/admin/students", label: "Students", icon: Users },
    { href: "/admin/courses", label: "Courses", icon: BookOpen },
    { href: "/admin/timetable", label: "Timetable", icon: CalendarDays },
    { href: "/admin/payments", label: "Payments", icon: CreditCard },
    {
      href: "/admin/disputes",
      label: "Registration disputes",
      icon: ShieldQuestion,
    },
    { href: "/admin/config", label: "Configuration", icon: Settings },
    { href: "/admin/audit", label: "Audit log", icon: ScrollText },
    { href: "/admin/rollover", label: "Level rollover", icon: ArrowUpRight },
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
    .filter(
      (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
    )
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
  const items = NAV[role].map((item) => ({
    ...item,
    count: counts?.[item.href],
  }));
  const bottomBar = role === "student" || role === "lecturer";

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

      <ShellLayout role={role} items={items} bottomBar={bottomBar}>
        {children}
      </ShellLayout>
    </div>
  );
}

/**
 * One layout for every role and every screen.
 *
 *   < 1024px   a top bar. Students and lecturers also get the fixed bottom bar;
 *              HOD and admin get their links as a scrolling strip.
 *   >= 1024px  a 16rem sidebar (18rem from 1536px) and a centred content column.
 *
 * The content column widens with the screen — 48rem on a phone, 56rem beside
 * the sidebar for students and lecturers, 64rem and then 80rem for the HOD and
 * admin, whose tables earn the room — and is always centred, so a monitor or a
 * television shows margins rather than stretched lines of text.
 */
function ShellLayout({
  role,
  items,
  bottomBar,
  children,
}: {
  role: AppRole;
  items: NavItem[];
  bottomBar: boolean;
  children: React.ReactNode;
}) {
  const activeHref = useActiveHref(items);

  return (
    <>
      <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] 2xl:grid-cols-[18rem_minmax(0,1fr)]">
        <header
          className={cn(
            "border-b border-line bg-surface",
            "lg:sticky lg:top-0 lg:h-dvh lg:overflow-y-auto lg:border-r lg:border-b-0",
            // On a phone the student and lecturer top bar stays put while the
            // page scrolls; the HOD and admin one scrolls away with the page.
            bottomBar && "sticky top-0 z-40",
          )}
        >
          <div
            className={cn(
              "flex h-14 items-center gap-2 px-4 lg:h-16",
              bottomBar && "mx-auto max-w-3xl lg:max-w-none",
            )}
          >
            <UniversityLogo size={28} decorative />
            <span
              className="text-[15px] font-semibold tracking-[-0.01em]"
              title={INSTITUTION.system}
            >
              {INSTITUTION.systemShort}
            </span>
            {/* Every role needs a way out of the session, on every screen. The
                student also has one on /profile; lecturers had nowhere at all,
                which meant a shared staff laptop could not be handed over. */}
            <span className="ml-auto text-[13px] text-muted lg:ml-2">
              {ROLE_LABEL[role]}
            </span>
            <LogOutButton className="-mr-2 h-9 px-2 text-[13px] lg:ml-auto lg:-mr-1" />
          </div>

          {/* Hidden below 1024px for the roles that have the bottom bar, so
              there is exactly one primary navigation on screen at a time. */}
          <nav
            aria-label="Primary"
            className={cn("px-2 pb-3 lg:pb-3", bottomBar && "hidden lg:block")}
          >
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
                        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-text",
                        active
                          ? "border-l-2 border-brand bg-brand-tint font-semibold text-ink lg:rounded-l-none"
                          : "font-medium text-slate hover:bg-surface-sunken",
                      )}
                    >
                      <Icon
                        className="h-4.5 w-4.5 shrink-0"
                        aria-hidden="true"
                      />
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

        {/* min-w-0 lets a wide table scroll inside its own box instead of
            pushing the whole page sideways. */}
        <main
          id="main"
          className={cn(
            "mx-auto w-full min-w-0 px-4",
            bottomBar
              ? "max-w-3xl pt-5 pb-[calc(5rem+env(safe-area-inset-bottom))] lg:max-w-4xl lg:px-8 lg:pt-8 lg:pb-12"
              : "max-w-5xl py-6 lg:px-8 xl:max-w-6xl 2xl:max-w-7xl",
          )}
        >
          {children}
        </main>
      </div>

      {bottomBar ? (
        <nav
          aria-label="Primary"
          className={cn(
            "fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface lg:hidden",
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
                      "text-[11px] md:text-[13px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-text",
                      active
                        ? "font-semibold text-ink"
                        : "font-medium text-muted",
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
      ) : null}
    </>
  );
}
