import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { startDuesPayment } from "@/lib/data/payments";
import { PaystackNotConfigured } from "@/lib/paystack";
import type { PaymentChannel } from "@/lib/types";

/**
 * Starting a dues payment.
 *
 * The body carries nothing. Who is paying comes from the session cookie and
 * how much comes from `dues_periods` — a request that could name its own
 * student or its own amount would defeat the entire mechanism, so neither is
 * accepted from the browser.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "student") {
    return NextResponse.json({ error: "Sign in to pay your dues." }, { status: 401 });
  }

  // The one thing the browser is allowed to choose. A preference for how to
  // pay is not a price.
  let channel: PaymentChannel = "card";
  try {
    const body = await request.json();
    if (body?.channel === "transfer") channel = "transfer";
  } catch {
    // No body is fine — card is the default on the screen too.
  }

  try {
    const result = await startDuesPayment(session.profileId, channel);

    if (result.outcome === "already_cleared") {
      return NextResponse.json({ error: "Your dues are already cleared." }, { status: 409 });
    }

    if (result.outcome === "no_dues_period") {
      return NextResponse.json(
        { error: "No dues have been set for this session yet." },
        { status: 409 },
      );
    }

    return NextResponse.json({
      authorizationUrl: result.authorizationUrl,
      reference: result.reference,
    });
  } catch (error) {
    console.error("payment initialise failed", error);

    // Nothing the student does will fix this, so they are not told to retry.
    if (error instanceof PaystackNotConfigured) {
      return NextResponse.json(
        {
          error: "Payments aren't switched on yet. Tell the department office.",
          // Read by whoever is running the server, not shown on the phone.
          hint: "PAYSTACK_SECRET_KEY is missing from .env.local. See /api/health.",
        },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        error: "We couldn't reach Paystack. Try again in a moment.",
        hint: (error as Error).message,
      },
      { status: 503 },
    );
  }
}
