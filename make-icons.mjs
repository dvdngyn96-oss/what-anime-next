/* Renders the site icons from favicon.svg, which is the source.
 *
 *   node make-icons.mjs
 *
 * Same reasoning as make-og-image.html: the image files are outputs, so a
 * colour change regenerates them rather than orphaning a binary nobody can
 * reproduce. Playwright is already here for make-tiktok.mjs, so this adds no
 * dependency.
 *
 * Why real files at all, when the icon used to be an emoji inside a data: URL:
 * Chrome on Windows drew that emoji as a blank white circle in its tabs and
 * address bar, and Google's search results only show an icon it can fetch
 * from a real URL — it ignores data: icons entirely.
 *
 *   favicon.ico           16, 32 and 48 inside one file. Google wants a
 *                         multiple of 48, and old browsers ask for /favicon.ico
 *                         whether or not the page names it.
 *   favicon.svg           modern browsers, sharp at any size
 *   apple-touch-icon.png  180, for "add to home screen". Square and without the
 *                         border, because iOS rounds the corners itself.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const svg = readFileSync('favicon.svg', 'utf8');

/* The touch icon is full-bleed: iOS applies its own rounding, and a drawn
   border inside that would show as a grey ring. */
const touchSvg = svg
  .replace(/<rect [^>]*\/>/, '<rect width="64" height="64" fill="#fff"/>')
  .replace('viewBox="0 0 64 64"', 'viewBox="-6 -6 76 76"');

const browser = await chromium.launch();
const page = await browser.newPage();

async function render(source, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">`
    + source.replace('<svg ', `<svg width="${size}" height="${size}" `)
    + `</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

const pngs = [];
for (const size of [16, 32, 48]) pngs.push({ size, data: await render(svg, size) });
writeFileSync('apple-touch-icon.png', await render(touchSvg, 180));
await browser.close();

/* An ICO is a 6-byte header, a 16-byte directory entry per image, then the
   images. Modern ICO readers accept PNG data as the image, so no bitmap
   conversion is needed. */
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = 6 + 16 * pngs.length;
const entries = pngs.map(({ size, data }) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(size, 0);
  e.writeUInt8(size, 1);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});
writeFileSync('favicon.ico', Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));

console.log('wrote favicon.ico (16, 32, 48) and apple-touch-icon.png (180)');
