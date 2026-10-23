#!/usr/bin/env node
// Render the PNG home-screen icons from public/icon.svg: node scripts/icons.mjs   (re-run after editing the SVG)
// iOS ignores SVG touch icons and Android masks icons to its own shape, so each platform gets a full-bleed square:
//   apple-touch-icon.png 180  — iOS rounds the corners itself, so no transparent corners (they'd turn black)
//   icon-192.png / icon-512.png — the SVG as drawn, for "any" purpose
//   icon-maskable-512.png      — artwork shrunk into the central safe zone so circle/squircle masks don't crop it
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const pub = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public');
const svg = fs.readFileSync(path.join(pub, 'icon.svg'), 'utf8');
const bg = svg.match(/<rect[^>]*fill="([^"]+)"/)[1];
const art = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<rect[^>]*\/>/, '');
const square = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${bg}"/>`
  + `<g transform="translate(50 50) scale(${scale}) translate(-50 -50)">${art}</g></svg>`;

const icons = [
  ['apple-touch-icon.png', 180, square(1)],
  ['icon-192.png', 192, svg],
  ['icon-512.png', 512, svg],
  ['icon-maskable-512.png', 512, square(0.8)],
];

const browser = await chromium.launch(fs.existsSync('/usr/bin/google-chrome') && !process.env.PW_BUNDLED ? { executablePath: '/usr/bin/google-chrome' } : {});
for (const [name, size, src] of icons) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style>`
    + `<img src="data:image/svg+xml;base64,${Buffer.from(src).toString('base64')}">`);
  await page.locator('img').evaluate((img) => img.decode());
  await page.screenshot({ path: path.join(pub, name), omitBackground: true });
  await page.close();
  console.log(`${name} ${size}×${size}`);
}
await browser.close();
