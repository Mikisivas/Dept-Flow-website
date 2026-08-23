import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { loadGraceScreen } from "@/lib/data/hod";
import { GraceControl } from "./grace-control";

export const metadata: Metadata = {
  title: "Registration exceptions",
};

// Opening one changes who can record attendance right now, so this screen is
// never served from a cache.
export const dynamic = "force-dynamic";

export default async function GracePeriodPage() {
  const { active, history, impact, levelCounts } = await loadGraceScreen();

  return (
    <AppShell role="hod">
      <PageHeader
        title="Registration exceptions"
        subtitle="Lets a student record attendance when the registration deadline passed without them."
      />
      <div className="mt-6">
        <GraceControl
          active={active}
          history={history}
          impact={impact}
          levelCounts={levelCounts}
        />
      </div>
    </AppShell>
  );
}
