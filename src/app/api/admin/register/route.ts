import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { commitRegisterUpload, previewRegisterUpload } from "@/lib/data/admin";

/**
 * The register, pasted in.
 *
 * Preview and commit are separate calls because the preview is the safeguard,
 * not a courtesy: one column out of alignment turns every surname into a level
 * and locks out a whole year. Making the diff a step the administrator has to
 * read is the only thing that catches it.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "admin") {
    return NextResponse.json(
      { error: "Only an administrator can upload the register." },
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
    return NextResponse.json({ error: "Paste the register first." }, { status: 400 });
  }

  try {
    if (body.step === "commit") {
      return NextResponse.json({ ok: true, result: await commitRegisterUpload(csv) });
    }
    return NextResponse.json({ ok: true, preview: await previewRegisterUpload(csv) });
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : "That upload did not go through." },
      { status: 400 },
    );
  }
}
