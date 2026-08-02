import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { getAdminStudents } from "@/lib/data/queries";
import { StudentTable } from "./student-table";

export const metadata: Metadata = { title: "Students" };

export default async function AdminStudentsPage() {
  const students = await getAdminStudents();

  return (
    <AppShell role="admin">
      <PageHeader
        title="Students"
        subtitle="Deactivation is a soft delete — history is kept and the matric number is retired."
      />
      <div className="mt-6">
        <StudentTable students={students} />
      </div>
    </AppShell>
  );
}
