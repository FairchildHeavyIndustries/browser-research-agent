#!/usr/bin/env node
// Reads the S&V catalog and brochure manifest, writes input.json for the agent.
// Accepts an optional filter: --manufacturer, --category, or --id (mutually exclusive).
// Always re-analyzes every product in the filtered set regardless of existing data.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = resolve(__dirname, '../../..', 'Sweep and Vac/website');
const PRODUCTS_JS = resolve(WEBSITE_DIR, 'data/products.js');
const MANIFEST_JSON = resolve(WEBSITE_DIR, 'brochures/manifest.json');
const MANUFACTURERS_JSON = resolve(WEBSITE_DIR, 'data/manufacturers.json');
const INPUT_JSON = resolve(__dirname, 'input.json');

// Parse filter flags
const args = process.argv.slice(2);
const filterFlags = ['--manufacturer', '--category', '--id'];
const activeFilters = filterFlags.filter(f => args.includes(f));

if (activeFilters.length > 1) {
  console.error(`Error: only one filter allowed at a time (got: ${activeFilters.join(', ')})`);
  process.exit(1);
}

const filterType = activeFilters[0]?.slice(2); // 'manufacturer', 'category', 'id', or undefined
const filterValue = filterType ? args[args.indexOf(`--${filterType}`) + 1] : null;

if (filterType && !filterValue) {
  console.error(`Error: --${filterType} requires a value`);
  process.exit(1);
}

const src = readFileSync(PRODUCTS_JS, 'utf8');
const match = src.match(/const products = (\[[\s\S]*?\]);/);
if (!match) {
  console.error('Could not parse products array from products.js');
  process.exit(1);
}

// eslint-disable-next-line no-eval
const products = eval('(' + match[1] + ')');
const manifest = JSON.parse(readFileSync(MANIFEST_JSON, 'utf8'));
const manufacturers = JSON.parse(readFileSync(MANUFACTURERS_JSON, 'utf8'));
const manufacturerBaseUrls = Object.fromEntries(
  manufacturers.filter(m => m.url).map(m => [m.key, m.url])
);

let candidates = products;
if (filterType === 'manufacturer') {
  candidates = products.filter(p => p.manufacturer?.toLowerCase() === filterValue.toLowerCase());
} else if (filterType === 'category') {
  candidates = products.filter(p => p.category?.toLowerCase() === filterValue.toLowerCase());
} else if (filterType === 'id') {
  candidates = products.filter(p => p.id === filterValue);
}

if (candidates.length === 0) {
  console.error(`No products matched ${filterType ? `--${filterType} ${filterValue}` : '(all)'}`);
  process.exit(1);
}

const input = candidates.map(p => {
  const descriptionNeeded = !p.descEn || p.descEn.trim() === '';
  // A brochure exists if: product id is in manifest, OR brochureId points to another
  // product that is in the manifest, OR brochureUrl is set (external URL).
  const brochureNeeded = !p.brochureUrl && !p.brochureId && !manifest.includes(p.id);

  return {
    id: p.id,
    manufacturer: p.manufacturer,
    name: p.nameEn || p.nameEs || p.id,
    manufacturerProductUrl: p.manufacturerProductUrl || '',
    manufacturerBaseUrl: manufacturerBaseUrls[p.manufacturer] || '',
    descriptionNeeded,
    brochureNeeded,
  };
});

writeFileSync(INPUT_JSON, JSON.stringify(input, null, 2));
const filterLabel = filterType ? ` (${filterType}: ${filterValue})` : '';
console.log(`Wrote ${input.length} products to input.json${filterLabel}`);
console.log(`  ${input.filter(p => p.descriptionNeeded).length} need descriptions`);
console.log(`  ${input.filter(p => p.brochureNeeded).length} need brochures`);
