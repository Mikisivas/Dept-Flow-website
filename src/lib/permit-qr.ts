import "server-only";

import QRCode from "qrcode";

/**
 * The QR on the exam permit (§9.3).
 *
 * "The permit carries a QR code linking to a verification endpoint, so it
 * can't be screenshotted and edited into a fake."
 *
 * The QR is not what makes the permit hard to forge — anyone can generate a
 * QR pointing anywhere. What makes it hard to forge is that the code carries
 * a reference the DATABASE has to recognise, and the page it opens reads that
 * reference from the server rather than from the paper. Edit the name on a
 * screenshot and the QR still opens the real record, under the real name. The
 * document has to argue with itself in front of the invigilator.
 *
 * Rendered as an inline SVG string rather than an <img src="data:...">
 * because the permit is printed: an SVG stays sharp at whatever size the
 * browser's print dialog picks, and it needs no network at the hall door.
 *
 * Error correction M, not L. A permit lives folded in a pocket for a term.
 */
export async function permitQr(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: "svg",
    errorCorrectionLevel: "M",
    // One module of quiet zone rather than the default four: the panel around
    // it supplies the white space, and four makes the code visibly smaller on
    // paper for nothing.
    margin: 1,
    color: { dark: "#111111", light: "#FFFFFF" },
  });
}

/**
 * Where the QR points.
 *
 * Absolute, because it is scanned off paper by a phone that has no idea what
 * site the document came from. Falls back to localhost so a development
 * permit is still a working permit rather than a broken link.
 */
export function permitVerifyUrl(reference: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  return `${base}/check/permit?ref=${encodeURIComponent(reference)}`;
}
