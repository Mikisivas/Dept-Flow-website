"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Users } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { CourseChoice, MessageScope, SentMessage } from "@/lib/data/hod";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * One message, three audiences.
 *
 * The number that matters on this screen is not the message, it is how many
 * phones it reaches — "message 412 students" is a different decision from
 * "message 12", and an HOD should be making the one they think they are
 * making. So the audience count is fetched live as the scope changes, shown
 * beside the picker, and repeated inside the confirmation.
 *
 * The messages reach students the same way an attendance warning does, on the
 * same channels, with the same delivery record. That is deliberate and is
 * stated on the screen: an HOD choosing to message a whole level should know
 * it is going to arrive on WhatsApp, not sit in an inbox nobody opens.
 */

const SCOPES: Array<{ value: MessageScope; label: string; detail: string }> = [
  { value: "student", label: "One student", detail: "By matric number." },
  { value: "course", label: "A course group", detail: "Everyone currently registered for it." },
  { value: "level", label: "A whole level", detail: "Every active student at that level." },
];

export function MessageComposer({
  courses,
  sent,
}: {
  courses: CourseChoice[];
  sent: SentMessage[];
}) {
  const router = useRouter();
  const [scope, setScope] = useState<MessageScope>("student");
  const [matricNo, setMatricNo] = useState("");
  const [courseId, setCourseId] = useState(courses[0]?.courseId ?? "");
  const [level, setLevel] = useState("300");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  /**
   * The server's answer, tagged with the question it answered.
   *
   * Held with its key rather than as a bare number so a stale reply cannot be
   * shown against a scope it was not counted for — switching from a course to
   * a level must not flash the course's count beside "Level 300", because the
   * number on this screen is the number of phones about to ring.
   */
  const [counted, setCounted] = useState<{ key: string; count: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // What the count is being asked for. Also the guard against a slow reply
  // landing after the HOD has moved on to a different audience.
  const audienceKey = scope === "course" ? `course:${courseId}` : `level:${level}`;

  /**
   * Asked of the server whenever the audience could have changed.
   *
   * Counted in the browser it would be a guess: enrolments change, students
   * are deactivated, and the number on the confirmation has to be the number
   * that will actually be messaged.
   */
  useEffect(() => {
    // An individual message is one student by definition — derived below
    // rather than asked, since asking would mean a round trip on every
    // keystroke of a matric number.
    if (scope === "student") return;

    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/hod/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "audience",
            scope,
            courseId,
            level: Number(level),
          }),
        });
        const payload = await response.json();
        if (cancelled || !response.ok) return;
        setCounted({ key: audienceKey, count: Number(payload.recipients ?? 0) });
      } catch {
        // Left as it was: a count that has gone stale is caught by the key,
        // and blanking it here would only replace a number with nothing.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [scope, courseId, level, audienceKey]);

  const audience =
    scope === "student"
      ? matricNo.trim()
        ? 1
        : null
      : counted?.key === audienceKey
        ? counted.count
        : null;

  async function send(): Promise<void> {
    setWorking(true);
    setError(null);

    try {
      const response = await fetch("/api/hod/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, matricNo: matricNo.trim(), courseId, level: Number(level), subject, body }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "That didn't send.");
        setWorking(false);
        setConfirming(false);
        return;
      }

      setResult(
        `Sent to ${payload.recipients} ${payload.recipients === 1 ? "student" : "students"}.`,
      );
      setSubject("");
      setBody("");
      router.refresh();
    } catch {
      setError("No connection. Nothing was sent.");
    }

    setWorking(false);
    setConfirming(false);
  }

  const chosenCourse = courses.find((course) => course.courseId === courseId);
  const audienceLabel =
    scope === "student"
      ? matricNo.trim() || "one student"
      : scope === "course"
        ? (chosenCourse?.code ?? "a course")
        : `Level ${level}`;

  const ready =
    subject.trim().length > 0 &&
    body.trim().length >= 10 &&
    (scope !== "student" || matricNo.trim().length > 0) &&
    (scope !== "course" || Boolean(courseId));

  return (
    <div className="flex flex-col gap-6">
      <fieldset>
        <legend className="text-[13px] font-semibold text-slate">Who is this for?</legend>
        <div className="mt-3 flex flex-col gap-2">
          {SCOPES.map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-4",
                scope === option.value
                  ? "border-2 border-brand bg-brand-tint"
                  : "border border-line bg-surface",
              )}
            >
              <input
                type="radio"
                name="scope"
                checked={scope === option.value}
                onChange={() => setScope(option.value)}
                className="mt-0.5 h-4.5 w-4.5 accent-[var(--brand)]"
              />
              <span>
                <span className="block text-[15px] text-ink">{option.label}</span>
                <span className="block text-[13px] text-muted">{option.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {scope === "student" ? (
        <Field label="Matric number" htmlFor="matric" hint="Nobody else will receive it.">
          <Input
            id="matric"
            value={matricNo}
            onChange={(event) => setMatricNo(event.target.value.toUpperCase())}
            placeholder="CMP/2021/047"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
        </Field>
      ) : null}

      {scope === "course" ? (
        <Field label="Course" htmlFor="course">
          <select
            id="course"
            value={courseId}
            onChange={(event) => setCourseId(event.target.value)}
            className="h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
          >
            {courses.map((course) => (
              <option key={course.courseId} value={course.courseId}>
                {course.code} — {course.title}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {scope === "level" ? (
        <Field label="Level" htmlFor="level">
          <select
            id="level"
            value={level}
            onChange={(event) => setLevel(event.target.value)}
            className="h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
          >
            {["100", "200", "300", "400"].map((value) => (
              <option key={value} value={value}>
                {value} level
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {/* Before the message box, not after it. The size of the audience should
          shape what gets written, not be discovered once it has been. */}
      <p className="flex items-center gap-2 rounded-lg border border-dashed border-cell-provisional p-4 text-[15px] text-slate">
        <Users className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
        <span>
          {audience === null ? (
            "Choose an audience."
          ) : (
            <>
              This will reach{" "}
              <strong className="font-semibold text-ink tabular">
                {audience} {audience === 1 ? "student" : "students"}
              </strong>{" "}
              — in the app and on WhatsApp, the same way an attendance warning does.
            </>
          )}
        </span>
      </p>

      <Field label="Subject" htmlFor="subject">
        <Input
          id="subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="CMP 301 venue change"
        />
      </Field>

      <Field
        label="Message"
        htmlFor="body"
        hint="It arrives as a notification and a WhatsApp message. Say the whole thing here."
      >
        <textarea
          id="body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={5}
          className="w-full rounded-md border border-line bg-surface p-3 text-base leading-relaxed text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
        />
      </Field>

      <div aria-live="polite">
        {error ? (
          <p role="alert" className="rounded-lg border border-danger bg-danger-tint p-4 text-[15px] text-ink">
            {error}
          </p>
        ) : null}
        {result ? (
          <p className="rounded-lg border border-ok bg-ok-tint p-4 text-[15px] text-ink">{result}</p>
        ) : null}
      </div>

      <Button size="lg" onClick={() => setConfirming(true)} aria-disabled={!ready || working}>
        <Send className="h-4 w-4" aria-hidden="true" />
        {working ? "Sending…" : "Send message"}
      </Button>

      {sent.length > 0 ? (
        <section aria-labelledby="sent-heading" className="mt-4">
          <h2 id="sent-heading" className="text-[13px] font-semibold text-slate">
            Recently sent
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {sent.map((message) => (
              <li key={message.id} className="rounded-lg border border-line bg-surface p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[15px] font-semibold text-ink">{message.subject}</p>
                  <p className="text-[13px] text-muted tabular">
                    {message.recipients} · {formatDateTime(message.sentAt)}
                  </p>
                </div>
                <p className="mt-1 text-[13px] text-muted">To {message.audience}</p>
                <p className="mt-1.5 text-[14px] leading-relaxed text-slate">{message.body}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={
          (audience ?? 0) > 1
            ? `Send this to ${audience} students?`
            : "Send this message?"
        }
        description={
          <>
            It arrives as a notification and a WhatsApp message. There is no way to unsend it, and
            the department will see who sent it and to whom.
          </>
        }
        impact={[
          { label: "Audience", value: audienceLabel },
          { label: "Students", value: String(audience ?? 0) },
          { label: "Subject", value: subject || "—" },
        ]}
        confirmLabel="Send"
        working={working}
        onConfirm={send}
      />
    </div>
  );
}
