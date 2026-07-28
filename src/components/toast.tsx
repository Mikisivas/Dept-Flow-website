"use client";

import * as React from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { CheckCircle2, Loader2, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Success, pending and failure notices, announced politely.
 *
 * Never used for a login failure or a rejected token — those belong inline,
 * next to the thing that failed, where the student is already looking. A toast
 * that carries the only copy of "that code isn't right" will be missed in a
 * noisy hall.
 */

type ToastTone = "success" | "pending" | "error";

type ToastPayload = {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  /** Pending toasts stay until dismissed or replaced. */
  duration?: number;
};

type ToastContextValue = {
  toast: (payload: Omit<ToastPayload, "id">) => number;
  dismiss: (id: number) => void;
};

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = React.useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside <ToastProvider>");
  return context;
}

const TONES: Record<ToastTone, { Icon: typeof CheckCircle2; className: string }> = {
  success: { Icon: CheckCircle2, className: "text-ok" },
  pending: { Icon: Loader2, className: "text-info" },
  error: { Icon: TriangleAlert, className: "text-danger" },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastPayload[]>([]);
  const nextId = React.useRef(0);

  const dismiss = React.useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = React.useCallback((payload: Omit<ToastPayload, "id">) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { ...payload, id }]);
    return id;
  }, []);

  const value = React.useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="right">
        {children}

        {toasts.map(({ id, tone, title, body, action, duration }) => {
          const { Icon, className } = TONES[tone];
          return (
            <ToastPrimitive.Root
              key={id}
              duration={duration ?? (tone === "pending" ? Infinity : 6000)}
              onOpenChange={(open) => !open && dismiss(id)}
              className={cn(
                "flex items-start gap-3 rounded-lg border border-line bg-surface p-4 shadow-lg",
                "data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-2",
              )}
            >
              <Icon
                className={cn(
                  "mt-0.5 h-5 w-5 shrink-0",
                  className,
                  tone === "pending" && "motion-safe:animate-spin",
                )}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <ToastPrimitive.Title className="text-[15px] font-semibold text-ink">
                  {title}
                </ToastPrimitive.Title>
                {body ? (
                  <ToastPrimitive.Description className="mt-0.5 text-[14px] leading-relaxed text-slate">
                    {body}
                  </ToastPrimitive.Description>
                ) : null}
                {action ? (
                  <ToastPrimitive.Action asChild altText={action.label}>
                    <Button variant="secondary" className="mt-2 h-9" onClick={action.onClick}>
                      {action.label}
                    </Button>
                  </ToastPrimitive.Action>
                ) : null}
              </div>
              <ToastPrimitive.Close
                className="-m-1 shrink-0 rounded p-1 text-muted hover:text-ink"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          );
        })}

        <ToastPrimitive.Viewport
          className={cn(
            "fixed z-60 flex w-full flex-col gap-2 p-4 outline-none",
            // Above the student bottom bar, and clear of the home indicator.
            "bottom-[calc(4rem+env(safe-area-inset-bottom))] sm:right-0 sm:bottom-0 sm:max-w-sm",
          )}
        />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
