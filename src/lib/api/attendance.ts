import type { CheckpointOutcome, SubmitRejection } from "@/lib/types";

/**
 * The browser's side of a checkpoint submission.
 *
 * The distinction this file exists to make: a *rejection* is the server having
 * decided, and a *failure* is the server not having answered. Retrying the
 * first wastes a token window the student has minutes of; retrying the second
 * is the only thing that can help. They arrive as different shapes and are
 * thrown as different things.
 */

/** A definitive answer from the server. Retrying it changes nothing. */
export class RejectedSubmission extends Error {
  constructor(public readonly reason: SubmitRejection) {
    super(reason);
    this.name = "RejectedSubmission";
  }
}

export async function submitCheckpoint(payload: {
  checkpointId: string;
  token: string;
  coords: { latitude: number; longitude: number; accuracy: number };
}): Promise<CheckpointOutcome> {
  const response = await fetch("/api/attendance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // Anything that is not a decision is a failure, including a 503 and a body
  // that will not parse. The student is never told they were recorded on the
  // strength of a response we could not read.
  let body: { recorded?: CheckpointOutcome; rejected?: SubmitRejection; error?: string };
  try {
    body = await response.json();
  } catch {
    throw new Error("The server didn't answer.");
  }

  if (body.rejected) throw new RejectedSubmission(body.rejected);
  if (!response.ok || !body.recorded) throw new Error(body.error ?? "The submission failed.");

  return body.recorded;
}
