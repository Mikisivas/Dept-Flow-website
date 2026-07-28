"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

/**
 * The submission state machine for anything the student must not be lied to
 * about — a checkpoint token above all.
 *
 * There is deliberately no "recorded" state that the client can enter on its
 * own. `confirmed` is reachable only by the server resolving the request. A
 * student who sees "Recorded ✓" and walks away uncounted is the worst failure
 * this system can produce, so the type system refuses to express it.
 *
 * What this buys, and what it cannot:
 *
 *   - It retries while the page is open, with backoff.
 *   - It persists the attempt to localStorage, so a reload mid-submission
 *     recovers it.
 *   - It CANNOT survive the tab closing. Without a service worker there is no
 *     background sync, and this is a website by design. So a failure is loud
 *     and immediate, while the student is still in the hall and can retry or
 *     tell the lecturer.
 */

export type SubmissionState =
  | { status: "idle" }
  | { status: "sending"; attempt: number }
  | { status: "confirmed"; result: unknown }
  | { status: "failed"; reason: string; retryable: boolean };

const STORAGE_PREFIX = "dept-flow:pending:";
const MAX_ATTEMPTS = 4;

type PendingRecord = { payload: unknown; startedAt: number };

/**
 * localStorage is an external store, so it is read as one. Reading it in an
 * effect and copying it into state renders once with the wrong answer first,
 * and gets the server render wrong too.
 */
const listeners = new Set<() => void>();

function notifyPendingChanged() {
  listeners.forEach((listener) => listener());
}

function subscribeToPending(listener: () => void) {
  listeners.add(listener);
  // Another tab clearing the same submission counts as a change here.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function usePendingSubmission<TPayload, TResult>({
  key,
  submit,
  maxAttempts = MAX_ATTEMPTS,
}: {
  /** Identifies the attempt across a reload — e.g. `checkpoint:<id>`. */
  key: string;
  submit: (payload: TPayload) => Promise<TResult>;
  maxAttempts?: number;
}) {
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const cancelled = useRef(false);

  const storageKey = `${STORAGE_PREFIX}${key}`;

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  // A reload while a submission was in flight leaves the student staring at a
  // fresh form with no idea whether it went through. Surface it instead.
  const raw = useSyncExternalStore(
    subscribeToPending,
    useCallback(() => window.localStorage.getItem(storageKey), [storageKey]),
    () => null,
  );

  const recovered = useMemo<TPayload | null>(() => {
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as PendingRecord).payload as TPayload;
    } catch {
      return null;
    }
  }, [raw]);

  const clearPending = useCallback(() => {
    if (typeof window !== "undefined") window.localStorage.removeItem(storageKey);
    notifyPendingChanged();
  }, [storageKey]);

  const send = useCallback(
    async (payload: TPayload) => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({ payload, startedAt: Date.now() } satisfies PendingRecord),
        );
        notifyPendingChanged();
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (cancelled.current) return;
        setState({ status: "sending", attempt });

        try {
          const result = await submit(payload);
          if (cancelled.current) return;
          clearPending();
          setState({ status: "confirmed", result });
          return result;
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Something went wrong.";
          const retryable = isRetryable(error);

          // A rejected token, a locked account or a failed geo-fence check are
          // answers, not failures. Retrying them wastes the student's window.
          if (!retryable) {
            clearPending();
            if (!cancelled.current) setState({ status: "failed", reason, retryable: false });
            return;
          }

          if (attempt === maxAttempts) {
            if (!cancelled.current) setState({ status: "failed", reason, retryable: true });
            return;
          }

          await delay(2 ** (attempt - 1) * 500);
        }
      }
    },
    [clearPending, maxAttempts, storageKey, submit],
  );

  const reset = useCallback(() => {
    clearPending();
    setState({ status: "idle" });
  }, [clearPending]);

  return {
    state,
    /** A submission that was in flight when the page reloaded. */
    recovered,
    send,
    reset,
    dismissRecovered: clearPending,
    /** "Sending…" — never "Recorded" — until the server has answered. */
    isSending: state.status === "sending",
  };
}

/** Anything the server answered definitively is not worth retrying. */
export class SubmissionRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionRejected";
  }
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof SubmissionRejected);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
