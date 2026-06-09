const fs = require('fs');
const path = require('path');

const OUT_DIR = '/Volumes/D/solwatch/images';
fs.mkdirSync(OUT_DIR, { recursive: true });

const tiers = {
  bronze:   { color: '#CD7F32', glow: '#a05a1a', label: 'BRONZE' },
  silver:   { color: '#C0C0C0', glow: '#888888', label: 'SILVER' },
  gold:     { color: '#FFD700', glow: '#b8960c', label: 'GOLD' },
  platinum: { color: '#E5E4E2', glow: '#a0a0a0', label: 'PLATINUM' },
  diamond:  { color: '#00CFFF', glow: '#0077aa', label: 'DIAMOND' },
};

for (const [name, t] of Object.entries(tiers)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">
  <defs>
    <radialGradient id="bg" cx="50%" cy="50%" r="50%">
      <stop offset="0%" style="stop-color:#1a1a2e"/>
      <stop offset="100%" style="stop-color:#0d0d1a"/>
    </radialGradient>
    <radialGradient id="gem" cx="40%" cy="35%" r="60%">
      <stop offset="0%" style="stop-color:#ffffff;stop-opacity:0.9"/>
      <stop offset="40%" style="stop-color:${t.color};stop-opacity:1"/>
      <stop offset="100%" style="stop-color:${t.glow};stop-opacity:1"/>
    </radialGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- Background -->
  <rect width="500" height="500" fill="url(#bg)" rx="40"/>

  <!-- Outer ring -->
  <circle cx="250" cy="220" r="140" fill="none" stroke="${t.color}" stroke-width="3" opacity="0.4"/>
  <circle cx="250" cy="220" r="150" fill="none" stroke="${t.color}" stroke-width="1" opacity="0.2"/>

  <!-- Gem shape -->
  <polygon points="250,80 370,180 330,310 170,310 130,180"
    fill="url(#gem)" filter="url(#glow)" opacity="0.95"/>
  <polygon points="250,80 370,180 250,150" fill="#ffffff" opacity="0.15"/>
  <polygon points="250,150 370,180 330,310 170,310 130,180"
    fill="${t.glow}" opacity="0.3"/>

  <!-- Shine -->
  <ellipse cx="220" cy="155" rx="25" ry="12" fill="#ffffff" opacity="0.25" transform="rotate(-20 220 155)"/>

  <!-- App name -->
  <text x="250" y="390" font-family="Arial,sans-serif" font-size="22"
    fill="${t.color}" text-anchor="middle" letter-spacing="6" opacity="0.9">SOLWATCH</text>

  <!-- Tier name -->
  <text x="250" y="440" font-family="Arial,sans-serif" font-size="32" font-weight="bold"
    fill="${t.color}" text-anchor="middle" letter-spacing="4" filter="url(#glow)">${t.label}</text>

  <!-- Bottom line -->
  <line x1="150" y1="455" x2="350" y2="455" stroke="${t.color}" stroke-width="1" opacity="0.4"/>
  <text x="250" y="475" font-family="Arial,sans-serif" font-size="13"
    fill="#ffffff" text-anchor="middle" opacity="0.4">CHECK-IN BADGE</text>
</svg>`;

  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), svg);
  console.log(`✅ ${name}.png`);
}
console.log('All tier images generated');
