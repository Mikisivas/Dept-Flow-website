"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Signing out.
 *
 * A POST, not a link: a GET that destroys a session can be fired by anything
 * that prefetches a URL, and Next prefetches links in the viewport.
 *
 * `router.refresh()` after the redirect matters — without it the router cache
 * can serve the previous account's server-rendered pages to the next person to
 * sign in on the same browser, which on a shared laptop in a department office
 * is a data leak and not a glitch.
 */
export function LogOutButton({
  variant = "ghost",
  className,
  children = "Log out",
  withIcon = false,
}: {
  variant?: "ghost" | "destructive" | "secondary";
  className?: string;
  children?: React.ReactNode;
  withIcon?: boolean;
}) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  async function logOut() {
    setLeaving(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // The cookie may not have been cleared, so the redirect below will simply
      // bounce back to a signed-in screen. Better than pretending it worked.
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <Button
      variant={variant}
      className={cn(className)}
      onClick={logOut}
      aria-disabled={leaving}
    >
      {withIcon ? <LogOut className="h-4 w-4" aria-hidden="true" /> : null}
      {leaving ? "Signing out…" : children}
    </Button>
  );
}
