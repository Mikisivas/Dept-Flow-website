"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function MarkReadButton({ unread }: { unread: number }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);

  if (unread === 0) return null;

  return (
    <Button
      variant="secondary"
      onClick={async () => {
        setWorking(true);
        try {
          await fetch("/api/notifications", { method: "POST" });
          router.refresh();
        } finally {
          setWorking(false);
        }
      }}
      aria-disabled={working}
    >
      {working ? "Working…" : "Mark all read"}
    </Button>
  );
}
