#!/usr/bin/env node
/**
 * Renders the HabitPilot vector mark into every icon the web app and Tauri
 * bundle need. Run after editing apps/web/public/logo.svg:
 *
 *   pnpm icons
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const svg = await readFile(join(root, "apps/web/public/logo.svg"));

async function render(size) {
  return sharp(svg, { density: 512 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function writePng(target, size) {
  const buffer = await render(size);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buffer);
  return buffer;
}

const webPublic = join(root, "apps/web/public");
await writePng(join(webPublic, "favicon-16.png"), 16);
await writePng(join(webPublic, "favicon-32.png"), 32);
await writePng(join(webPublic, "logo-192.png"), 192);
await writePng(join(webPublic, "logo-512.png"), 512);

const iconDir = join(root, "apps/desktop/src-tauri/icons");
await writePng(join(iconDir, "32x32.png"), 32);
await writePng(join(iconDir, "128x128.png"), 128);
await writePng(join(iconDir, "128x128@2x.png"), 256);
await writePng(join(iconDir, "icon.png"), 512);

// Multi-resolution ICO with embedded PNG payloads (Windows Vista+).
const icoSizes = [16, 32, 48, 64, 128, 256];
const images = await Promise.all(icoSizes.map((size) => render(size)));
const count = icoSizes.length;
const header = Buffer.alloc(6 + count * 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(count, 4);

let offset = 6 + count * 16;
icoSizes.forEach((size, index) => {
  const entry = 6 + index * 16;
  header[entry] = size === 256 ? 0 : size;
  header[entry + 1] = size === 256 ? 0 : size;
  header[entry + 2] = 0;
  header[entry + 3] = 0;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  const image = images[index];
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
});

await writeFile(join(iconDir, "icon.ico"), Buffer.concat([header, ...images]));

console.log("Rendered logo icons: web favicons/PWA sizes and Tauri PNG/ICO set.");
