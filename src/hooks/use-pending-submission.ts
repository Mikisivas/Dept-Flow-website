"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

/**
 * The submission state machine for anything the student must not be lied to
 * about — the attendance code above all.
 *
 * There is deliberately no "recorded" state that the client can enter on its
 * own. `confirmed` is reachable only by the server resolving the request. A
 * student who sees "Recorded ✓" and walks away uncounted is the worst failure
 * this system can produce, so the type system refuses to express it. `queued`
 * is not a soft version of confirmed and the copy at every call site has to
 * say so: it means waiting, and waiting means not counted yet.
 *
 * WHAT THE QUEUE BUYS, AND WHAT IT CANNOT
 *
 *   - It retries immediately, with backoff, while the request could still
 *     plausibly go through.
 *   - It persists the attempt to localStorage, so a reload mid-submission
 *     recovers it rather than leaving the student staring at a blank form
 *     with no idea whether it went through.
 *   - It holds the attempt when the network is gone and sends it the moment
 *     the connection returns, carrying the ORIGINAL timestamp so the record
 *     says when the student actually answered rather than when the signal came
 *     back.
 *   - It CANNOT survive the tab closing, and that is a decision rather than a
 *     limitation. A service worker could replay a POST from the background,
 *     but replaying an attendance code minutes later, with nobody watching the
 *     answer, is how a student ends up believing they are counted when the
 *     window closed while their phone was in a pocket. The queue lives where
 *     the result can be read.
 *
 * So a failure is loud and immediate, while the student is still in the hall
 * and can retry or tell the lecturer.
 */

export type SubmissionState =
  | { status: "idle" }
  | { status: "sending"; attempt: number }
  /** Held, waiting for a connection. NOT recorded — the copy must say so. */
  | { status: "queued"; since: string }
  | { status: "confirmed"; result: unknown }
  | { status: "failed"; reason: string; retryable: boolean };

const STORAGE_PREFIX = "dept-flow:pending:";
const MAX_ATTEMPTS = 4;

/**
 * How long a queued submission stays worth sending.
 *
 * A code window is minutes. Half an hour covers a lecture and a walk out of a
 * dead corner of the Maths block; beyond that the code is long gone, and
 * replaying it on the student's next visit would produce an alarming "this
 * code has expired" about a lecture they have stopped thinking about.
 */
const QUEUE_TTL_MS = 30 * 60 * 1000;

type PendingRecord = {
  payload: unknown;
  /** When the student actually pressed Submit. Replayed verbatim. */
  submittedAt: string;
  startedAt: number;
};

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
  /**
   * `submittedAt` is the moment the student pressed Submit, not the moment of
   * this attempt. Pass it to the server: a replayed submission that stamped
   * itself on arrival would record a student as answering at the time their
   * signal came back.
   */
  submit: (payload: TPayload, submittedAt: string) => Promise<TResult>;
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

  // Parsing only. Whether a record is still worth SENDING depends on the clock,
  // which makes it a question for the moment of sending rather than for a
  // render — a memo that reads Date.now() returns a different answer on every
  // render for the same input, which is the definition of not being a memo.
  const pending = useMemo<PendingRecord | null>(() => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PendingRecord;
    } catch {
      return null;
    }
  }, [raw]);

  const recovered = (pending?.payload ?? null) as TPayload | null;

  const clearPending = useCallback(() => {
    if (typeof window !== "undefined") window.localStorage.removeItem(storageKey);
    notifyPendingChanged();
  }, [storageKey]);

  /**
   * One pass at the server, with backoff between attempts.
   *
   * Separated from `send` so a reconnect can drive it without re-stamping the
   * submission: `attempt` is about this burst, `submittedAt` is about the
   * student.
   */
  const attemptDelivery = useCallback(
    async (payload: TPayload, submittedAt: string) => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (cancelled.current) return;
        setState({ status: "sending", attempt });

        try {
          const result = await submit(payload, submittedAt);
          if (cancelled.current) return;
          clearPending();
          setState({ status: "confirmed", result });
          return result;
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Something went wrong.";

          // A rejected token, a locked account or an unregistered student are
          // answers, not failures. Retrying them wastes the student's window,
          // and queueing them for a reconnect would mean asking the same
          // question again tomorrow and getting the same answer.
          if (!isRetryable(error)) {
            clearPending();
            if (!cancelled.current) setState({ status: "failed", reason, retryable: false });
            return;
          }

          if (attempt === maxAttempts) {
            if (cancelled.current) return;

            // Offline is a wait, not a failure. The record stays, the online
            // listener below picks it up, and the student is told plainly that
            // nothing has been recorded yet.
            if (typeof navigator !== "undefined" && navigator.onLine === false) {
              setState({ status: "queued", since: submittedAt });
              return;
            }

            setState({ status: "failed", reason, retryable: true });
            return;
          }

          await delay(2 ** (attempt - 1) * 500);
        }
      }
    },
    [clearPending, maxAttempts, submit],
  );

  const send = useCallback(
    async (payload: TPayload) => {
      const submittedAt = new Date().toISOString();

      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({ payload, submittedAt, startedAt: Date.now() } satisfies PendingRecord),
        );
        notifyPendingChanged();
      }

      return attemptDelivery(payload, submittedAt);
    },
    [attemptDelivery, storageKey],
  );

  /**
   * The connection coming back.
   *
   * The listener is registered whatever the state, because a submission can be
   * queued by one attempt and the network can return while the student is
   * still reading the message about it. Guarded on the stored record rather
   * than on the state so that a reload mid-queue reconnects the same way.
   */
  const inFlight = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;

    const retry = () => {
      if (inFlight.current) return;

      const stored = window.localStorage.getItem(storageKey);
      if (!stored) return;

      let record: PendingRecord;
      try {
        record = JSON.parse(stored) as PendingRecord;
      } catch {
        return;
      }

      if (Date.now() - record.startedAt > QUEUE_TTL_MS) {
        // Too old to be worth sending. Cleared rather than replayed: the
        // lecture is over, and an expired-code alert on a later visit would
        // be the system raising a question the student cannot answer.
        window.localStorage.removeItem(storageKey);
        notifyPendingChanged();
        return;
      }

      inFlight.current = true;
      void attemptDelivery(record.payload as TPayload, record.submittedAt).finally(() => {
        inFlight.current = false;
      });
    };

    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [attemptDelivery, storageKey]);

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
    /** Held for a connection. Also never "Recorded". */
    isQueued: state.status === "queued",
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
