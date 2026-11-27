import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * Checking a permit at the hall door.
 *
 * Deliberately unauthenticated: an invigilator holding the paper is not going
 * to be given an account. The reference stands in for the permit — it is
 * unguessable, and whoever has it already has the document.
 *
 * `verify_exam_permit` returns only what answers "is this real and what does
 * it entitle them to": the name, the matric number, the papers. No attendance
 * percentages, no dues history. A permit check is not a records request.
 */
export async function POST(request: Request) {
  let body: { reference?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const reference = String(body.reference ?? "").trim();
  if (!reference) {
    return NextResponse.json({ error: "Enter the reference from the permit." }, { status: 400 });
  }

  const { data, error } = await createServiceClient().rpc("verify_exam_permit", {
    p_reference: reference,
  });

  if (error) {
    return NextResponse.json({ error: "Could not check that reference." }, { status: 400 });
  }

  return NextResponse.json(data);
}
