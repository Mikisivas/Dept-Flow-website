/**
 * WhatsApp Cloud API automated test.
 *
 * Nothing here reaches Meta.
 *
 * Run:
 * npm run test:whatsapp
 */

import { sendOtp, sendWhatsApp } from "../src/lib/messaging.ts";

let failed = 0;

function check(what: string, passed: boolean) {
  console.log(`${passed ? "ok  " : "FAIL"} — ${what}`);

  if (!passed) failed++;
}

type SentParameter = {
  type?: string;
  text: string;
  parameter_name?: string;
};

type SentBody = {
  messaging_product?: string;
  type?: string;
  to?: string;

  template?: {
    name?: string;

    language?: {
      code?: string;
    };

    components?: Array<{
      type?: string;
      sub_type?: string;
      index?: string;
      parameters?: SentParameter[];
    }>;
  };
};

type Captured = {
  url: string;
  init: RequestInit;
  body: SentBody;
};

let captured: Captured | null = null;

let reply: {
  status: number;
  json: unknown;
} = {
  status: 200,

  json: {
    messages: [
      {
        id: "wamid.TEST",
      },
    ],
  },
};

const realFetch = globalThis.fetch;

globalThis.fetch = (async (url: string, init: RequestInit) => {
  captured = {
    url: String(url),

    init,

    body: JSON.parse(String(init.body)),
  };

  return new Response(JSON.stringify(reply.json), {
    status: reply.status,
  });
}) as typeof fetch;

// TEST ENVIRONMENT

process.env.WHATSAPP_API_TOKEN = "token-abc";

process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";

delete process.env.WHATSAPP_API_VERSION;

delete process.env.WHATSAPP_TEMPLATE_LANGUAGE;

// NAMED ALERT TEST

const sent = await sendWhatsApp({
  to: "+2348051111111",

  template: "eeas_alert",

  variables: [
    "CMP 301: you are on course to miss the 75% mark",

    "Projected 66.5%.\n\nAttend 13 of the 17   left.",
  ],

  parameterNames: ["alert_title", "alert_detail"],
});

const c = captured as Captured | null;

check(
  "posts to the Cloud API messages endpoint",
  c?.url === "https://graph.facebook.com/v23.0/1234567890/messages",
);

check(
  "authenticates with the bearer token",

  (c?.init.headers as Record<string, string>)?.Authorization ===
    "Bearer token-abc",
);

check(
  "sends a template, never free text",

  c?.body.type === "template" && c?.body.messaging_product === "whatsapp",
);

check(
  "drops the plus from the number",

  c?.body.to === "2348051111111",
);

check(
  "names the template and its language",

  c?.body.template?.name === "eeas_alert" &&
    c?.body.template?.language?.code === "en",
);

const params = c?.body.template?.components?.[0]?.parameters ?? [];

check(
  "sends the first named placeholder",

  params[0]?.parameter_name === "alert_title" &&
    params[0]?.text.startsWith("CMP 301"),
);

check(
  "sends the second named placeholder",

  params[1]?.parameter_name === "alert_detail" &&
    params[1]?.text === "Projected 66.5%. Attend 13 of the 17 left.",
);

check(
  "an accepted send is sent and carries Meta's message ID",

  sent.status === "sent" && sent.providerRef === "wamid.TEST",
);

// REFUSAL TEST

reply = {
  status: 400,

  json: {
    error: {
      message: "Recipient phone number not in allowed list",
      code: 131030,
    },
  },
};

const refused = await sendWhatsApp({
  to: "+2348050000001",

  template: "eeas_alert",

  variables: ["a", "b"],

  parameterNames: ["alert_title", "alert_detail"],
});

check(
  "a refusal is failed and keeps Meta's reason",

  refused.status === "failed" && refused.error.includes("not in allowed list"),
);

// NETWORK FAILURE TEST

globalThis.fetch = (async () => {
  throw new Error("getaddrinfo ENOTFOUND");
}) as typeof fetch;

const unreachable = await sendWhatsApp({
  to: "+2348050000001",

  template: "eeas_alert",

  variables: ["a", "b"],

  parameterNames: ["alert_title", "alert_detail"],
});

check(
  "no network is failed, not a crash",

  unreachable.status === "failed",
);

// OTP TEST

globalThis.fetch = (async (url: string, init: RequestInit) => {
  captured = {
    url: String(url),

    init,

    body: JSON.parse(String(init.body)),
  };

  return new Response(
    JSON.stringify({
      messages: [
        {
          id: "wamid.OTP",
        },
      ],
    }),

    {
      status: 200,
    },
  );
}) as typeof fetch;

reply = {
  status: 200,
  json: {},
};

process.env.WHATSAPP_OTP_TEMPLATE = "eeas_otp";

captured = null;

await sendOtp({
  to: "+2348051111111",

  code: "482913",

  channel: "whatsapp",
});

const otp = captured as Captured | null;

const components = otp?.body.template?.components ?? [];

check(
  "OTP remains positional and puts the code in its body",

  components[0]?.parameters?.[0]?.text === "482913" &&
    !components[0]?.parameters?.[0]?.parameter_name,
);

check(
  "OTP code also goes in the copy-code button",

  components[1]?.type === "button" &&
    components[1]?.parameters?.[0]?.text === "482913",
);

// MISSING OTP TEMPLATE TEST

delete process.env.WHATSAPP_OTP_TEMPLATE;

(process.env as Record<string, string>).NODE_ENV = "production";

captured = null;

const noTemplate = await sendOtp({
  to: "+2348051111111",

  code: "482913",

  channel: "whatsapp",
});

check(
  "without an authentication template, OTP is refused",

  noTemplate.status === "failed" && captured === null,
);

// DEMO TEST

process.env.DEMO_DEPLOYMENT = "true";

process.env.PAYSTACK_SECRET_KEY = "sk_test_x";

const demo = await sendOtp({
  to: "+2348051111111",

  code: "482913",

  channel: "whatsapp",
});

check(
  "on a demo deployment the code is shown instead",

  demo.status === "shown",
);

// RESTORE FETCH

globalThis.fetch = realFetch;

// FINAL RESULT

if (failed > 0) {
  console.error(`\n${failed} failed`);

  process.exit(1);
}

console.log("\nall WhatsApp checks pass");
