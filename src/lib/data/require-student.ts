import "server-only";

import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/current-user";
import { loadStudentDashboard, type StudentDashboard } from "@/lib/data/student";

/**
 * The student's own data, or a redirect to login.
 *
 * Every student screen goes through here, so "signed out" is handled once
 * rather than four times slightly differently.
 */
export async function requireStudent(): Promise<StudentDashboard> {
  const session = await currentUser();
  if (!session) redirect("/login");
  if (session.role !== "student") redirect(HOME_FOR_ROLE[session.role]);
  return loadStudentDashboard();
}

const HOME_FOR_ROLE = {
  student: "/dashboard",
  lecturer: "/lecturer",
  hod: "/hod",
  admin: "/admin",
} as const;
