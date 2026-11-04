// Run from the repository root: node scripts/make_icons.js site   (needs Playwright with Chromium)
// Builds the RiverChart icon (concept B: the Ljubljanica and Sava meeting at Zalog, groundwater dotted below).
// Deep blue, so it sits well on both the light and the dark iOS Home Screen.
const fs = require('fs'); const { chromium } = require('playwright');
const art = `<path d="M10 16 C 24 16, 28 27, 40 27 L 54 27" fill="none" stroke="#8cc4ff" stroke-width="5.5" stroke-linecap="round"/>
<path d="M10 38 C 24 38, 28 27, 40 27" fill="none" stroke="#ffffff" stroke-width="5.5" stroke-linecap="round"/>
<path d="M12 50 H 52" fill="none" stroke="#5c9ee8" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="0.1 8"/>`;
const grad = `<defs><linearGradient id="rc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f5fb8"/><stop offset="1" stop-color="#0c2a5c"/></linearGradient></defs>`;
const svg = (rx, scale = 1) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${grad}<rect width="64" height="64" rx="${rx}" fill="url(#rc)"/>` +
  (scale === 1 ? art : `<g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${art}</g>`) + `</svg>`;
const out = process.argv[2];
fs.writeFileSync(`${out}/favicon.svg`, svg(14).replace(/\n/g, "") + "\n");
const pngs = [
  ["apple-touch-icon.png", 180, svg(0)],            // iOS rounds the corners itself
  ["icons/app-any-192.png", 192, svg(14)],
  ["icons/app-any-512.png", 512, svg(14)],
  ["icons/app-maskable-192.png", 192, svg(0, 0.8)],  // Android crops to its own shape: art inside the safe zone
  ["icons/app-maskable-512.png", 512, svg(0, 0.8)],
];
(async () => {
  const b = await chromium.launch();
  for (const [file, size, s] of pngs) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<body style="margin:0">${s.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
    await p.screenshot({ path: `${out}/${file}`, omitBackground: true });
  }
  await b.close();
})();
