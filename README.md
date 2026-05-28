# browser-research-agent

Populates a product distributor's catalog by researching each product on the manufacturer's website. Uses a real browser (Playwright) to handle JS-rendered pages, CDN blocks, and TLS issues that defeat raw HTTP scrapers.

---

## Prerequisites

- Node.js 20+
- A `.env` file in the project root (copy from `.env.example` or create manually):

```
ANTHROPIC_API_KEY=sk-ant-...
BRAVE_API_KEY=BSA...
```

Install dependencies:

```
npm install
```

---

## Usage — Sweep & Vac

Run these four steps in order. Each step is safe to re-run.

### Step 1 — Generate input

Reads the current catalog, analyzes each product, writes `customers/sweep-and-vac/input.json`. By default includes all products. Use one filter flag to scope the run:

```
npm run read
# or with a filter (mutually exclusive — pick at most one):
npm run read -- --manufacturer Madvac
npm run read -- --category aspiradoras
npm run read -- --id lp61g
```

Every product in the filtered set is included — even products that already have descriptions or brochures — so you can force a re-research without manually clearing existing data.

### Step 2 — Research

For each product in `input.json`, finds the manufacturer page, extracts description, images, brochure PDF, and YouTube video. Writes results to `customers/sweep-and-vac/output.json` incrementally — safe to interrupt and restart.

```
npm run agent
# or
node --env-file=.env agent.js --customer sweep-and-vac
```

Options:
- `--max-attempts N` — number of attempts before marking a product stuck (default: 2)

Tail output in another terminal:

```
tail -f /tmp/agent-run.log
```

To run in the background and tail:

```
node --env-file=.env agent.js --customer sweep-and-vac > /tmp/agent-run.log 2>&1 &
tail -f /tmp/agent-run.log
```

To restart a partial run (clears previous output):

```
echo "[]" > customers/sweep-and-vac/output.json && npm run agent
```

### Step 3 — Review

Serves a local review UI at `http://localhost:3001`. Shows only new or changed fields — not the full catalog.

```
npm run review
# or
node --env-file=.env review-server.js --customer sweep-and-vac
```

Options:
- `--port N` — override default port 3001

**For each researched product the UI shows:**
- Current description (read-only if unchanged; editable textarea if new)
- All images — existing catalog images and any new images found — each with a radio to set the primary (01) and a checkbox to include
- YouTube video — radio selection (S&V supports one video per product)
- Brochure PDF link with accept checkbox

**For each stuck product:**
- Paste a direct URL to retry on next run, or skip, or remove from catalog

Click **Submit & Apply to Catalog** when done. This writes `approved.json` and immediately runs `write-catalog.js`.

### Step 4 — Apply (called automatically by Step 3)

Can also be run manually if needed:

```
npm run write
# or
node --env-file=.env customers/sweep-and-vac/write-catalog.js
```

What it does:
- Updates `descEn` and auto-generates `descEs` + `descFr` via Claude API
- Downloads accepted images to `img/products/[id]/`, sets `product.image` (primary) and `product.images` (rest)
- Sets `product.youtubeId` to the selected video
- Downloads brochure PDF to `brochures/[id]/brochure.pdf` and adds to `manifest.json`
- Sets `manufacturerProductUrl` if newly discovered
- Removes products flagged for deletion

After applying, run the S&V site build step to pick up the new brochure manifest and converted images:

```
cd "../Sweep and Vac/website" && bash build.sh
```

---

## Customer config

Each customer directory can contain a `config.json` to control behavior:

```json
{
  "singleYoutubeVideo": true
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `singleYoutubeVideo` | `false` | Limit YouTube selection to one video (radio buttons instead of checkboxes) |

---

## File layout

```
browser-research-agent/
├── .env                         # API keys (gitignored)
├── agent.js                     # research loop
├── review-server.js             # review UI server
├── customers/
│   └── sweep-and-vac/
│       ├── config.json          # customer-specific settings
│       ├── read-catalog.js      # reads catalog → input.json
│       ├── write-catalog.js     # applies approved.json → catalog
│       ├── input.json           # generated; agent reads this
│       ├── output.json          # written by agent (gitignored)
│       └── approved.json        # written by review UI (gitignored)
└── .claude/
    └── settings.json            # Playwright MCP config
```

## Adding a new customer

1. Create `customers/[slug]/read-catalog.js` — reads the catalog, writes `input.json`
2. Create `customers/[slug]/write-catalog.js` — reads `approved.json`, patches the catalog
3. Optionally create `customers/[slug]/config.json` for customer-specific settings

The agent and review server are catalog-agnostic — they only read/write `input.json`, `output.json`, and `approved.json`.
