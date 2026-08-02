import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { getEligibilityList } from "@/lib/data/queries";
import { EligibilityList } from "./eligibility-list";

export const metadata: Metadata = {
  title: "Exam eligibility",
};

export default async function EligibilityPage() {
  const list = await getEligibilityList();

  return (
    <AppShell role="hod">
      <PageHeader
        title={`${list.courseCode} · exam eligibility`}
        subtitle="The department's formal record of who may sit the exam."
      />
      <div className="mt-6">
        <EligibilityList
          courseCode={list.courseCode}
          entries={list.entries}
          thresholdPct={list.thresholdPct}
          status={list.status}
          authorizedBy={list.authorizedBy}
          authorizedAt={list.authorizedAt}
        />
      </div>
    </AppShell>
  );
}
