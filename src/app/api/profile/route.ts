import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import {
  changePassword,
  completePhoneChange,
  startPhoneChange,
} from "@/lib/data/password-reset";

/**
 * The two things a signed-in account can change about itself.
 *
 * Name, matric number and level are not among them — those come from the
 * department's register, and letting them drift would break the one thing the
 * register is for.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: {
    action?: "password" | "phone-start" | "phone-confirm";
    currentPassword?: string;
    newPassword?: string;
    phone?: string;
    code?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  if (body.action === "password") {
    const result = await changePassword({
      profileId: session.profileId,
      currentPassword: String(body.currentPassword ?? ""),
      newPassword: String(body.newPassword ?? ""),
    });

    if (result.outcome === "weak_password") {
      return NextResponse.json({ error: "Use at least 8 characters." }, { status: 400 });
    }
    if (result.outcome === "wrong_current") {
      return NextResponse.json({ error: "That current password isn't right." }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "phone-start") {
    const result = await startPhoneChange({
      profileId: session.profileId,
      phone: String(body.phone ?? ""),
    });

    if (result.outcome === "invalid") {
      return NextResponse.json(
        { error: "Nigerian mobile numbers look like +2348051234567." },
        { status: 400 },
      );
    }
    if (result.outcome === "phone_taken") {
      return NextResponse.json(
        { error: "That number is already on another account." },
        { status: 409 },
      );
    }
    if (result.outcome === "rate_limited") {
      return NextResponse.json(
        { error: "Too many codes requested for that number. Try again in an hour." },
        { status: 429 },
      );
    }
    return NextResponse.json({ ok: true, expiresAt: result.expiresAt });
  }

  if (body.action === "phone-confirm") {
    const result = await completePhoneChange({
      profileId: session.profileId,
      phone: String(body.phone ?? ""),
      code: String(body.code ?? ""),
    });

    if (result.outcome === "bad_code") {
      return NextResponse.json({ error: result.reason }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
