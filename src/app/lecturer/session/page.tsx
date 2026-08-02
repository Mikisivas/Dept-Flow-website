import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Radio } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { getLecturerDashboard } from "@/lib/data/queries";

export const metadata: Metadata = {
  title: "Session",
};

/**
 * The "Session" tab needs somewhere to land whether or not a lecture is open.
 *
 * With one running it goes straight there — a lecturer tapping this tab mid-
 * lecture wants the code, not a menu. With none, it says so and points at the
 * place sessions are started, rather than 404ing on a tab the shell itself
 * offers.
 */
export default async function SessionIndexPage() {
  const { openSession } = await getLecturerDashboard();

  if (openSession) {
    redirect(`/lecturer/session/${openSession.sessionInstanceId}`);
  }

  return (
    <AppShell role="lecturer">
      <EmptyState
        icon={Radio}
        headline="No session is open"
        body="Start one from today's classes when you're in the hall, and the checkpoint codes appear here."
        action={
          <Button asChild>
            <Link href="/lecturer">See today&apos;s classes</Link>
          </Button>
        }
      />
    </AppShell>
  );
}
