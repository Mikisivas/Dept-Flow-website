/**
 * Rasterises the university logo into the PNGs a home-screen icon needs, and
 * the favicon.
 *
 * The logo is the university's own mark and it is used whole: it is not ours
 * to simplify, crop or redraw. Below about 48px its ring text cannot be read,
 * but the red ring, the black field and the blue T still are, and that is what
 * a student recognises in a row of tabs.
 *
 * Run with `npm run build:icons`. Committed output, not a build step: the logo
 * changes about once a decade, and a build that shells out to sharp is a build
 * that breaks on a machine where sharp did not compile.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const LOGO = "public/university-logo.png";

/**
 * `padding` is the maskable safe zone. Android crops an adaptive icon to
 * whatever shape the launcher uses — a circle, a squircle, a rounded square —
 * and anything outside the middle 80% can be cut. The ring drawn edge to edge
 * would lose its text.
 */
async function icon({ size, padding = 0, background = null }) {
  const inner = size - padding * 2;
  const logo = await sharp(LOGO).resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: logo, top: padding, left: padding }])
    // Palette PNG: a quarter of the size, no visible change on a flat-colour
    // mark, and the icon is fetched over the same patchy data as everything else.
    .png({ palette: true, quality: 95, effort: 10, compressionLevel: 9 })
    .toBuffer();
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

for (const spec of icons) {
  const png = await icon(spec);
  writeFileSync(spec.file, png);
  console.log(`${spec.file} — ${spec.size}px, ${(png.length / 1024).toFixed(1)}kB`);
}

/**
 * favicon.ico, which Next serves from src/app/ on its own. Without this the
 * tab shows whatever create-next-app left there.
 *
 * Each entry is a PNG rather than a bitmap — every browser this product
 * supports reads PNG-in-ICO, and it keeps the alpha channel intact.
 */
const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map((size) => icon({ size })));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);

let offset = 6 + 16 * sizes.length;
const entries = sizes.map((size, index) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size, 0); // width
  entry.writeUInt8(size, 1); // height
  entry.writeUInt8(0, 2); // no palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(images[index].length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += images[index].length;
  return entry;
});

const ico = Buffer.concat([header, ...entries, ...images]);
writeFileSync("src/app/favicon.ico", ico);
console.log(`src/app/favicon.ico — ${sizes.join("/")}px, ${(ico.length / 1024).toFixed(1)}kB`);
