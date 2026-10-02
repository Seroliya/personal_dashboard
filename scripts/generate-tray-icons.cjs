const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { browserOptions } = require("../runtime-paths");

const shapes = {
  tray: '<rect x="1" y="1" width="22" height="22" rx="5" fill="white" stroke="#d9d9df"/><path d="M6 7h12M6 12h12M6 17h12"/>',
  toggle: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M14 3v18M6 8h5M6 12h5M6 16h5"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/>',
  close: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 7h18M9 11l6 6M15 11l-6 6"/>',
  exit: '<path d="M12 3v9M7 5a8 8 0 1 0 10 0"/>',
};

(async () => {
  const directory = path.join(__dirname, "..", "desktop-panel", "icons");
  fs.mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...browserOptions() });
  try {
    const page = await browser.newPage();
    for (const [name, shape] of Object.entries(shapes)) {
      for (const scale of [1, 2]) {
        const size = 16 * scale;
        await page.setViewportSize({ width: size, height: size });
        await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style><svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${shape}</svg>`);
        await page.screenshot({ path: path.join(directory, `${name}${scale === 2 ? "@2x" : ""}.png`), omitBackground: true });
      }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
