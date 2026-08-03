import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { requireStudent } from "@/lib/data/require-student";
import { loadPaymentHistory, reconcilePendingPayments } from "@/lib/data/payments";
import { DuesPayment } from "./dues-payment";

export const metadata: Metadata = {
  title: "Departmental dues",
};

// A payment can clear between two loads of this page, so it is never cached.
export const dynamic = "force-dynamic";

export default async function DuesPage() {
  const { student, compliance, dues, courses } = await requireStudent();
  const provisionalScore = courses.reduce((sum, course) => sum + course.provisionalScore, 0);
  // Resolve anything stuck before drawing the list, so no row shows a spinner
  // that will never stop.
  await reconcilePendingPayments(student.id);
  const payments = await loadPaymentHistory(student.id);

  return (
    <AppShell role="student">
      <PageHeader title="Departmental dues" />
      <div className="mt-6">
        <DuesPayment
          compliance={compliance}
          dues={dues}
          provisionalScore={provisionalScore}
          payments={payments}
        />
      </div>
    </AppShell>
  );
}
