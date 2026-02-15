// Generate PWA icons as SVG-in-PNG
// Creates simple but distinctive hammer icon on dark purple background
import fs from 'fs';

function createSvgIcon(size) {
  const padding = Math.floor(size * 0.15);
  const iconSize = size - padding * 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#7c5bf5"/>
      <stop offset="100%" stop-color="#5b3fd4"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${Math.floor(size * 0.2)}" fill="url(#bg)"/>
  <text x="${size/2}" y="${size * 0.62}" font-size="${iconSize * 0.6}" text-anchor="middle" fill="white" font-family="Arial">&#128296;</text>
</svg>`;
}

// We can't easily create PNGs without canvas, so let's create SVGs
// and reference them in the manifest
const svg192 = createSvgIcon(192);
const svg512 = createSvgIcon(512);

fs.writeFileSync('public/boof-icon-192.svg', svg192);
fs.writeFileSync('public/boof-icon-512.svg', svg512);

console.log('SVG icons generated');
