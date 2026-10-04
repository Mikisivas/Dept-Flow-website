/**
 * A verification code shown on screen, on a demo deployment only.
 *
 * The server sends `demoCode` only when `DEMO_DEPLOYMENT` is on and no SMS
 * provider is connected (`src/lib/demo.ts`). It says in words that this is a
 * demonstration and where the code would really go, so a panel watching the
 * screen is never led to think a text message was sent.
 *
 * Dashed and uncoloured, like every other "this is not the real thing" state in
 * the product: it is not a status, and it must not look like one.
 */
export function DemoCode({ code, destination }: { code: string; destination: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate px-4 py-3 text-center">
      <p className="text-[13px] font-semibold tracking-[0.06em] text-muted uppercase">
        Demonstration deployment
      </p>
      <p className="mt-1 text-[14px] leading-relaxed text-slate">
        No SMS is sent here. On a live system this code would arrive by text at {destination}.
      </p>
      <p className="mt-2 font-mono text-[26px] font-semibold tracking-[0.3em] text-ink tabular" translate="no">
        {code}
      </p>
    </div>
  );
}
