"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * Creates the lecture row, then goes to it.
 *
 * A timetable slot has no `session_instances` row until a lecturer says the
 * class is happening, so this cannot be a link — there is nothing to link to
 * yet. It stays disabled while the request is in flight, because two lectures
 * on the same day would each carry half the hall's attendance.
 */
export function StartSessionButton({ timetableEntryId }: { timetableEntryId: string }) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setStarting(true);
    setError(null);

    try {
      const response = await fetch("/api/lecturer/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timetableEntryId }),
      });
      const body = await response.json();

      if (!response.ok || !body.sessionInstanceId) {
        setError(body.error ?? "Couldn't start the session.");
        setStarting(false);
        return;
      }

      router.push(`/lecturer/session/${body.sessionInstanceId}`);
    } catch {
      setError("No connection. Try again.");
      setStarting(false);
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        className="mt-3 w-full"
        onClick={start}
        aria-disabled={starting}
      >
        {starting ? "Starting…" : "Start session"}
      </Button>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}
