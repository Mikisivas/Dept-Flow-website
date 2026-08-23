import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { loadCourseChoices, loadSentMessages } from "@/lib/data/hod";
import { MessageComposer } from "./message-composer";

export const metadata: Metadata = { title: "Message students" };

// The audience count is live, and a stale one is the difference between
// messaging twelve students and messaging four hundred.
export const dynamic = "force-dynamic";

export default async function HodMessagesPage() {
  const [courses, sent] = await Promise.all([loadCourseChoices(), loadSentMessages()]);

  return (
    <AppShell role="hod">
      <PageHeader
        title="Message students"
        subtitle="One student, a level, or everyone registered for a course."
      />
      <div className="mt-6">
        <MessageComposer courses={courses} sent={sent} />
      </div>
    </AppShell>
  );
}
