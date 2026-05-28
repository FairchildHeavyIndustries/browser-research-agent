#!/usr/bin/env node
// Applies approved.json to the S&V catalog:
//  - Updates descEn + generates descEs/descFr via Claude API
//  - Downloads accepted images to img/products/[id]/
//  - Adds YouTube IDs
//  - Downloads brochure PDFs to brochures/[id]/brochure.pdf and updates manifest.json
//  - Sets manufacturerProductUrl if newly discovered
//  - Removes products flagged action:"remove"
//  - Merges retryUrl entries back into input.json for the next agent run

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, copyFileSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import https from 'https';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CUSTOMER_DIR = __dirname;
const APPROVED_JSON = resolve(CUSTOMER_DIR, 'approved.json');
const INPUT_JSON = resolve(CUSTOMER_DIR, 'input.json');
const CONFIG_JSON = resolve(CUSTOMER_DIR, 'config.json');

const config = existsSync(CONFIG_JSON) ? JSON.parse(readFileSync(CONFIG_JSON, 'utf8')) : {};
const singleVideo = !!config.singleYoutubeVideo;

const WEBSITE_DIR = resolve(__dirname, '../../..', 'Sweep and Vac/website');
const PRODUCTS_JS = resolve(WEBSITE_DIR, 'data/products.js');
const MANIFEST_JSON = resolve(WEBSITE_DIR, 'brochures/manifest.json');
const IMG_DIR = resolve(WEBSITE_DIR, 'img/products');
const BROCHURES_DIR = resolve(WEBSITE_DIR, 'brochures');

if (!existsSync(APPROVED_JSON)) {
  console.error('approved.json not found. Submit the review UI first.');
  process.exit(1);
}

const approved = JSON.parse(readFileSync(APPROVED_JSON, 'utf8'));
const client = new Anthropic();

// ── Load catalog ─────────────────────────────────────────────────────────────
const productsSrc = readFileSync(PRODUCTS_JS, 'utf8');
const productsMatch = productsSrc.match(/(const products = )(\[[\s\S]*?\]);/);
if (!productsMatch) {
  console.error('Could not parse products array from products.js');
  process.exit(1);
}
// eslint-disable-next-line no-eval
let products = eval('(' + productsMatch[2] + ')');

// ── Load brochure manifest ────────────────────────────────────────────────────
let manifest = JSON.parse(readFileSync(MANIFEST_JSON, 'utf8'));

// ── Translation helper ────────────────────────────────────────────────────────
async function translate(descEn, targetLang) {
  const langNames = { es: 'Latin American Spanish', fr: 'Canadian French' };
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: `You are a professional B2B translator specializing in heavy equipment. Translate the following product description from English to ${langNames[targetLang]}. Preserve paragraph breaks. Output ONLY the translated text — no preamble, no explanation.`,
    messages: [{ role: 'user', content: descEn }],
  });
  return response.content.map(b => b.text).join('').trim();
}

// ── Download helper ───────────────────────────────────────────────────────────
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const file = { chunks: [], length: 0 };

    function doRequest(url, redirects = 0) {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      lib.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; catalog-agent/1.0)' },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          const redirectLib = redirectUrl.startsWith('https') ? https : http;
          // Switch lib if needed
          const lib2 = redirectUrl.startsWith('https') ? https : http;
          lib2.get(redirectUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res2) => {
            handleResponse(res2, url, redirects + 1);
          }).on('error', reject);
          return;
        }
        handleResponse(res, url, redirects);
      }).on('error', reject);
    }

    function handleResponse(res, url, redirects) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        doRequest(new URL(res.headers.location, url).href, redirects + 1);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.on('data', chunk => { file.chunks.push(chunk); file.length += chunk.length; });
      res.on('end', () => {
        const buf = Buffer.concat(file.chunks, file.length);
        writeFileSync(destPath, buf);
        resolve(destPath);
      });
      res.on('error', reject);
    }

    doRequest(url);
  });
}

// ── Save catalog ──────────────────────────────────────────────────────────────
function saveCatalog() {
  // Serialize products back to JS — preserve the header comment block
  const header = productsSrc.slice(0, productsSrc.indexOf('const products = '));
  const serialized = products.map(p => {
    // Use JSON.stringify for each product object, then indent
    return '  ' + JSON.stringify(p, null, 2).replace(/\n/g, '\n  ');
  }).join(',\n');
  const out = `${header}const products = [\n${serialized}\n];\n`;
  writeFileSync(PRODUCTS_JS, out);
}

// ── Image processing: resize to 800px longest side, encode to WebP ≤150 KB ────
const MAX_BYTES = 150 * 1024;

function toWebp(srcPath, destPath) {
  const tmpPng = `/tmp/sv_conv_${process.pid}.png`;
  const tmpJpg = `/tmp/sv_conv_${process.pid}.jpg`;

  try {
    // Detect format by reading magic bytes
    const buf = readFileSync(srcPath);
    const isAvif = buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70; // "ftyp"

    let intermediate;
    if (isAvif) {
      execSync(`/usr/local/bin/avifdec "${srcPath}" "${tmpPng}"`, { stdio: 'pipe' });
      intermediate = tmpPng;
    } else {
      // JPEG or PNG — sips handles both
      intermediate = srcPath;
    }

    // Resize to 800px longest side into a temp jpg (sips can't write back to same path reliably)
    execSync(`/usr/bin/sips -Z 800 "${intermediate}" --out "${tmpJpg}"`, { stdio: 'pipe' });

    // Encode at decreasing quality until ≤150 KB
    for (const q of [85, 75, 65]) {
      execSync(`/usr/local/bin/cwebp -q ${q} "${tmpJpg}" -o "${destPath}"`, { stdio: 'pipe' });
      const size = readFileSync(destPath).length;
      if (size <= MAX_BYTES) break;
    }
  } finally {
    for (const tmp of [tmpPng, tmpJpg]) {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const retryItems = []; // entries to merge back into input.json

  for (const entry of approved) {
    const { id, action } = entry;

    if (action === 'skip') {
      console.log(`[skip] ${id}`);
      continue;
    }

    if (action === 'retry') {
      console.log(`[retry] ${id} → ${entry.retryUrl}`);
      retryItems.push(id);
      continue;
    }

    if (action === 'local-page') {
      console.log(`[local-page] ${id} — local file present, will be picked up on next agent run`);
      continue;
    }

    if (action === 'remove') {
      const before = products.length;
      products = products.filter(p => p.id !== id);
      console.log(`[remove] ${id} (${before - products.length} removed)`);
      continue;
    }

    // action === 'update'
    const product = products.find(p => p.id === id);
    if (!product) {
      console.warn(`[warn] product ${id} not found in catalog — skipping`);
      continue;
    }

    process.stdout.write(`[update] ${id} ... `);
    const changes = [];

    // Description
    if (entry.acceptDesc && entry.descEn && entry.descEn.trim()) {
      product.descEn = entry.descEn.trim();
      changes.push('descEn');

      process.stdout.write('translating ... ');
      const [descEs, descFr] = await Promise.all([
        translate(product.descEn, 'es'),
        translate(product.descEn, 'fr'),
      ]);
      product.descEs = descEs;
      product.descFr = descFr;
      changes.push('descEs', 'descFr');
    }

    // Images
    if (entry.acceptImages && entry.acceptImages.length > 0) {
      const productImgDir = resolve(IMG_DIR, id);
      mkdirSync(productImgDir, { recursive: true });

      // Put primaryImage first, then the rest (deduplicated)
      const primary = entry.primaryImage || entry.acceptImages[0];
      const ordered = [primary, ...entry.acceptImages.filter(u => u !== primary)];

      const finalPaths = [];
      let fileIndex = 0;

      for (const url of ordered) {
        if (!url.startsWith('http') && !url.startsWith('file://')) {
          // Existing catalog image — keep relative path as-is, no download
          finalPaths.push(url);
          continue;
        }
        const webpName = `${String(fileIndex + 1).padStart(2, '0')}.webp`;
        const destPath = resolve(productImgDir, webpName);
        const srcExt = extname(url.startsWith('file://') ? url.replace(/^file:\/\//, '') : new URL(url).pathname) || '.jpg';
        const tmpSrc = `/tmp/sv_src_${process.pid}_${fileIndex}${srcExt}`;
        try {
          if (url.startsWith('file://')) {
            copyFileSync(url.replace(/^file:\/\//, ''), tmpSrc);
          } else {
            await download(url, tmpSrc);
          }
          toWebp(tmpSrc, destPath);
          unlinkSync(tmpSrc);
          finalPaths.push(`img/products/${id}/${webpName}`);
          fileIndex++;
        } catch (err) {
          console.warn(`\n  [warn] failed to process image ${url}: ${err.message}`);
          if (existsSync(tmpSrc)) unlinkSync(tmpSrc);
        }
      }

      if (finalPaths.length > 0) {
        product.image = finalPaths[0];
        product.images = finalPaths.slice(1);
        changes.push(`images(${finalPaths.length})`);
      }
    }

    // YouTube IDs
    if (entry.acceptYoutubeIds && entry.acceptYoutubeIds.length > 0) {
      if (singleVideo) {
        const vid = entry.acceptYoutubeIds[0];
        product.youtubeId = vid;
        delete product.youtubeIds;
        changes.push(`yt:${vid}`);
      } else {
        const existing = new Set([product.youtubeId, ...(product.youtubeIds || [])].filter(Boolean));
        for (const vid of entry.acceptYoutubeIds) {
          if (!existing.has(vid)) {
            if (!product.youtubeId) {
              product.youtubeId = vid;
            } else {
              product.youtubeIds = [...(product.youtubeIds || []), vid];
            }
            changes.push(`yt:${vid}`);
          }
        }
      }
    }

    // Brochure
    if (entry.acceptBrochure && entry.brochureUrl) {
      const brochureDir = resolve(BROCHURES_DIR, id);
      mkdirSync(brochureDir, { recursive: true });
      const destPath = resolve(brochureDir, 'brochure.pdf');
      try {
        await download(entry.brochureUrl, destPath);
        if (!manifest.includes(id)) {
          manifest.push(id);
          writeFileSync(MANIFEST_JSON, JSON.stringify(manifest, null, 2));
        }
        changes.push('brochure');
      } catch (err) {
        console.warn(`\n  [warn] failed to download brochure ${entry.brochureUrl}: ${err.message}`);
      }
    }

    // manufacturerProductUrl
    if (entry.manufacturerProductUrl && !product.manufacturerProductUrl) {
      product.manufacturerProductUrl = entry.manufacturerProductUrl;
      changes.push('manufacturerProductUrl');
    }

    console.log(changes.length > 0 ? changes.join(', ') : 'no changes');
  }

  // Update input.json for retry items — set the reviewer-provided URL
  if (existsSync(INPUT_JSON)) {
    const input = JSON.parse(readFileSync(INPUT_JSON, 'utf8'));
    for (const entry of approved.filter(e => e.action === 'retry' && e.retryUrl)) {
      const item = input.find(i => i.id === entry.id);
      if (item) item.manufacturerProductUrl = entry.retryUrl;
    }
    writeFileSync(INPUT_JSON, JSON.stringify(input, null, 2));
    if (approved.some(e => e.action === 'retry')) {
      console.log('\nUpdated input.json with retry URLs. Re-run agent to research these.');
    }
  }

  // Save catalog
  saveCatalog();
  console.log('\nCatalog updated.');

  // Image integrity check
  try {
    const imgCheck = productsSrc.match(/img\/products\/[^'"]+/g) || [];
    const missing = imgCheck.filter(p => !existsSync(resolve(WEBSITE_DIR, p)));
    if (missing.length > 0) {
      console.warn(`\nImage integrity check: ${missing.length} missing files:`);
      missing.forEach(p => console.warn('  ' + p));
    } else {
      console.log('Image integrity check: OK');
    }
  } catch { /* non-fatal */ }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
