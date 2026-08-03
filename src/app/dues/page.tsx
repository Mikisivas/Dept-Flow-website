import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { requireStudent } from "@/lib/data/require-student";
import { DuesPayment } from "./dues-payment";

export const metadata: Metadata = {
  title: "Departmental dues",
};

export default async function DuesPage() {
  const { compliance, dues, courses } = await requireStudent();
  const provisionalScore = courses.reduce((sum, course) => sum + course.provisionalScore, 0);

  return (
    <AppShell role="student">
      <PageHeader title="Departmental dues" />
      <div className="mt-6">
        <DuesPayment compliance={compliance} dues={dues} provisionalScore={provisionalScore} />
      </div>
    </AppShell>
  );
}
