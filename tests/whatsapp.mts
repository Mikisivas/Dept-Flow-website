/**
 * The WhatsApp Cloud API call, against a fake Meta.
 *
 * Nothing here reaches the network. What it pins down is the request this
 * system makes — Meta rejects a malformed template send outright, so the shape
 * is the thing most worth checking without credentials — and what it does
 * with each kind of answer.
 *
 *   npm run test:whatsapp
 */

import { sendOtp, sendWhatsApp } from "../src/lib/messaging.ts";

let failed = 0;
function check(what: string, passed: boolean) {
  console.log(`${passed ? "ok  " : "FAIL"} — ${what}`);
  if (!passed) failed++;
}

type SentBody = {
  messaging_product?: string;
  type?: string;
  to?: string;
  template?: {
    name?: string;
    language?: { code?: string };
    components?: Array<{ type?: string; parameters?: Array<{ text: string }> }>;
  };
};
type Captured = { url: string; init: RequestInit; body: SentBody };
let captured: Captured | null = null;
let reply: { status: number; json: unknown } = { status: 200, json: { messages: [{ id: "wamid.TEST" }] } };

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  captured = { url: String(url), init, body: JSON.parse(String(init.body)) };
  return new Response(JSON.stringify(reply.json), { status: reply.status });
}) as typeof fetch;

process.env.WHATSAPP_API_TOKEN = "token-abc";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
delete process.env.WHATSAPP_API_VERSION;
delete process.env.WHATSAPP_TEMPLATE_LANGUAGE;

// --- an alert ---------------------------------------------------------------

const sent = await sendWhatsApp({
  to: "+2348051111111",
  template: "eeas_alert",
  variables: ["CMP 301: you are on course to miss the 75% mark", "Projected 66.5%.\n\nAttend 13 of the 17   left."],
});

const c = captured as Captured | null;
check("posts to the Cloud API messages endpoint for the configured number", c?.url === "https://graph.facebook.com/v23.0/1234567890/messages");
check("authenticates with the bearer token", (c?.init.headers as Record<string, string>)?.Authorization === "Bearer token-abc");
check("sends a template, never free text", c?.body.type === "template" && c?.body.messaging_product === "whatsapp");
check("drops the plus from the number — Meta wants 234…, not +234…", c?.body.to === "2348051111111");
check("names the template and its language", c?.body.template?.name === "eeas_alert" && c?.body.template?.language?.code === "en");
const params = c?.body.template?.components?.[0]?.parameters ?? [];
check("fills {{1}} and {{2}} in order", params.length === 2 && params[0].text.startsWith("CMP 301"));
check(
  "flattens newlines and long runs of spaces, which Meta rejects in a parameter",
  params[1]?.text === "Projected 66.5%. Attend 13 of the 17 left.",
);
check("an accepted send is 'sent', carrying Meta's message id", sent.status === "sent" && sent.providerRef === "wamid.TEST");

// --- refusals ---------------------------------------------------------------

reply = { status: 400, json: { error: { message: "Recipient phone number not in allowed list", code: 131030 } } };
const refused = await sendWhatsApp({ to: "+2348050000001", template: "eeas_alert", variables: ["a", "b"] });
check(
  "a refusal is 'failed' and keeps Meta's reason, so the delivery row says what to fix",
  refused.status === "failed" && refused.error.includes("not in allowed list"),
);

globalThis.fetch = (async () => {
  throw new Error("getaddrinfo ENOTFOUND");
}) as typeof fetch;
const unreachable = await sendWhatsApp({ to: "+2348050000001", template: "eeas_alert", variables: ["a", "b"] });
check("no network is 'failed', not a crash in the dispatcher", unreachable.status === "failed");

// --- codes by WhatsApp ------------------------------------------------------

globalThis.fetch = (async (url: string, init: RequestInit) => {
  captured = { url: String(url), init, body: JSON.parse(String(init.body)) };
  return new Response(JSON.stringify({ messages: [{ id: "wamid.OTP" }] }), { status: 200 });
}) as typeof fetch;
reply = { status: 200, json: {} };

process.env.WHATSAPP_OTP_TEMPLATE = "eeas_otp";
captured = null;
await sendOtp({ to: "+2348051111111", code: "482913", channel: "whatsapp" });
const otp = captured as Captured | null;
const components = otp?.body.template?.components ?? [];
check(
  "a code goes in the body and in the copy-code button, as authentication templates require",
  components[0]?.parameters?.[0]?.text === "482913" &&
    components[1]?.type === "button" &&
    components[1]?.parameters?.[0]?.text === "482913",
);

delete process.env.WHATSAPP_OTP_TEMPLATE;
(process.env as Record<string, string>).NODE_ENV = "production";
captured = null;
const noTemplate = await sendOtp({ to: "+2348051111111", code: "482913", channel: "whatsapp" });
check(
  "with alerts connected but no authentication template, a code is refused rather than sent through the alert template",
  noTemplate.status === "failed" && captured === null,
);

process.env.DEMO_DEPLOYMENT = "true";
process.env.PAYSTACK_SECRET_KEY = "sk_test_x";
const demo = await sendOtp({ to: "+2348051111111", code: "482913", channel: "whatsapp" });
check("on a demo deployment that same code is shown instead", demo.status === "shown");

globalThis.fetch = realFetch;

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall WhatsApp checks pass");
