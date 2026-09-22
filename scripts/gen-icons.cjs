// One-off Phase 5 icon generator - run manually, not part of the build.
// Produces src-tauri/icons/* and public/favicon.png from the trimmed
// public/logo-mark.png, composited onto a soft rounded-square badge
// matching the sidebar brand-mark treatment in the Phase 5 mockups.
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;
const fs = require('fs');

const LOGO = 'public/logo-mark.png';
const CANVAS = 1024;
const PAD_FRAC = 0.16; // logo occupies (1 - 2*PAD_FRAC) of canvas
const RADIUS_FRAC = 0.22;
const BG = { r: 236, g: 243, b: 252, alpha: 1 }; // soft pale-blue badge, matches sidebar mark

async function badge(size) {
  const r = Math.round(size * RADIUS_FRAC);
  const roundedRectSvg = Buffer.from(
    `<svg width="${size}" height="${size}"><rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="rgb(${BG.r},${BG.g},${BG.b})"/></svg>`
  );
  const inner = Math.round(size * (1 - 2 * PAD_FRAC));
  const logoBuf = await sharp(LOGO).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
  const offset = Math.round(size * PAD_FRAC);
  return sharp(roundedRectSvg)
    .composite([{ input: logoBuf, left: offset, top: offset }])
    .png()
    .toBuffer();
}

async function main() {
  fs.mkdirSync('src-tauri/icons', { recursive: true });
  const base = await badge(CANVAS);

  const sizes = { '32x32.png': 32, '128x128.png': 128, '128x128@2x.png': 256 };
  for (const [name, size] of Object.entries(sizes)) {
    await sharp(base).resize(size, size).png().toFile(`src-tauri/icons/${name}`);
    console.log('wrote', name);
  }
  await sharp(base).resize(512, 512).png().toFile('src-tauri/icons/icon.png');
  console.log('wrote icon.png (512)');

  await sharp(base).resize(256, 256).png().toFile('public/favicon.png');
  console.log('wrote public/favicon.png');

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBufs = [];
  for (const s of icoSizes) {
    icoBufs.push(await sharp(base).resize(s, s).png().toBuffer());
  }
  const ico = await pngToIco(icoBufs);
  fs.writeFileSync('src-tauri/icons/icon.ico', ico);
  console.log('wrote icon.ico');
}

main().catch((e) => { console.error(e); process.exit(1); });
