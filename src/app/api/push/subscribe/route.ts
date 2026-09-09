import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";
import { ok } from "@/lib/supabase/result";

/**
 * A browser registering itself for Web Push.
 *
 * The subscription object comes from the push service, not from this
 * application — it is an opaque endpoint plus two keys, and it is written down
 * as given. There is nothing in it worth validating beyond "has an endpoint":
 * the push service is the only party that can say whether it is real, and it
 * says so by refusing the first send.
 *
 * The owner is the session, never the body. A subscription posted with someone
 * else's profile id would deliver another student's attendance warnings to
 * this browser — the plainest IDOR in the system, and it is closed by simply
 * never reading an id from the request.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  let body: { subscription?: { endpoint?: string }; userAgent?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const subscription = body.subscription;
  const endpoint = subscription?.endpoint;

  if (!subscription || typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    return NextResponse.json({ error: "That is not a push subscription." }, { status: 400 });
  }

  const db = createServiceClient();

  // Upsert on the endpoint, which is the browser's identity. Re-subscribing —
  // which browsers do on their own when a key rotates — must update the row
  // rather than add a second one that delivers the same notification twice.
  //
  // The profile is part of the update, so a shared phone follows whoever is
  // signed in now. Two students on one handset should not both keep receiving
  // each other's warnings.
  const { error } = await db.from("push_subscriptions").upsert(
    {
      profile_id: session.profileId,
      endpoint,
      subscription,
      user_agent: String(body.userAgent ?? "").slice(0, 300) || null,
      last_used_at: new Date().toISOString(),
    },
    { onConflict: "endpoint" },
  );

  if (error) {
    return NextResponse.json({ error: "Could not save that." }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * Turning push off.
 *
 * Deletes by endpoint, and only one belonging to the signed-in profile —
 * knowing another browser's endpoint must not be enough to silence its
 * warnings.
 */
export async function DELETE(request: Request) {
  const session = await currentUser();
  if (!session) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  let body: { endpoint?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const endpoint = String(body.endpoint ?? "");
  if (!endpoint) return NextResponse.json({ error: "Which browser?" }, { status: 400 });

  // Checked, because the answer below is `ok: true`. A student turning
  // notifications off and being told it worked, while the subscription row
  // survives, keeps receiving them from a system that has said it stopped.
  ok(
    await createServiceClient()
      .from("push_subscriptions")
      .delete()
      .eq("endpoint", endpoint)
      .eq("profile_id", session.profileId),
    "removing the subscription",
  );

  return NextResponse.json({ ok: true });
}
