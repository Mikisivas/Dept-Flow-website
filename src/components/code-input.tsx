"use client";

import { useId, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * The 4-digit checkpoint token and the 6-digit OTP, in one control.
 *
 * This is the highest-frequency, most time-pressured interaction in the
 * product: a noisy hall, a 3–5 minute window, a student holding a phone
 * one-handed. Every rule below exists because breaking it costs a student
 * their attendance.
 *
 *   - Paste is never blocked. A student pasting an OTP from their SMS app is
 *     the normal case, not an attack.
 *   - inputmode="numeric" so the numeric keypad opens, not the full keyboard.
 *   - autocomplete="one-time-code" so iOS offers the code from the SMS.
 *   - spellcheck off; autocorrect off. Nothing here is a word.
 *   - No autoFocus on mobile — it pops the keyboard and shifts the layout out
 *     from under the student's thumb.
 */

export function CodeInput({
  length,
  value,
  onChange,
  onComplete,
  label,
  disabled,
  autoComplete = "one-time-code",
  className,
}: {
  length: 4 | 6;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  /** Read to screen readers in place of six unlabelled boxes. */
  label: string;
  disabled?: boolean;
  autoComplete?: "one-time-code" | "off";
  className?: string;
}) {
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);
  const groupId = useId();

  const digits = value.padEnd(length, " ").slice(0, length).split("");

  /**
   * Completion is reported from the event that caused it, not from an effect
   * watching the value. An effect would fire again on any re-render that
   * happens to leave the code complete — submitting the same token twice.
   */
  function commit(next: string) {
    onChange(next);
    if (next.length === length) onComplete?.(next);
  }

  function handleChange(index: number, raw: string) {
    const digitsOnly = raw.replace(/\D/g, "");
    if (!digitsOnly) return;

    // A paste of the whole code lands in one box — spread it across the rest
    // rather than taking the first character and dropping the remainder.
    if (digitsOnly.length > 1) {
      const merged = (value.slice(0, index) + digitsOnly).slice(0, length);
      commit(merged);
      inputsRef.current[Math.min(merged.length, length - 1)]?.focus();
      return;
    }

    const next = value.padEnd(index, " ").split("");
    next[index] = digitsOnly;
    commit(next.join("").trimEnd());
    if (index < length - 1) inputsRef.current[index + 1]?.focus();
  }

  function handleKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace") {
      event.preventDefault();
      if (value[index]) {
        commit(value.slice(0, index) + value.slice(index + 1));
      } else if (index > 0) {
        commit(value.slice(0, index - 1));
        inputsRef.current[index - 1]?.focus();
      }
      return;
    }

    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      inputsRef.current[index - 1]?.focus();
    }

    if (event.key === "ArrowRight" && index < length - 1) {
      event.preventDefault();
      inputsRef.current[index + 1]?.focus();
    }
  }

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex justify-center gap-2 sm:gap-3", className)}
    >
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(node) => {
            inputsRef.current[index] = node;
          }}
          id={`${groupId}-${index}`}
          aria-label={`${label}, digit ${index + 1} of ${length}`}
          value={digit.trim()}
          onChange={(event) => handleChange(index, event.target.value)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          onFocus={(event) => event.target.select()}
          disabled={disabled}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={index === 0 ? autoComplete : "off"}
          spellCheck={false}
          autoCorrect="off"
          maxLength={length}
          className={cn(
            "h-16 w-12 rounded-lg border text-center text-[28px] font-semibold text-ink sm:h-18 sm:w-14",
            "border-line bg-surface tabular",
            "focus-visible:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]",
            "disabled:opacity-50",
          )}
        />
      ))}
    </div>
  );
}
