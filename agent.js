#!/usr/bin/env node
// Research agent — reads input.json, researches each product, writes output.json.
// Strategy:
//   1. web_search (built-in) → find product URL
//   2. web_fetch (built-in) → read the page
//   3. Haiku → extract catalog content
//   4. Playwright fallback if web_fetch returns empty/blocked
// Safe to interrupt and restart; completed IDs are skipped.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const customerIdx = args.indexOf('--customer');
const customer = customerIdx !== -1 ? args[customerIdx + 1] : null;
const maxRoundsIdx = args.indexOf('--max-rounds');
const MAX_PLAYWRIGHT_ROUNDS = maxRoundsIdx !== -1 ? parseInt(args[maxRoundsIdx + 1]) : 12;

if (!customer) {
  console.error('Usage: node agent.js --customer <slug>');
  process.exit(1);
}

const CUSTOMER_DIR = resolve(__dirname, 'customers', customer);
const INPUT_JSON = resolve(CUSTOMER_DIR, 'input.json');
const OUTPUT_JSON = resolve(CUSTOMER_DIR, 'output.json');

if (!existsSync(INPUT_JSON)) {
  console.error(`input.json not found. Run: node customers/${customer}/read-catalog.js first`);
  process.exit(1);
}

const input = JSON.parse(readFileSync(INPUT_JSON, 'utf8'));

let output = [];
if (existsSync(OUTPUT_JSON)) {
  output = JSON.parse(readFileSync(OUTPUT_JSON, 'utf8'));
}
const completedIds = new Set(output.filter(r => r.status === 'done').map(r => r.id));

const client = new Anthropic();

// ── Rate-limit-aware API wrapper ──────────────────────────────────────────────
async function callWithRetry(params, maxRetries = 6) {
  let delay = 15000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      const is429 = err.status === 429 || (err.message && err.message.includes('rate_limit'));
      if (is429 && attempt < maxRetries) {
        const retryAfter = err.headers?.['retry-after'];
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : delay;
        process.stdout.write(`\n  [rate limit] waiting ${Math.round(waitMs / 1000)}s ... `);
        await new Promise(r => setTimeout(r, waitMs));
        delay = Math.min(delay * 2, 60000);
        continue;
      }
      throw err;
    }
  }
}

// ── Extraction prompt ─────────────────────────────────────────────────────────
// Static portion — passed as a cached system prompt in the Playwright path.
const EXTRACTION_SYSTEM_PROMPT = `You are a B2B catalog research agent. Navigate manufacturer product pages and extract structured catalog content.

Extract the following fields:
- descEn: Depends on whether this is a product line/series or a single product (see isLine below).
  - Single product (isLine: false): 1–2 short paragraphs, 2–4 sentences each. Lead with what it does and its key specs. No bullet lists, no marketing fluff, no fabricated specs. Match this style: "The Madvac LR50 is a robust all-terrain litter vacuum with an enclosed cab, engineered for efficient debris collection in urban and off-road settings. Its 6-function robotic joystick and 15-foot retractable wander hose eliminate manual labor while prioritizing operator safety and comfort."
  - Product line/series (isLine: true): Open with 2–3 sentences describing what the line is good for and its shared capabilities. Follow with a short list of each individual model in the line — one line per model, format: "Model Name — key differentiator (e.g. cleaning width, power source, capacity)". Include all models found on the page. No fabricated specs.
  Set to "" if descriptionNeeded is false.
- images: absolute URLs of high-quality product images (JPG/PNG/WebP). 3–6 shots. No thumbnails/icons/logos. For a product line, prefer images that show multiple models or the family shot if available.
- youtubeIds: 11-character YouTube video IDs (from ?v= or /embed/ URLs).
- brochureUrl: URL of a downloadable PDF brochure/datasheet. Set to "" if brochureNeeded is false. PDF links are often JavaScript-triggered with empty or "#" href — if you see a "PDF Brochure", "Datasheet", or similar button/link, click it with browser_click, then take a snapshot to capture the resulting URL from the page or address bar. Do not skip a brochure just because the href is empty.
- manufacturerProductUrl: the URL this content came from.

Respond with ONLY valid JSON, no markdown:
{"status":"done","manufacturerProductUrl":"","descEn":"","images":[],"youtubeIds":[],"brochureUrl":""}

If the page has no useful product content, use status "stuck" and add "stuckReason".`;

function isLineItem(item) {
  return item.id.endsWith('-line') || item.id.endsWith('-series');
}

// Per-item user message — only the variables that differ per product.
function extractionPrompt(item) {
  return `Extract catalog content for this product:

Product: ${item.manufacturer} ${item.name} (id: ${item.id})
isLine: ${isLineItem(item)}
descriptionNeeded: ${item.descriptionNeeded}
brochureNeeded: ${item.brochureNeeded}`;
}

// Truncate old snapshot results in message history to keep context small.
// The latest snapshot stays full; all earlier ones are cut to 500 chars.
function truncateOldSnapshots(messages) {
  let lastSnapshotIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      if (msg.content.some(b => b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 500)) {
        lastSnapshotIdx = i;
        break;
      }
    }
  }
  for (let i = 0; i < messages.length; i++) {
    if (i === lastSnapshotIdx) continue;
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      msg.content = msg.content.map(b => {
        if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 500) {
          return { ...b, content: b.content.slice(0, 500) + '\n[truncated]' };
        }
        return b;
      });
    }
  }
}

// ── Step 1: find product URL via Brave Search API ────────────────────────────
async function findProductUrl(item) {
  if (item.manufacturerProductUrl) {
    console.log(`  [url] using existing: ${item.manufacturerProductUrl}`);
    return item.manufacturerProductUrl;
  }

  console.log(`  [search] ${item.manufacturer} ${item.name}`);

  async function braveSearch(q) {
    const searchUrl = new URL('https://api.search.brave.com/res/v1/web/search');
    searchUrl.searchParams.set('q', q);
    searchUrl.searchParams.set('count', '5');
    const res = await fetch(searchUrl, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': process.env.BRAVE_API_KEY,
      },
    });
    if (!res.ok) throw new Error(`Brave API ${res.status}`);
    return (await res.json()).web?.results || [];
  }

  try {
    let manufacturerDomain;
    let fallbackUrl;

    if (item.manufacturerBaseUrl) {
      manufacturerDomain = new URL(item.manufacturerBaseUrl).hostname.replace(/^www\./, '');
      fallbackUrl = item.manufacturerBaseUrl;
      console.log(`  [search] domain: ${manufacturerDomain} (from manufacturerBaseUrl)`);
    } else {
      // Search 1: broad query to find the manufacturer's domain
      const broadResults = await braveSearch(`${item.manufacturer} official website`);
      const manufacturerSlug = item.manufacturer.toLowerCase().replace(/[^a-z0-9]/g, '');
      const manufacturerResult = broadResults.find(r => {
        const host = new URL(r.url).hostname.replace(/^www\./, '');
        return manufacturerSlug.slice(0, -1).split('').every(c => host.includes(c)) &&
               !host.includes('wikipedia') && !host.includes('linkedin');
      }) || broadResults[0];

      if (!manufacturerResult) {
        console.log(`  [search] no manufacturer domain found`);
        return null;
      }

      manufacturerDomain = new URL(manufacturerResult.url).hostname.replace(/^www\./, '');
      fallbackUrl = manufacturerResult.url;
      console.log(`  [search] domain: ${manufacturerDomain}`);
    }

    // Site-scoped query to get the exact product page
    const siteResults = await braveSearch(`site:${manufacturerDomain} ${item.name}`);
    if (siteResults.length === 0) {
      console.log(`  [search] no product page found — using fallback: ${fallbackUrl}`);
      return fallbackUrl;
    }

    const productUrl = siteResults[0].url;
    const isHomepage = new URL(productUrl).pathname.replace(/\/$/, '') === '';
    if (isHomepage) {
      console.log(`  [search] top result is homepage — using fallback: ${fallbackUrl}`);
      return fallbackUrl;
    }

    console.log(`  [search] → ${productUrl}`);
    return productUrl;
  } catch (err) {
    console.log(`  [search] error: ${err.message}`);
    return null;
  }
}

// ── Step 2: fetch page and extract via web_fetch ──────────────────────────────
async function fetchAndExtract(item, url) {
  console.log(`  [fetch] ${url}`);

  const response = await callWithRetry({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 1 }],
    messages: [{
      role: 'user',
      content: `Fetch this URL and extract the catalog content.\n\nURL: ${url}\n\n${extractionPrompt(item)}`,
    }],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text).join('').trim()
    .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    const result = JSON.parse(text);
    result.id = item.id;
    if (result.status === 'stuck') {
      console.log(`  [fetch] page unusable: ${result.stuckReason?.slice(0, 80)}`);
      return null;
    }
    return result;
  } catch {
    console.log(`  [fetch] non-JSON response — falling back to Playwright`);
    return null;
  }
}

// ── Step 3: Playwright fallback ───────────────────────────────────────────────
function isCloudflareBlock(snapshotText) {
  return snapshotText.includes('Performing security verification') ||
    (snapshotText.includes('Ray ID:') && snapshotText.includes('Cloudflare'));
}

// In-process Playwright client using rebrowser-playwright.
// Exposes the same connect/callTool/close interface as the old MCP subprocess client,
// and the same tools[] schema that the Claude API tool_use loop expects.
class PlaywrightClient {
  constructor() {
    this.browser = null;
    this.page = null;
    this.started = false;
    this.tools = [
      {
        name: 'browser_navigate',
        description: 'Navigate to a URL',
        input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
      {
        name: 'browser_snapshot',
        description: 'Capture the current page as accessible text (aria snapshot)',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'browser_click',
        description: 'Click an element on the page',
        input_schema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' } } },
      },
      {
        name: 'browser_navigate_back',
        description: 'Navigate back in browser history',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'browser_wait_for',
        description: 'Wait for a condition or timeout',
        input_schema: { type: 'object', properties: { time: { type: 'number' }, text: { type: 'string' } } },
      },
      {
        name: 'browser_evaluate',
        description: 'Execute JavaScript in the browser context',
        input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
      },
    ];
  }

  async connect() {
    if (this.started) return;
    this.started = true;
    const _require = createRequire(import.meta.url);
    const { chromium } = _require('rebrowser-playwright');
    this.browser = await chromium.launch({ headless: true });
    const ctx = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    this.page = await ctx.newPage();
    console.log(`  [playwright] started (rebrowser, headless) (${this.tools.length} tools)`);
  }

  async callTool(name, args) {
    const page = this.page;
    switch (name) {
      case 'browser_navigate': {
        const url = args.url.startsWith('/') ? `file://${args.url}` : args.url;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return `Navigated to ${url}`;
      }
      case 'browser_snapshot': {
        // Return page text content as a lightweight snapshot
        const url = page.url();
        const title = await page.title();
        const text = await page.evaluate(() => document.body?.innerText || '');
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]'))
            .map(a => `[${a.textContent.trim().slice(0, 60)}](${a.href})`)
            .filter(Boolean).slice(0, 80).join('\n')
        );
        const imgs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('img[src]'))
            .map(i => i.src).filter(s => /\.(jpg|jpeg|png|webp)/i.test(s)).slice(0, 20).join('\n')
        );
        return `URL: ${url}\nTitle: ${title}\n\n--- TEXT ---\n${text.slice(0, 8000)}\n\n--- LINKS ---\n${links}\n\n--- IMAGES ---\n${imgs}`;
      }
      case 'browser_click': {
        const sel = args.selector || args.ref;
        if (!sel) return 'Error: no selector provided';
        try {
          await page.click(sel, { timeout: 10000 });
          await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
          return `Clicked ${sel}`;
        } catch (e) {
          // Try text-based click as fallback
          try {
            await page.getByText(sel, { exact: false }).first().click({ timeout: 5000 });
            return `Clicked text: ${sel}`;
          } catch {
            return `Error clicking ${sel}: ${e.message}`;
          }
        }
      }
      case 'browser_navigate_back': {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        return 'Navigated back';
      }
      case 'browser_wait_for': {
        if (args.time) {
          await page.waitForTimeout(args.time * 1000);
          return `Waited ${args.time}s`;
        }
        if (args.text) {
          await page.waitForSelector(`text=${args.text}`, { timeout: 15000 }).catch(() => {});
          return `Waited for text: ${args.text}`;
        }
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        return 'Waited for network idle';
      }
      case 'browser_evaluate': {
        const result = await page.evaluate(args.expression);
        return String(result);
      }
      default:
        return `Unknown tool: ${name}`;
    }
  }

  async close() {
    if (this.browser) await this.browser.close().catch(() => {});
  }
}

async function researchViaPlaywright(item, url, mcp) {
  if (!url) return stuckResult(item, 'No product URL — search and fetch both failed');
  await mcp.connect();
  console.log(`  [playwright] navigating to ${url}`);

  const isLocal = url.startsWith('file://');
  const tools = isLocal ? mcp.tools.filter(t => t.name !== 'browser_navigate') : mcp.tools;

  // For local pages, navigate and snapshot before entering the tool loop so the
  // model starts with page content already in context — browser_navigate is not
  // in its tool list so it can't do this itself.
  let initialContext = '';
  if (isLocal) {
    try {
      await mcp.callTool('browser_navigate', { url });
      initialContext = await mcp.callTool('browser_snapshot', {});
    } catch (err) {
      return stuckResult(item, `Failed to load local page: ${err.message}`);
    }
  }

  const messages = [{
    role: 'user',
    content: isLocal
      ? `Here is the saved local page for this product. Extract the catalog content from it.\n\n${extractionPrompt(item)}\n\n--- PAGE CONTENT ---\n${initialContext}`
      : `Navigate to ${url} and extract the catalog content.\n\n${extractionPrompt(item)}`,
  }];
  let rounds = 0;
  let cfStrikes = 0;

  while (true) {
    if (rounds > 0) truncateOldSnapshots(messages);
    const response = await callWithRetry({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: [{ type: 'text', text: EXTRACTION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools,
      messages,
    });

    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const textBlocks = response.content.filter(b => b.type === 'text');

    if (response.stop_reason === 'end_turn') {
      const text = textBlocks.map(b => b.text).join('').trim();
      // Try to find a JSON object anywhere in the response
      const jsonMatch = text.match(/\{[\s\S]*"status"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const result = JSON.parse(jsonMatch[0]);
          result.id = item.id;
          return result;
        } catch { /* fall through */ }
      }
      // Model finished browsing but didn't output JSON — ask explicitly
      if (rounds > 0) {
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: 'Output ONLY the JSON result now. No explanation, no markdown.' });
        rounds++;
        continue;
      }
      return stuckResult(item, `Playwright non-JSON: ${text.slice(0, 100)}`);
    }

    if (response.stop_reason === 'tool_use' && toolUseBlocks.length > 0) {
      rounds++;
      messages.push({ role: 'assistant', content: response.content });
      const toolResults = [];
      for (const block of toolUseBlocks) {
        const desc = block.input?.url || block.input?.selector || '';
        console.log(`    → ${block.name}${desc ? ': ' + String(desc).slice(0, 80) : ''}`);
        let content;
        try { content = await mcp.callTool(block.name, block.input); }
        catch (err) { content = `Error: ${err.message}`; }
        // After navigation, proactively snapshot to detect Cloudflare before the model loops.
        if (block.name === 'browser_navigate') {
          try {
            const snap = await mcp.callTool('browser_snapshot', {});
            content = snap; // replace navigate result with snapshot so model has page context
          } catch { /* ignore — proceed with original navigate result */ }
        }

        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });

        if (isCloudflareBlock(content)) {
          cfStrikes++;
          console.log(`    [cloudflare] challenge page detected (strike ${cfStrikes}/3)`);
          if (cfStrikes >= 3) {
            return stuckResult(item, 'Cloudflare bot check — blocked after 3 attempts');
          }
        } else {
          cfStrikes = 0;
        }
      }
      messages.push({ role: 'user', content: toolResults });
      if (rounds >= MAX_PLAYWRIGHT_ROUNDS) {
        // Ask the model to emit whatever it has gathered so far rather than discarding.
        messages.push({ role: 'user', content: 'You have reached the tool call limit. Output the best JSON result you can from what you have gathered so far. ONLY valid JSON, no markdown, no explanation.' });
        const finalResponse = await callWithRetry({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          system: [{ type: 'text', text: EXTRACTION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          tools,
          tool_choice: { type: 'none' },
          messages,
        });
        const finalText = finalResponse.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
        const jsonMatch = finalText.match(/\{[\s\S]*"status"[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const result = JSON.parse(jsonMatch[0]);
            result.id = item.id;
            return result;
          } catch { /* fall through */ }
        }
        return stuckResult(item, 'Exceeded 12 Playwright rounds');
      }
      continue;
    }

    return stuckResult(item, `Unexpected stop_reason: ${response.stop_reason}`);
  }
}

function stuckResult(item, reason) {
  return { id: item.id, status: 'stuck', manufacturerProductUrl: item.manufacturerProductUrl || '', descEn: '', images: [], youtubeIds: [], brochureUrl: '', stuckReason: reason };
}

function saveOutput() {
  writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Customer: ${customer}`);
  console.log(`Products: ${input.length}, completed: ${completedIds.size}`);

  const pending = input.filter(item => !completedIds.has(item.id));
  console.log(`Pending: ${pending.length}\n`);

  if (pending.length === 0) {
    console.log('Nothing to do. Run: node review-server.js --customer ' + customer);
    process.exit(0);
  }

  const mcp = new PlaywrightClient();
  let doneCount = 0, stuckCount = 0;

  for (let i = 0; i < pending.length; i++) {
    const prev = output.find(r => r.id === pending[i].id);
    const item = prev?.manufacturerProductUrl
      ? { ...pending[i], manufacturerProductUrl: prev.manufacturerProductUrl }
      : pending[i];
    console.log(`[${i + 1}/${pending.length}] ${item.manufacturer} — ${item.name}`);

    try {
      const localPage = ['html', 'htm'].map(ext => resolve(__dirname, 'local_pages', `${item.id}.${ext}`)).find(existsSync);
      if (localPage) {
        console.log(`  [local] using saved page: ${localPage}`);
        const result = await researchViaPlaywright(item, `file://${localPage}`, mcp);
        const existingIdx = output.findIndex(r => r.id === result.id);
        if (existingIdx !== -1) output[existingIdx] = result; else output.push(result);
        saveOutput();
        result.status === 'done' ? doneCount++ : stuckCount++;
        console.log(`  → ${result.status}${result.status === 'stuck' ? ': ' + result.stuckReason : ''}\n`);
        continue;
      }

      const url = await findProductUrl(item);
      // Skip fetch when the URL was pre-supplied — go straight to Playwright.
      const skipFetch = !!item.manufacturerProductUrl;
      let result = (!skipFetch && url) ? await fetchAndExtract(item, url) : null;

      if (result) {
        console.log(`  [done] via web_search + web_fetch`);
      } else {
        if (skipFetch) console.log(`  [playwright] URL pre-supplied, skipping fetch`);
        else console.log(`  [fallback] trying Playwright`);
        result = await researchViaPlaywright(item, url, mcp);
      }

      const existingIdx = output.findIndex(r => r.id === result.id);
      if (existingIdx !== -1) output[existingIdx] = result; else output.push(result);
      saveOutput();
      result.status === 'done' ? doneCount++ : stuckCount++;
      console.log(`  → ${result.status}${result.status === 'stuck' ? ': ' + result.stuckReason : ''}\n`);
    } catch (err) {
      stuckCount++;
      console.log(`  → ERROR: ${err.message}\n`);
      const errResult = stuckResult(item, `Error: ${err.message}`);
      const existingIdx = output.findIndex(r => r.id === item.id);
      if (existingIdx !== -1) output[existingIdx] = errResult; else output.push(errResult);
      saveOutput();
    }
  }

  if (mcp.started) await mcp.close();

  console.log(`Done: ${doneCount} succeeded, ${stuckCount} stuck.`);
  console.log(`Next: node review-server.js --customer ${customer}`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
