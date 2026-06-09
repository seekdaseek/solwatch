const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://seekdaseek.github.io/solwatch';
const OUT_DIR = '/Volumes/D/solwatch-metadata/cnft';

const TIERS = {
  Bronze:   { min: 1,   max: 13,  color: '#CD7F32', image: `${BASE_URL}/images/bronze.png` },
  Silver:   { min: 14,  max: 29,  color: '#C0C0C0', image: `${BASE_URL}/images/silver.png` },
  Gold:     { min: 30,  max: 89,  color: '#FFD700', image: `${BASE_URL}/images/gold.png` },
  Platinum: { min: 90,  max: 364, color: '#E5E4E2', image: `${BASE_URL}/images/platinum.png` },
  Diamond:  { min: 365, max: 500, color: '#B9F2FF', image: `${BASE_URL}/images/diamond.png` },
};

function getTier(day) {
  for (const [name, t] of Object.entries(TIERS)) {
    if (day >= t.min && day <= t.max) return { name, ...t };
  }
  return { name: 'Diamond', ...TIERS.Diamond };
}

let count = 0;
for (let day = 1; day <= 500; day++) {
  const tier = getTier(day);
  const dir = path.join(OUT_DIR, tier.name.toLowerCase());
  fs.mkdirSync(dir, { recursive: true });

  const metadata = {
    name: `SolWatch Check-in Day ${day} — ${tier.name}`,
    symbol: 'SWCI',
    description: `Day ${day} check-in badge for SolWatch. Tier: ${tier.name}. Keep your streak alive.`,
    image: tier.image,
    attributes: [
      { trait_type: 'Tier',      value: tier.name },
      { trait_type: 'Streak Day', value: day },
      { trait_type: 'App',       value: 'SolWatch' },
    ],
    properties: {
      files: [{ uri: tier.image, type: 'image/png' }],
      category: 'image',
    },
  };

  fs.writeFileSync(
    path.join(dir, `day-${day}.json`),
    JSON.stringify(metadata, null, 2)
  );
  count++;
}

console.log(`✅ Generated ${count} metadata files in ${OUT_DIR}`);
