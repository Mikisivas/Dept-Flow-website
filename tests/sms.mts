/**
 * The SMS call, against a fake Africa's Talking. No network.
 *
 *   npm run test:sms
 */

import { sendSms } from "../src/lib/messaging.ts";

let failed = 0;
function check(what: string, passed: boolean) {
  console.log(`${passed ? "ok  " : "FAIL"} — ${what}`);
  if (!passed) failed++;
}

let url = "";
let init: RequestInit = {};
let reply: { status: number; json: unknown } = {
  status: 201,
  json: { SMSMessageData: { Recipients: [{ statusCode: 101, status: "Success", messageId: "ATXid_1" }] } },
};
globalThis.fetch = (async (u: string, i: RequestInit) => {
  url = String(u);
  init = i;
  return new Response(JSON.stringify(reply.json), { status: reply.status });
}) as typeof fetch;

process.env.SMS_API_KEY = "key-abc";
process.env.SMS_USERNAME = "sandbox";
process.env.SMS_SANDBOX = "true";

const sent = await sendSms({ to: "+2348051111111", body: "Final warning" });
check("sandbox posts to the sandbox host", url === "https://api.sandbox.africastalking.com/version1/messaging");
check("sends the key in the apiKey header", (init.headers as Record<string, string>).apiKey === "key-abc");
const form = new URLSearchParams(String(init.body));
check("form carries username, number and message", form.get("username") === "sandbox" && form.get("to") === "+2348051111111" && form.get("message") === "Final warning");
check("success returns the provider message id", sent.status === "sent" && sent.providerRef === "ATXid_1");

process.env.SMS_SANDBOX = "false";
await sendSms({ to: "+2348051111111", body: "x" });
check("live posts to the live host", url === "https://api.africastalking.com/version1/messaging");

reply = { status: 201, json: { SMSMessageData: { Recipients: [{ statusCode: 403, status: "InvalidPhoneNumber" }] } } };
const rejected = await sendSms({ to: "+234", body: "x" });
check("a rejected recipient is a failure, not a send", rejected.status === "failed" && rejected.error.includes("InvalidPhoneNumber"));

reply = { status: 401, json: {} };
const denied = await sendSms({ to: "+2348051111111", body: "x" });
check("an HTTP error is a failure", denied.status === "failed");

delete process.env.SMS_USERNAME;
const noUser = await sendSms({ to: "+2348051111111", body: "x" });
check("missing username fails loudly", noUser.status === "failed" && noUser.error.includes("SMS_USERNAME"));

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
