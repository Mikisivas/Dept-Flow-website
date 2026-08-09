"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import type { LecturerCourse, LecturerVenue, ScheduledSession } from "@/lib/data/lecturer";
import { formatDateShort, formatWeekday } from "@/lib/format";
import { CalendarOff } from "lucide-react";

const TYPE_LABEL: Record<ScheduledSession["type"], string | null> = {
  recurring: null,
  makeup: "Makeup class",
  reschedule: "Rescheduled",
};

const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]";

export function ScheduleList({
  sessions,
  courses,
  venues,
}: {
  sessions: ScheduledSession[];
  courses: LecturerCourse[];
  venues: LecturerVenue[];
}) {
  const router = useRouter();
  const [cancelling, setCancelling] = useState<ScheduledSession | null>(null);
  const [moving, setMoving] = useState<ScheduledSession | null>(null);
  const [addingMakeup, setAddingMakeup] = useState(false);
  const [movedTo, setMovedTo] = useState({ heldOn: "", startsAt: "", endsAt: "", venueId: "" });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [makeup, setMakeup] = useState({
    courseId: courses[0]?.courseId ?? "",
    heldOn: "",
    startsAt: "15:00",
    endsAt: "17:00",
    venueId: venues[0]?.id ?? "",
  });

  async function send(payload: Record<string, unknown>) {
    setWorking(true);
    setError(null);

    try {
      const response = await fetch("/api/lecturer/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();

      if (!response.ok) {
        setError(result.error ?? "That did not go through. Try again.");
        return false;
      }

      router.refresh();
      return true;
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
      return false;
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      {sessions.length === 0 ? (
        <EmptyState
          icon={CalendarOff}
          headline="Nothing scheduled in the next three weeks"
          body="Lectures appear here from your timetable. A makeup class can be added below."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((session) => {
            const cancelled = session.status === "cancelled";
            const held = session.status === "closed";

            return (
              <li
                key={`${session.courseId}-${session.heldOn}-${session.startsAt}`}
                className={`rounded-lg border p-4 ${
                  cancelled ? "border-dashed border-line bg-surface-sunken" : "border-line bg-surface"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold text-ink" translate="no">
                      {session.courseCode}
                    </p>
                    <p className="mt-0.5 text-[13px] text-slate tabular">
                      {formatWeekday(session.heldOn)}, {formatDateShort(session.heldOn)} ·{" "}
                      {session.startsAt}–{session.endsAt}
                    </p>
                    <p className="text-[13px] text-muted">{session.venue}</p>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {/* Never colour alone: a cancelled lecture says so in
                        words, and the dashed border repeats it. */}
                    {cancelled ? (
                      <span className="rounded-full border border-dashed border-line px-2 py-0.5 text-[12px] text-slate">
                        Cancelled
                      </span>
                    ) : held ? (
                      <span className="rounded-full border border-line px-2 py-0.5 text-[12px] text-slate">
                        Held
                      </span>
                    ) : null}
                    {TYPE_LABEL[session.type] ? (
                      <span className="rounded-full border border-line px-2 py-0.5 text-[12px] text-slate">
                        {TYPE_LABEL[session.type]}
                      </span>
                    ) : null}
                  </div>
                </div>

                {cancelled && session.cancellationReason ? (
                  <p className="mt-2 text-[13px] leading-relaxed text-slate">
                    {session.cancellationReason}
                  </p>
                ) : null}

                {!cancelled && !held ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      className="h-10"
                      onClick={() => {
                        setMoving(session);
                        setMovedTo({
                          heldOn: "",
                          startsAt: session.startsAt,
                          endsAt: session.endsAt,
                          venueId: venues.find((v) => v.name === session.venue)?.id ?? venues[0]?.id ?? "",
                        });
                      }}
                    >
                      Reschedule
                    </Button>
                    <Button variant="ghost" className="h-10" onClick={() => setCancelling(session)}>
                      Cancel
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <Button
        variant="secondary"
        size="lg"
        className="mt-4 w-full"
        onClick={() => setAddingMakeup(true)}
      >
        <CalendarPlus className="h-4.5 w-4.5" aria-hidden="true" />
        Add a makeup class
      </Button>

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCancelling(null);
            setError(null);
          }
        }}
        title={
          cancelling
            ? `Cancel ${cancelling.courseCode} on ${formatWeekday(cancelling.heldOn)}?`
            : ""
        }
        description={
          <>
            {/* The consequence, stated plainly. A cancelled lecture never
                enters the denominator, so it cannot count against anyone — but
                it also cannot be attended. */}
            This session won&apos;t count toward anyone&apos;s total, and every enrolled student is
            notified straight away.
          </>
        }
        impact={
          cancelling
            ? [
                { label: "Course", value: cancelling.courseCode },
                { label: "Date", value: formatDateShort(cancelling.heldOn) },
                { label: "Venue", value: cancelling.venue },
              ]
            : undefined
        }
        error={error}
        working={working}
        reasonLabel="Why is it cancelled?"
        reasonHint="Students see this in their notification, so write it for them."
        confirmLabel="Cancel session"
        variant="destructive"
        onConfirm={async (reason) => {
          if (!cancelling) return;
          const ok = await send({
            action: "cancel",
            courseId: cancelling.courseId,
            timetableEntryId: cancelling.timetableEntryId,
            heldOn: cancelling.heldOn,
            reason,
          });
          if (ok) setCancelling(null);
        }}
      />

      <ConfirmDialog
        open={moving !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMoving(null);
            setError(null);
          }
        }}
        title={moving ? `Move ${moving.courseCode} from ${formatDateShort(moving.heldOn)}?` : ""}
        description={
          <>
            The old slot is cancelled and the new one takes its place. Students get{" "}
            <strong className="font-semibold text-ink">one</strong> notification saying it moved,
            not a cancellation followed by an addition.
          </>
        }
        extra={
          <div className="flex flex-col gap-3">
            <Field label="New date" htmlFor="move-date">
              <input
                id="move-date"
                type="date"
                className={inputClass}
                value={movedTo.heldOn}
                min={new Date().toISOString().slice(0, 10)}
                onChange={(event) => setMovedTo({ ...movedTo, heldOn: event.target.value })}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Starts" htmlFor="move-start">
                <input
                  id="move-start"
                  type="time"
                  className={inputClass}
                  value={movedTo.startsAt}
                  onChange={(event) => setMovedTo({ ...movedTo, startsAt: event.target.value })}
                />
              </Field>
              <Field label="Ends" htmlFor="move-end">
                <input
                  id="move-end"
                  type="time"
                  className={inputClass}
                  value={movedTo.endsAt}
                  onChange={(event) => setMovedTo({ ...movedTo, endsAt: event.target.value })}
                />
              </Field>
            </div>

            <Field label="Venue" htmlFor="move-venue">
              <select
                id="move-venue"
                className={inputClass}
                value={movedTo.venueId}
                onChange={(event) => setMovedTo({ ...movedTo, venueId: event.target.value })}
              >
                {venues.map((venue) => (
                  <option key={venue.id} value={venue.id}>
                    {venue.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        }
        error={error}
        working={working}
        reasonLabel="Why is it moving?"
        reasonHint="Students see this in their notification, so write it for them."
        confirmLabel="Move session"
        onConfirm={async (reason) => {
          if (!moving) return;
          if (!movedTo.heldOn) {
            setError("Pick the new date.");
            return;
          }
          const ok = await send({
            action: "reschedule",
            courseId: moving.courseId,
            timetableEntryId: moving.timetableEntryId,
            heldOn: moving.heldOn,
            movedTo: movedTo.heldOn,
            startsAt: movedTo.startsAt,
            endsAt: movedTo.endsAt,
            venueId: movedTo.venueId,
            reason,
          });
          if (ok) setMoving(null);
        }}
      />

      <ConfirmDialog
        open={addingMakeup}
        onOpenChange={(open) => {
          setAddingMakeup(open);
          if (!open) setError(null);
        }}
        title="Add a makeup class"
        description={
          <>
            A makeup counts exactly like a timetabled lecture — students attend it the same way and
            it enters the denominator once you close it. Everyone enrolled is notified.
          </>
        }
        extra={
          <div className="flex flex-col gap-3">
            <Field label="Course" htmlFor="makeup-course">
              <select
                id="makeup-course"
                className={inputClass}
                value={makeup.courseId}
                onChange={(event) => setMakeup({ ...makeup, courseId: event.target.value })}
              >
                {courses.map((course) => (
                  <option key={course.courseId} value={course.courseId}>
                    {course.code} — {course.title}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Date" htmlFor="makeup-date">
              <input
                id="makeup-date"
                type="date"
                className={inputClass}
                value={makeup.heldOn}
                min={new Date().toISOString().slice(0, 10)}
                onChange={(event) => setMakeup({ ...makeup, heldOn: event.target.value })}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Starts" htmlFor="makeup-start">
                <input
                  id="makeup-start"
                  type="time"
                  className={inputClass}
                  value={makeup.startsAt}
                  onChange={(event) => setMakeup({ ...makeup, startsAt: event.target.value })}
                />
              </Field>
              <Field label="Ends" htmlFor="makeup-end">
                <input
                  id="makeup-end"
                  type="time"
                  className={inputClass}
                  value={makeup.endsAt}
                  onChange={(event) => setMakeup({ ...makeup, endsAt: event.target.value })}
                />
              </Field>
            </div>

            <Field
              label="Venue"
              htmlFor="makeup-venue"
              hint="The geo-fence comes from the venue, so this decides where students must be."
            >
              <select
                id="makeup-venue"
                className={inputClass}
                value={makeup.venueId}
                onChange={(event) => setMakeup({ ...makeup, venueId: event.target.value })}
              >
                {venues.map((venue) => (
                  <option key={venue.id} value={venue.id}>
                    {venue.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        }
        error={error}
        working={working}
        reasonLabel="Note for students"
        reasonHint="Optional. Shown in the notification alongside the date and time."
        requireReason={false}
        confirmLabel="Schedule makeup class"
        onConfirm={async (note) => {
          if (!makeup.heldOn) {
            setError("Pick a date for the makeup class.");
            return;
          }
          const ok = await send({ action: "makeup", ...makeup, reason: note });
          if (ok) {
            setAddingMakeup(false);
            setMakeup({ ...makeup, heldOn: "" });
          }
        }}
      />
    </>
  );
}
