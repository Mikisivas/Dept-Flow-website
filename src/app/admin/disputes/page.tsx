import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { loadRegistrationDisputes } from "@/lib/data/admin";
import { RegistrationDisputes } from "./registration-disputes";

export const metadata: Metadata = { title: "Registration disputes" };

export const dynamic = "force-dynamic";

export default async function RegistrationDisputesPage() {
  const disputes = await loadRegistrationDisputes();

  return (
    <AppShell role="admin">
      <PageHeader
        title="Registration disputes"
        subtitle="Revoking frees the matric number without deleting the existing account."
      />
      <div className="mt-6">
        <RegistrationDisputes disputes={disputes} />
      </div>
    </AppShell>
  );
}
