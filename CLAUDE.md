# CLAUDE.md — browser-research-agent

## What This Is

A general-purpose CLI agent that researches a list of items via a real browser, extracts structured data from each item's web page, and **pauses to ask the user for help when it gets stuck** — rather than silently failing or hallucinating. Built with the Claude API and Playwright MCP.

The canonical use case (and the worked example in the README) is product description research for equipment distributors: given a list of products, find each manufacturer's product page, extract a clean B2B description, and collect any downloadable PDF brochures.

---

## Why This Exists

Raw HTTP fetch-based scrapers fail constantly on modern manufacturer sites:
- JavaScript-rendered pages return empty shells
- CDNs and WAFs return 403 on automated HTTP clients
- TLS cert issues block connections outright
- Product pages move, get renamed, or get discontinued

Running a real browser (Playwright) solves the rendering problem. The human-in-the-loop pattern solves the "where is this product page?" problem — the agent knows when it's lost and asks instead of guessing.

---

## Architecture

```
browser-research-agent/
├── CLAUDE.md               # this file
├── README.md               # setup, usage, walkthrough
├── package.json
├── agent.js                # main entry point
├── prompts/
│   └── research.txt        # system prompt injected into the agent
├── examples/
│   └── sweep-and-vac/
│       ├── input.json      # 26 products needing descriptions
│       └── output-schema.json
└── .claude/
    └── settings.json       # MCP server config (Playwright)
```

---

## Tech Stack

- **Runtime:** Node.js 20+
- **Claude API:** `@anthropic-ai/sdk` — model `claude-sonnet-4-6` (balance of speed and quality for research tasks)
- **Browser:** `@playwright/mcp` — Playwright MCP server; the agent controls a real Chromium browser via MCP tool calls
- **No build tools** — plain Node.js, no TypeScript, no bundler

---

## Core Agent Loop

For each item in `input.json`:

1. If `knownUrl` is present on the item, navigate there first
2. Otherwise, search for the official product page via browser
3. Extract structured output per `output-schema.json`
4. Also check the page for downloadable PDF brochures — record URL if found
5. **If stuck after 2 attempts** (404, blocked, JS wall, no results): stop and prompt the user:
   ```
   [STUCK] Can't find page for "Model X" (Manufacturer Y).
   Paste a URL, type "skip", or type "quit":
   ```
6. Accept user input inline (readline), then resume, skip, or exit
7. Write each completed result to `output.json` immediately (partial runs are preserved)

The agent must not fabricate product specifications. If it cannot find a page, it asks.

---

## Input / Output Format

### input.json
```json
[
  {
    "id": "product-slug",
    "name": "Product Display Name",
    "manufacturer": "Brand Name",
    "knownUrl": "https://... (optional — skip search if provided)"
  }
]
```

### output.json (one entry per product)
```json
[
  {
    "id": "product-slug",
    "descEn": "English description (2–3 paragraphs)",
    "descEs": "Spanish translation",
    "descFr": "French translation",
    "source": "https://url-where-content-was-found",
    "brochureUrl": "https://... (omit if none found)",
    "status": "done | skipped | stuck"
  }
]
```

---

## The Sweep & Vac Example

The `examples/sweep-and-vac/` directory contains the real input that motivated this tool: 26 products from [sweepandvac.com](https://sweepandvac.com) that need manufacturer copy.

These products had their descriptions blocked on a prior WebFetch-based research run due to 403s, JS rendering, TLS errors, and discontinued/reorganized catalog pages.

After running the agent, the output is reviewed and applied to `js/products.js` in the main website repo (`../website/`).

---

## Prompting Notes for Claude Code

- The agent runs interactively — do not background it
- When the agent hits the `[STUCK]` prompt, you (the human) respond inline in the terminal
- Useful responses: a direct URL, `skip` (moves to next product), `quit` (saves progress and exits)
- The agent translates to ES and FR itself — do not pre-translate the input
- Output is written incrementally, so if the run is interrupted, restart with the same input and it will skip already-completed IDs

---

## Development Notes

- Keep `agent.js` simple — the complexity lives in the system prompt (`prompts/research.txt`) and the MCP tool loop
- The stuck-detection threshold (2 attempts) is configurable via `--max-attempts` flag
- Do not add retry logic that masks failures — the point is that the human resolves ambiguity, not the agent
- All user-facing strings in the CLI should be clear and non-technical; the end user may be a non-developer running this to populate a product catalog
