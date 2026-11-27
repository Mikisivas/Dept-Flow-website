"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Radix Dialog supplies the focus trap, escape handling and ARIA wiring — none
 * of it hand-written.
 *
 * On mobile the content docks to the bottom as a sheet, because a centred
 * modal on a phone puts the confirm button under the thumb's reach and over
 * the keyboard.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { showClose?: boolean }
>(({ className, children, showClose = true, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-black/45",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0",
      )}
    />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed z-50 flex flex-col bg-surface text-ink shadow-xl",
        // Phone: bottom sheet, contained overscroll so a scroll inside it
        // never drags the page behind.
        "inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t border-line",
        "[overscroll-behavior:contain] pb-[max(1rem,env(safe-area-inset-bottom))]",
        // Desktop: centred.
        "sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-full sm:max-w-lg",
        "sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:border",
        className,
      )}
      {...props}
    >
      {children}
      {showClose ? (
        <DialogPrimitive.Close
          className={cn(
            "absolute top-3 right-3 inline-flex h-11 w-11 items-center justify-center rounded-md",
            "text-slate hover:bg-surface-sunken",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]",
          )}
        >
          <X className="h-5 w-5" aria-hidden="true" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      ) : null}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-2 p-5 pr-14", className)} {...props} />;
}

export function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-4 px-5 pb-5", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 border-t border-line p-5 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

export const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-xl font-semibold tracking-[-0.015em] text-ink", className)}
    {...props}
  />
));
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-[15px] leading-relaxed text-slate", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";
