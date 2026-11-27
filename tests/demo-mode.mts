/**
 * The demo-deployment switch, and the interlock that keeps it off a real launch.
 *
 * Demo mode puts verification codes on the screen. That is right for a project
 * defence and badly wrong anywhere students' accounts are real, so the cases
 * that matter most here are the ones where it must stay OFF.
 *
 *   npm run test:demo
 */

import { isDemoDeployment } from "../src/lib/demo.ts";
import { sendOtp } from "../src/lib/messaging.ts";

let failed = 0;
function check(what: string, passed: boolean) {
  console.log(`${passed ? "ok  " : "FAIL"} — ${what}`);
  if (!passed) failed++;
}

function withEnv(env: Record<string, string | undefined>, run: () => void) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// The interlock logs when it refuses; that line is expected here, not noise.
const quiet = console.error;
console.error = () => {};

withEnv({ DEMO_DEPLOYMENT: undefined, PAYSTACK_SECRET_KEY: "sk_test_abc" }, () =>
  check("off unless asked for", isDemoDeployment() === false),
);
withEnv({ DEMO_DEPLOYMENT: "1", PAYSTACK_SECRET_KEY: "sk_test_abc" }, () =>
  check("only the exact value \"true\" turns it on — not 1, yes or anything truthy", isDemoDeployment() === false),
);
withEnv({ DEMO_DEPLOYMENT: "true", PAYSTACK_SECRET_KEY: "sk_test_abc" }, () =>
  check("on with a Paystack test key", isDemoDeployment() === true),
);
withEnv({ DEMO_DEPLOYMENT: "true", PAYSTACK_SECRET_KEY: undefined }, () =>
  check("on with no Paystack key at all — nothing can take money", isDemoDeployment() === true),
);
withEnv({ DEMO_DEPLOYMENT: "true", PAYSTACK_SECRET_KEY: "sk_live_abc" }, () =>
  check("REFUSES next to a live Paystack key, even when asked for", isDemoDeployment() === false),
);

console.error = quiet;

// --- what sendOtp does with it ---------------------------------------------

const noProviders = {
  SMS_API_KEY: undefined,
  WHATSAPP_API_TOKEN: undefined,
  WHATSAPP_PHONE_NUMBER_ID: undefined,
};

const outcomes: Array<[string, Record<string, string | undefined>, string]> = [
  ["a demo deployment with no SMS provider shows the code", { ...noProviders, DEMO_DEPLOYMENT: "true", PAYSTACK_SECRET_KEY: "sk_test_x", NODE_ENV: "production" }, "shown"],
  ["production without demo mode still refuses rather than pretending", { ...noProviders, DEMO_DEPLOYMENT: undefined, NODE_ENV: "production" }, "failed"],
  ["a live key switches demo mode off, so the code is refused, not shown", { ...noProviders, DEMO_DEPLOYMENT: "true", PAYSTACK_SECRET_KEY: "sk_live_x", NODE_ENV: "production" }, "failed"],
];

console.error = () => {};
for (const [what, env, expected] of outcomes) {
  let result: { status: string; code?: string } | null = null;
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  result = await sendOtp({ to: "+2348050000001", code: "123456", channel: "sms" });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  check(what, result.status === expected && (expected !== "shown" || result.code === "123456"));
}
console.error = quiet;

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall demo-mode checks pass");
