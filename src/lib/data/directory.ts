import "server-only";

import { createUserClient } from "@/lib/supabase/client";
import { ok, QueryFailed } from "@/lib/supabase/result";

/**
 * The university's faculties and their departments, for the landing page.
 *
 * Read as the anonymous role: the landing page is shown before anyone logs
 * in, and `faculties` and `departments` are the only tables that role can
 * read. Exactly one department is active — the one this system serves.
 */
export type Directory = Array<{
  id: string;
  name: string;
  departments: Array<{ id: string; name: string; active: boolean }>;
}>;

/**
 * `null` when the list could not be read.
 *
 * Deliberately not a throw, unlike every other read in this codebase. The
 * landing page's real job is the "Log in" button, and an error boundary in
 * its place would lock every student out over a directory that is decoration
 * to them. The page says the list could not be loaded instead — which is the
 * truth, where an empty list would claim the university has no faculties.
 */
export async function loadDirectory(): Promise<Directory | null> {
  const db = createUserClient();

  try {
    const [{ data: faculties }, { data: departments }] = await Promise.all([
      db.from("faculties").select("id, name, sort_order").order("sort_order").then((r) => ok(r, "faculties")),
      db
        .from("departments")
        .select("id, faculty_id, name, is_active, sort_order")
        .order("sort_order")
        .then((r) => ok(r, "departments")),
    ]);

    return (faculties ?? []).map((faculty) => ({
      id: faculty.id,
      name: faculty.name,
      departments: (departments ?? [])
        .filter((department) => department.faculty_id === faculty.id)
        .map((department) => ({
          id: department.id,
          name: department.name,
          active: department.is_active,
        })),
    }));
  } catch (error) {
    if (!(error instanceof QueryFailed)) throw error;
    console.error(error.message, error.cause);
    return null;
  }
}
