import type { Metadata } from "next";
import { PermitCheckForm } from "./permit-check-form";

export const metadata: Metadata = {
  title: "Check an exam permit",
};

/**
 * Where the QR on the permit lands (§9.3).
 *
 * The reference arrives in the query string, so a scan goes straight to the
 * answer rather than to a form the invigilator has to fill in from the
 * document they are holding. Typed by hand it still works — the form is the
 * same form, and a phone with no camera is not a phone that should be turned
 * away at the door.
 *
 * The reference is not a secret and putting it in a URL costs nothing: whoever
 * scanned it is holding the paper it is printed on.
 */
export default async function PermitCheckPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const { ref } = await searchParams;
  return <PermitCheckForm initialReference={ref ?? ""} />;
}
