import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { currentUser } from "@/lib/auth/current-user";
import { loadStudentRegistration } from "@/lib/data/courses";
import { CourseRegistration } from "./course-registration";

export const metadata: Metadata = { title: "Your courses" };

// The credit total changes as the student adds and removes, so a cached copy
// would show them a number they have already moved past.
export const dynamic = "force-dynamic";

export default async function CourseRegistrationPage() {
  const session = await currentUser();
  if (!session) redirect("/login");
  if (session.role !== "student") redirect("/lecturer");

  const registration = await loadStudentRegistration(session.profileId);

  return (
    <AppShell role="student">
      <PageHeader
        title="Your courses"
        subtitle={`Level ${registration.level} · semester ${registration.semester}`}
      />
      <div className="mt-6">
        <CourseRegistration registration={registration} />
      </div>
    </AppShell>
  );
}
