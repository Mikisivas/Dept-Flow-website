"use client";

import { Button } from "@/components/ui/button";

/**
 * There is no PDF generator here on purpose. Every browser prints to PDF, the
 * output carries the page's own typography, and a server-side renderer would
 * be a second place for the numbers to come from.
 */
export function PrintButton() {
  return (
    <Button size="lg" variant="secondary" onClick={() => window.print()}>
      Print or save as PDF
    </Button>
  );
}
