import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { uploadCourses } from "@/lib/data/courses";

/**
 * The admin uploading the course list for a level.
 *
 * Upserts rather than replaces: re-uploading a corrected list changes the
 * courses in place, so every enrolment, lecture and score already hanging off
 * those course ids survives. A delete-and-recreate would take a term of
 * attendance with it.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Only an admin can upload courses." }, { status: 403 });
  }

  let body: { csv?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const csv = String(body.csv ?? "").trim();
  if (!csv) return NextResponse.json({ error: "Paste the course list first." }, { status: 400 });

  try {
    return NextResponse.json(await uploadCourses(csv));
  } catch (error) {
    console.error("course upload failed", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
