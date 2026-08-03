import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  checkRegisterMatch,
  createStudentAccount,
  sendRegistrationOtp,
  verifyRegistrationOtp,
} from "@/lib/data/registration";
import { issueSession, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "@/lib/auth/session";
import { isValidMatric, normaliseMatric, normalisePhone } from "@/lib/format";
import { passwordProblem } from "@/lib/auth/passwords";

/**
 * The whole registration flow, one endpoint, switched on `step`.
 *
 * Four routes would each need the same three validations, and the version that
 * drifts is the one that lets somebody register against a matric number they
 * guessed. The steps are ordered here in the order the server enforces them,
 * which is not necessarily the order the screens run in.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const step = String(body.step ?? "");

  if (step === "check") return check(body);
  if (step === "send-otp") return sendOtp(body);
  if (step === "verify-otp") return verifyOtp(body);
  if (step === "create") return create(body);

  return NextResponse.json({ error: "Unknown step." }, { status: 400 });
}

async function check(body: Record<string, unknown>) {
  const matricNo = String(body.matricNo ?? "");
  const surname = String(body.surname ?? "");
  const level = Number(body.level ?? 0);

  if (!isValidMatric(matricNo)) {
    return NextResponse.json({ outcome: "no_match" });
  }
  if (!surname.trim() || ![100, 200, 300, 400].includes(level)) {
    return NextResponse.json({ outcome: "no_match" });
  }

  return NextResponse.json(await checkRegisterMatch({ matricNo, surname, level }));
}

async function sendOtp(body: Record<string, unknown>) {
  const matricNo = String(body.matricNo ?? "");
  // Accepts 0805…, 234805… or +234805… and stores exactly one of them.
  const phone = normalisePhone(String(body.phone ?? ""));

  if (!isValidMatric(matricNo) || !phone) {
    return NextResponse.json(
      { error: "Enter a Nigerian mobile number, like 0805 123 4567." },
      { status: 400 },
    );
  }

  const result = await sendRegistrationOtp({ matricNo, phone });

  if (result.outcome === "phone_taken") {
    return NextResponse.json(
      { error: "That number is already on an account. Use another, or reset your password." },
      { status: 409 },
    );
  }

  if (result.outcome === "rate_limited") {
    return NextResponse.json(
      { error: "Too many codes requested. Wait an hour and try again." },
      { status: 429 },
    );
  }

  // Never the code. Only when it dies.
  return NextResponse.json({ expiresAt: result.expiresAt });
}

async function verifyOtp(body: Record<string, unknown>) {
  const phone = normalisePhone(String(body.phone ?? ""));
  const code = String(body.code ?? "");

  if (!phone || !/^\d{6}$/.test(code)) {
    return NextResponse.json({ ok: false, reason: "Enter the 6-digit code." });
  }

  return NextResponse.json(await verifyRegistrationOtp({ phone, code }));
}

async function create(body: Record<string, unknown>) {
  const matricNo = String(body.matricNo ?? "");
  const surname = String(body.surname ?? "");
  const firstName = String(body.firstName ?? "").trim();
  const otherNames = String(body.otherNames ?? "").trim() || null;
  const phone = normalisePhone(String(body.phone ?? ""));
  const password = String(body.password ?? "");
  const level = Number(body.level ?? 0);

  if (!phone) {
    return NextResponse.json({ error: "Enter a Nigerian mobile number." }, { status: 400 });
  }
  if (!firstName) {
    return NextResponse.json({ error: "Enter your first name." }, { status: 400 });
  }

  // The same rule the client shows, applied where it cannot be skipped.
  const problem = passwordProblem(password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const result = await createStudentAccount({
    matricNo,
    surname,
    level,
    firstName,
    otherNames,
    phone,
    password,
  });

  if (result.outcome === "not_verified") {
    return NextResponse.json(
      { error: "Verify your phone number first." },
      { status: 403 },
    );
  }

  if (result.outcome === "no_match") {
    return NextResponse.json(
      { error: "Those details don't match the register." },
      { status: 409 },
    );
  }

  if (result.outcome === "already_claimed") {
    return NextResponse.json(
      { error: "That matric number already has an account." },
      { status: 409 },
    );
  }

  // Straight into a session. Making somebody who just chose a password type it
  // again on a login screen is a step that exists for no one's benefit.
  const token = await issueSession({
    profileId: result.profileId,
    role: "student",
    identifier: normaliseMatric(result.matricNo),
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);

  return NextResponse.json({ redirectTo: "/dashboard" });
}
