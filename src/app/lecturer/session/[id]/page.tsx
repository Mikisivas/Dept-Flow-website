import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { loadSessionControl } from "@/lib/data/lecturer";
import { SessionControlPanel } from "./session-control";

export const metadata: Metadata = {
  title: "Session",
};

// A live checkpoint has a five-minute life. Nothing on this screen may be
// served from a cache.
export const dynamic = "force-dynamic";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await loadSessionControl(id);

  if (!session) notFound();

  if (session.status === "closed") {
    return (
      <AppShell role="lecturer">
        <EmptyState
          icon={CheckCircle2}
          headline={`${session.courseCode} is scored`}
          body="This session has ended and every enrolled student now has a score for it."
          action={
            <Button asChild>
              <Link href={`/lecturer/session/${id}/review`}>See what was recorded</Link>
            </Button>
          }
        />
      </AppShell>
    );
  }

  return (
    <AppShell role="lecturer">
      <PageHeader title="Session" subtitle="Write the code on the board." />
      <div className="mt-6">
        <SessionControlPanel session={session} />
      </div>
    </AppShell>
  );
}
