import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { currentUser } from "@/lib/auth/current-user";
import { loadStudentRegistration } from "@/lib/data/courses";
import { cn } from "@/lib/utils";
import { CourseRegistration } from "./course-registration";

export const metadata: Metadata = { title: "Your courses" };

// The credit total changes as the student adds and removes, so a cached copy
// would show them a number they have already moved past.
export const dynamic = "force-dynamic";

export default async function CourseRegistrationPage({
  searchParams,
}: {
  searchParams: Promise<{ semester?: string }>;
}) {
  const session = await currentUser();
  if (!session) redirect("/login");
  if (session.role !== "student") redirect("/lecturer");

  const params = await searchParams;
  const asked = Number(params.semester);
  // Omitted rather than defaulted to 1, so the loader can work out which
  // semester today actually falls in.
  const semester = asked === 1 || asked === 2 ? asked : undefined;

  const registration = await loadStudentRegistration(session.profileId, semester);

  return (
    <AppShell role="student">
      <PageHeader title="Your courses" subtitle={`Level ${registration.level}`} />

      {/* Real links, not tab state. This is a website: a student can send
          "my second semester courses" to someone, and back works. */}
      <nav aria-label="Semester" className="mt-4 flex gap-1 rounded-lg border border-line p-1">
        {[1, 2].map((value) => {
          const active = registration.semester === value;
          return (
            <Link
              key={value}
              href={`/courses/register?semester=${value}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex-1 rounded-md py-2 text-center text-[14px] font-medium",
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--brand-text)]",
                active
                  ? "bg-brand text-[var(--on-brand)]"
                  : "text-slate hover:bg-surface-sunken",
              )}
            >
              {value === 1 ? "First semester" : "Second semester"}
            </Link>
          );
        })}
      </nav>

      <div className="mt-6">
        <CourseRegistration registration={registration} />
      </div>
    </AppShell>
  );
}
