#!/usr/bin/env node
// Review server — serves a local HTML UI for reviewing agent output.
// Loads output.json and current catalog state, shows only new/changed fields.
// On Submit writes approved.json and calls write-catalog.js.

import http from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const customerIdx = args.indexOf('--customer');
const customer = customerIdx !== -1 ? args[customerIdx + 1] : null;
const portIdx = args.indexOf('--port');
const PORT = portIdx !== -1 ? parseInt(args[portIdx + 1]) : 3001;

if (!customer) {
  console.error('Usage: node review-server.js --customer <slug>');
  process.exit(1);
}

const CUSTOMER_DIR = resolve(__dirname, 'customers', customer);
const OUTPUT_JSON = resolve(CUSTOMER_DIR, 'output.json');
const APPROVED_JSON = resolve(CUSTOMER_DIR, 'approved.json');
const WRITE_CATALOG = resolve(CUSTOMER_DIR, 'write-catalog.js');
const CONFIG_JSON = resolve(CUSTOMER_DIR, 'config.json');

const config = existsSync(CONFIG_JSON) ? JSON.parse(readFileSync(CONFIG_JSON, 'utf8')) : {};
const singleVideo = !!config.singleYoutubeVideo;

if (!existsSync(OUTPUT_JSON)) {
  console.error(`output.json not found at ${OUTPUT_JSON}`);
  console.error('Run the agent first: node agent.js --customer ' + customer);
  process.exit(1);
}

// Load catalog state so we can detect what's new/changed
const WEBSITE_DIR = resolve(__dirname, '..', 'Sweep and Vac/website');
const PRODUCTS_JS = resolve(WEBSITE_DIR, 'data/products.js');
const productsSrc = readFileSync(PRODUCTS_JS, 'utf8');
const productsMatch = productsSrc.match(/const products = (\[[\s\S]*?\]);/);
// eslint-disable-next-line no-eval
const catalogProducts = productsMatch ? eval('(' + productsMatch[1] + ')') : [];
const catalogById = Object.fromEntries(catalogProducts.map(p => [p.id, p]));

const output = JSON.parse(readFileSync(OUTPUT_JSON, 'utf8'));

// ── HTML UI ─────────────────────────────────────────────────────────────────
function buildHtml() {
  const items = output.map(item => {
    const catalog = catalogById[item.id] || {};
    return { item, catalog };
  });

  const doneItems = items.filter(({ item }) => item.status === 'done');
  const stuckItems = items.filter(({ item }) => item.status === 'stuck');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Catalog Review — ${customer}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; background: #f5f5f5; color: #1a1a1a; }
  h1 { margin: 0; padding: 1.5rem 2rem; background: #1e3a5f; color: white; font-size: 1.4rem; }
  .summary { padding: .75rem 2rem; background: #e8f0fe; border-bottom: 1px solid #c5d5f5; font-size: .9rem; }
  .section-header { padding: .75rem 2rem; background: #dfe3ea; font-weight: 600; font-size: 1rem; border-top: 2px solid #aab; }
  .product { background: white; margin: 1rem 2rem; border-radius: 6px; border: 1px solid #ddd; overflow: hidden; }
  .product-header { padding: .75rem 1rem; background: #f0f4ff; border-bottom: 1px solid #ddd; display: flex; align-items: baseline; gap: 1rem; }
  .product-header h2 { margin: 0; font-size: 1rem; }
  .product-header .manufacturer { color: #555; font-size: .85rem; }
  .product-header .url { color: #2255cc; font-size: .8rem; word-break: break-all; }
  .product-body { padding: 1rem; }
  .field { margin-bottom: 1.2rem; }
  .field label { display: block; font-size: .8rem; font-weight: 600; color: #444; margin-bottom: .3rem; text-transform: uppercase; letter-spacing: .05em; }
  .field textarea { width: 100%; padding: .5rem; border: 1px solid #ccc; border-radius: 4px; font-size: .9rem; line-height: 1.5; resize: vertical; }
  .images-grid { display: flex; flex-wrap: wrap; gap: .5rem; }
  .img-item { display: flex; flex-direction: column; align-items: center; gap: .3rem; }
  .img-item img { width: 140px; height: 100px; object-fit: contain; border: 1px solid #ddd; border-radius: 3px; background: #fafafa; cursor: pointer; }
  .img-item img.selected { border: 2px solid #2255cc; }
  .img-item label { font-size: .75rem; text-align: center; word-break: break-all; width: 140px; }
  .side-by-side { display: flex; gap: 2rem; }
  .side-label { font-size: .75rem; font-weight: 600; color: #666; margin-bottom: .4rem; }
  .checkbox-row { display: flex; align-items: center; gap: .5rem; margin-bottom: .4rem; }
  .stuck-product { background: #fff8f0; margin: 1rem 2rem; border-radius: 6px; border: 1px solid #f0c090; }
  .stuck-reason { color: #b94a00; font-style: italic; padding: 0 1rem .5rem 1rem; font-size: .9rem; }
  .stuck-actions { padding: .75rem 1rem; display: flex; flex-direction: column; gap: .5rem; }
  .stuck-actions label { display: flex; align-items: center; gap: .5rem; font-size: .9rem; }
  .stuck-actions input[type=text] { flex: 1; padding: .35rem .5rem; border: 1px solid #ccc; border-radius: 4px; font-size: .9rem; }
  .submit-bar { position: sticky; bottom: 0; background: #1e3a5f; padding: 1rem 2rem; display: flex; justify-content: flex-end; }
  .submit-bar button { background: #2e7d32; color: white; border: none; padding: .7rem 2rem; border-radius: 5px; font-size: 1rem; cursor: pointer; font-weight: 600; }
  .submit-bar button:hover { background: #1b5e20; }
  .badge { display: inline-block; padding: .15rem .5rem; border-radius: 3px; font-size: .75rem; font-weight: 600; margin-left: .5rem; }
  .badge-done { background: #c8e6c9; color: #1b5e20; }
  .badge-stuck { background: #ffe0cc; color: #b94a00; }
  .yt-item { display: flex; align-items: center; gap: .5rem; margin-bottom: .3rem; }
  .yt-preview { width: 120px; height: 70px; border-radius: 3px; border: 1px solid #ddd; }
</style>
</head>
<body>
<h1>Catalog Review — ${customer} <span style="font-weight:normal;font-size:.9rem;">(${output.length} products)</span></h1>
<div class="summary">
  <strong>${doneItems.length}</strong> researched &nbsp;·&nbsp;
  <strong>${stuckItems.length}</strong> stuck
  &nbsp;·&nbsp; Submit to write approved.json and apply to catalog.
</div>
<form id="review-form">

${doneItems.length > 0 ? `
<div class="section-header">Researched Products <span class="badge badge-done">${doneItems.length}</span></div>
${doneItems.map(({ item, catalog }) => renderDoneProduct(item, catalog)).join('')}
` : ''}

${stuckItems.length > 0 ? `
<div class="section-header">Stuck Products <span class="badge badge-stuck">${stuckItems.length}</span></div>
${stuckItems.map(({ item, catalog }) => renderStuckProduct(item, catalog)).join('')}
` : ''}

<div class="submit-bar">
  <button type="submit">Submit &amp; Apply to Catalog</button>
</div>
</form>

<script>
const output = ${JSON.stringify(output)};
const singleVideo = ${singleVideo};

document.getElementById('review-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const approved = buildApproved();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const resp = await fetch('/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(approved),
    });
    const data = await resp.json();
    if (data.ok) {
      btn.textContent = 'Done! Catalog updated.';
      btn.style.background = '#1565c0';
    } else {
      btn.textContent = 'Error: ' + data.error;
      btn.disabled = false;
    }
  } catch (err) {
    btn.textContent = 'Network error: ' + err.message;
    btn.disabled = false;
  }
});

function buildApproved() {
  const items = [];
  for (const r of output) {
    const id = r.id;
    if (r.status === 'done') {
      const acceptDesc = !!document.querySelector(\`input[name="accept-desc-\${id}"]\`)?.checked;
      const descEn = document.querySelector(\`textarea[name="desc-\${id}"]\`)?.value || '';
      const primaryImage = document.querySelector(\`input[name="primary-\${id}"]:checked\`)?.value || '';
      const acceptImages = [...document.querySelectorAll(\`input[name="img-\${id}"][type=checkbox]\`)].filter(cb => cb.checked).map(cb => cb.value);
      const acceptYoutubeIds = singleVideo
        ? (() => { const r = document.querySelector(\`input[name="yt-\${id}"]:checked\`); return r ? [r.value] : []; })()
        : [...document.querySelectorAll(\`input[name="yt-\${id}"][type=checkbox]:checked\`)].map(cb => cb.value);
      const acceptBrochure = !!document.querySelector(\`input[name="brochure-\${id}"]\`)?.checked;
      items.push({
        id,
        action: 'update',
        acceptDesc,
        descEn,
        primaryImage,
        acceptImages,
        acceptYoutubeIds,
        acceptBrochure,
        brochureUrl: r.brochureUrl || '',
        manufacturerProductUrl: r.manufacturerProductUrl || '',
      });
    } else {
      // stuck
      const action = document.querySelector(\`input[name="stuck-action-\${id}"]:checked\`)?.value || 'skip';
      const retryUrl = action === 'retry' ? (document.querySelector(\`input[name="retry-url-\${id}"]\`)?.value || '') : '';
      items.push({ id, action, retryUrl });
    }
  }
  return items;
}
</script>
</body>
</html>`;
}

function renderDoneProduct(item, catalog) {
  const id = item.id;
  const hasDesc = item.descEn && item.descEn.trim();
  const hasImages = item.images && item.images.length > 0;
  const allYtIds = [...new Set([
    ...(catalog.youtubeId ? [catalog.youtubeId] : []),
    ...(item.youtubeIds || []),
  ])];
  const hasYt = allYtIds.length > 0;
  const hasBrochure = item.brochureUrl && item.brochureUrl.trim();
  const existingImgs = catalog.image
    ? [catalog.image, ...(catalog.images || [])]
    : (catalog.images || []);
  const hasAnyImages = hasImages || existingImgs.length > 0;

  return `
<div class="product" id="product-${id}">
  <div class="product-header">
    <h2>${escHtml(catalog.nameEn || item.id)} <span class="badge badge-done">done</span></h2>
    <span class="manufacturer">${escHtml(catalog.manufacturer || '')}</span>
    ${item.manufacturerProductUrl ? `<a class="url" href="${escHtml(item.manufacturerProductUrl)}" target="_blank">${escHtml(item.manufacturerProductUrl)}</a>` : ''}
  </div>
  <div class="product-body">

  ${hasDesc ? `
  <div class="field">
    <label>
      <input type="checkbox" name="accept-desc-${id}" checked>
      Accept description
    </label>
    <textarea name="desc-${id}" rows="6">${escHtml(item.descEn)}</textarea>
  </div>` : catalog.descEn ? `
  <div class="field">
    <label style="color:#888">Current description (unchanged)</label>
    <textarea rows="6" disabled style="background:#f9f9f9;color:#555;resize:vertical;width:100%;padding:.5rem;border:1px solid #ddd;border-radius:4px;font-size:.9rem;line-height:1.5">${escHtml(catalog.descEn)}</textarea>
  </div>` : ''}

  ${hasAnyImages ? (() => {
    const newImgs = item.images || [];
    const allImgs = [
      ...existingImgs.map(url => ({ url, isExisting: true })),
      ...newImgs.map(url => ({ url, isExisting: false })),
    ];
    const firstUrl = allImgs[0]?.url || '';
    return `
  <div class="field">
    <label>Product images — <span style="font-weight:normal;color:#555">radio = primary (01), checkbox = include</span></label>
    <div class="images-grid" id="imgrid-${id}">
      ${allImgs.map(({ url, isExisting }, i) => {
        const displaySrc = url.startsWith('file://') ? (localFileToHttpPath(url) || url) : url;
        return `
      <div class="img-item">
        <img src="${escHtml(displaySrc)}" title="${escHtml(url)}">
        <div style="display:flex;align-items:center;gap:.3rem;justify-content:center">
          <input type="radio" name="primary-${id}" value="${escHtml(url)}"${i === 0 ? ' checked' : ''} title="Set as primary">
          <input type="checkbox" name="img-${id}" value="${escHtml(url)}"${isExisting ? ' checked' : ''}>
        </div>
        <label style="color:${isExisting ? '#888' : '#1a6e1a'}">${escHtml(url.split('/').slice(-1)[0])}</label>
      </div>`;
      }).join('')}
    </div>
    <script>
      (function() {
        const grid = document.getElementById('imgrid-${id}');
        grid.querySelectorAll('input[type=radio]').forEach(r => {
          r.addEventListener('change', () => {
            const cb = r.closest('.img-item').querySelector('input[type=checkbox]');
            if (cb) cb.checked = true;
          });
        });
      })();
    </script>
  </div>`;
  })() : ''}

  ${hasYt ? `
  <div class="field">
    <label>YouTube video${singleVideo ? ' — select one' : 's — check to accept'}</label>
    ${allYtIds.map((vid, i) => {
      const isExisting = vid === catalog.youtubeId;
      const inputEl = singleVideo
        ? `<input type="radio" name="yt-${id}" value="${escHtml(vid)}"${i === 0 ? ' checked' : ''}>`
        : `<input type="checkbox" name="yt-${id}" value="${escHtml(vid)}"${isExisting ? ' checked' : ''}>`;
      return `
    <div class="yt-item">
      ${inputEl}
      <img class="yt-preview" src="https://img.youtube.com/vi/${escHtml(vid)}/mqdefault.jpg" alt="${escHtml(vid)}">
      <span style="color:${isExisting ? '#888' : '#1a6e1a'}">${escHtml(vid)}${isExisting ? ' (current)' : ' (new)'}</span>
    </div>`;
    }).join('')}
  </div>` : ''}

  ${hasBrochure ? `
  <div class="field">
    <label>
      <input type="checkbox" name="brochure-${id}" checked>
      Accept brochure PDF
    </label>
    <div><a href="${escHtml(item.brochureUrl)}" target="_blank">${escHtml(item.brochureUrl)}</a></div>
  </div>` : ''}

  ${!hasDesc && !hasImages && !hasYt && !hasBrochure ? `<p style="color:#888;font-style:italic">No new content found.</p>` : ''}

  </div>
</div>`;
}

function renderStuckProduct(item, catalog) {
  const id = item.id;
  return `
<div class="stuck-product" id="product-${id}">
  <div class="product-header">
    <h2>${escHtml(catalog.nameEn || item.id)} <span class="badge badge-stuck">stuck</span></h2>
    <span class="manufacturer">${escHtml(catalog.manufacturer || '')}</span>
  </div>
  <div class="stuck-reason">${escHtml(item.stuckReason || 'No reason given')}</div>
  <div class="stuck-actions">
    <label>
      <input type="radio" name="stuck-action-${id}" value="retry" checked>
      Provide URL for next run:
      <input type="text" name="retry-url-${id}" placeholder="https://..." style="width:320px">
    </label>
    <label>
      <input type="radio" name="stuck-action-${id}" value="local-page">
      Use local page (save page as <code>local_pages/${id}.html</code> in Chrome first)
    </label>
    <label>
      <input type="radio" name="stuck-action-${id}" value="skip">
      Skip (leave as-is in catalog)
    </label>
    <label>
      <input type="radio" name="stuck-action-${id}" value="remove">
      Remove from catalog
    </label>
  </div>
</div>`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── HTTP server ─────────────────────────────────────────────────────────────
import { createReadStream } from 'fs';
import { extname } from 'path';

const MIME = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' };

const LOCAL_PAGES_DIR = resolve(__dirname, 'local_pages');

// Convert a file:// URL from output.json to a /local-pages/ HTTP path for the review UI.
function localFileToHttpPath(fileUrl) {
  // fileUrl is like file:///abs/path/to/local_pages/foo_files/img.jpg
  const abs = fileUrl.replace(/^file:\/\//, '');
  if (!abs.startsWith(LOCAL_PAGES_DIR)) return null;
  return '/local-pages/' + abs.slice(LOCAL_PAGES_DIR.length + 1);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildHtml());
    return;
  }

  // Serve local saved-page assets (images from local_pages/*_files/)
  if (req.method === 'GET' && req.url.startsWith('/local-pages/')) {
    const filePath = resolve(LOCAL_PAGES_DIR, decodeURIComponent(req.url.slice('/local-pages/'.length)));
    const mime = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    const stream = createReadStream(filePath);
    stream.on('error', () => { res.writeHead(404); res.end(); });
    stream.on('open', () => res.writeHead(200, { 'Content-Type': mime }));
    stream.pipe(res);
    return;
  }

  // Serve catalog static images from the website directory
  if (req.method === 'GET' && req.url.startsWith('/img/')) {
    const filePath = resolve(WEBSITE_DIR, req.url.slice(1));
    const mime = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    const stream = createReadStream(filePath);
    stream.on('error', () => { res.writeHead(404); res.end(); });
    stream.on('open', () => res.writeHead(200, { 'Content-Type': mime }));
    stream.pipe(res);
    return;
  }

  if (req.method === 'POST' && req.url === '/submit') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const approved = JSON.parse(body);
        writeFileSync(APPROVED_JSON, JSON.stringify(approved, null, 2));
        console.log(`Wrote approved.json (${approved.length} items)`);

        // Apply to catalog
        try {
          const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '.env');
          execFileSync(process.execPath, ['--env-file=' + envFile, WRITE_CATALOG], { stdio: 'inherit' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          console.error('write-catalog.js failed:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON: ' + err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Review UI: http://localhost:${PORT}`);
  console.log('Open in browser, review, then click Submit.');
});
