import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { getGracePeriods } from "@/lib/data/queries";
import { GraceControl } from "./grace-control";

export const metadata: Metadata = {
  title: "Grace period",
};

export default async function GracePeriodPage() {
  const { active, history, impact } = await getGracePeriods();

  return (
    <AppShell role="hod">
      <PageHeader
        title="Grace period"
        subtitle="Restores attendance access for students locked out by unpaid dues."
      />
      <div className="mt-6">
        <GraceControl
          active={active}
          history={history}
          impact={impact}
          levelCounts={{ "100": 18, "200": 27, "300": 34, "400": 64 }}
        />
      </div>
    </AppShell>
  );
}
