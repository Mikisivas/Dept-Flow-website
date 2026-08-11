import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { commitTimetableUpload, previewTimetableUpload } from "@/lib/data/admin";

/**
 * The weekly timetable, pasted in.
 *
 * Preview and commit are separate calls for the same reason the register's
 * are: a timetable entry is what makes a lecture startable at all, so a row
 * silently dropped is a class nobody can open and a term of attendance nobody
 * can record.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "admin") {
    return NextResponse.json(
      { error: "Only an administrator can upload the timetable." },
      { status: 403 },
    );
  }

  let body: { step?: "preview" | "commit"; csv?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const csv = String(body.csv ?? "");
  if (!csv.trim()) {
    return NextResponse.json({ error: "Paste the timetable first." }, { status: 400 });
  }

  try {
    if (body.step === "commit") {
      return NextResponse.json({ ok: true, result: await commitTimetableUpload(csv) });
    }
    return NextResponse.json({ ok: true, preview: await previewTimetableUpload(csv) });
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : "That upload did not go through." },
      { status: 400 },
    );
  }
}
