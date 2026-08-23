/**
 * Rasterises the site mark into the PNGs a home-screen icon needs.
 *
 * The SIMPLIFIED mark, never the crest. The crest's ribbon outlines are
 * hairlines and its banner text turns to mud below about 200px, which is most
 * of the sizes an installed icon is drawn at.
 *
 * Run with `npm run build:icons`. Committed output, not a build step: the mark
 * changes about once a year, and a build that shells out to sharp is a build
 * that breaks on a machine where sharp did not compile.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const BRAND = "#ff9935";
const ON_BRAND = "#0a0a0a";

/**
 * `padding` is the maskable safe zone. Android crops an adaptive icon to
 * whatever shape the launcher uses — a circle, a squircle, a rounded square —
 * and anything outside the middle 80% can be cut. The shield drawn edge to
 * edge would lose its point.
 */
function markSvg({ size, padding = 0, background = null }) {
  const inner = size - padding * 2;
  const scale = inner / 24;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : ""}
  <g transform="translate(${padding} ${padding}) scale(${scale})">
    <path d="M12 2 4 4.6v7.1c0 4.9 3.3 8.6 8 10.3 4.7-1.7 8-5.4 8-10.3V4.6z"
          fill="${BRAND}" stroke="${ON_BRAND}" stroke-width="1.5"
          stroke-linejoin="round"/>
    <rect x="8" y="9" width="8" height="5.4" fill="${ON_BRAND}"/>
    <rect x="10.4" y="15" width="3.2" height="1.5" fill="${ON_BRAND}"/>
  </g>
</svg>`;
}

const icons = [
  // Transparent, for the browser tab and the manifest's "any" purpose.
  { file: "public/icon-192.png", size: 192 },
  { file: "public/icon-512.png", size: 512 },
  // Maskable needs an opaque background: a launcher cropping a transparent
  // icon to a circle leaves the corners showing whatever is behind it.
  { file: "public/icon-maskable-512.png", size: 512, padding: 64, background: "#ffffff" },
  // iOS ignores the manifest for the home screen and composites onto white,
  // so this one ships with its own background and no transparency.
  { file: "public/apple-touch-icon.png", size: 180, padding: 14, background: "#ffffff" },
];

mkdirSync("public", { recursive: true });

for (const icon of icons) {
  const svg = markSvg(icon);
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(icon.file, png);
  console.log(`${icon.file} — ${icon.size}px, ${(png.length / 1024).toFixed(1)}kB`);
}
