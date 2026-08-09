import { NextResponse } from "next/server";
import { completePasswordReset, startPasswordReset } from "@/lib/data/password-reset";

/**
 * Two steps of one flow: ask for a code, then spend it on a new password.
 *
 * `no_account` is answered exactly like success. Anything else turns this
 * endpoint into a way to find out which matric numbers have accounts, which is
 * a list worth having if you are about to try passwords against them. The
 * masked phone is the one difference, and it is only present when a code was
 * genuinely sent — a caller who guessed wrong gets the reassuring sentence and
 * no number.
 */
export async function POST(request: Request) {
  let body: { step?: "start" | "complete"; matricNo?: string; code?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const matricNo = String(body.matricNo ?? "").trim();
  if (!matricNo) {
    return NextResponse.json({ error: "Enter your matric number." }, { status: 400 });
  }

  if (body.step === "complete") {
    const result = await completePasswordReset({
      matricNo,
      code: String(body.code ?? ""),
      password: String(body.password ?? ""),
    });

    if (result.outcome === "weak_password") {
      return NextResponse.json({ error: "Use at least 8 characters." }, { status: 400 });
    }
    if (result.outcome === "bad_code") {
      return NextResponse.json({ error: result.reason }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  }

  const result = await startPasswordReset(matricNo);

  if (result.outcome === "rate_limited") {
    return NextResponse.json(
      { error: "Too many codes requested for that account. Try again in an hour." },
      { status: 429 },
    );
  }

  if (result.outcome === "no_account") {
    return NextResponse.json({ ok: true, maskedPhone: null, expiresAt: null });
  }

  return NextResponse.json({
    ok: true,
    maskedPhone: result.maskedPhone,
    expiresAt: result.expiresAt,
  });
}
