# Outlier Research Engine

A research skill that reverse-engineers the **winning homepage structure of any specific niche** by actually scraping the top performers in that niche — not by pattern-matching from training data, not by applying a generic template.

The output is data-driven and niche-specific. A blueprint for "roofers in Dallas" will share almost no sections with a blueprint for "AI coding tools" — and that's the entire point.

---

## What's in this folder

| File | Purpose |
|---|---|
| `SKILL.md` | The skill itself — workflow, archetype taxonomy, search strategy, deliverable spec. This is the active file the agent reads when triggered. A live copy also sits at `~/.claude/skills/site-blueprint/SKILL.md`. |
| `example-output.html` | A sample output (AI coding tools, 9 beats) showing the visual language the skill produces — vertical wireframe blueprint, frequency badges, per-beat cards with winners-include blocks, real example rows, winners-vs-losers contrast, Monday checklist. Open it in a browser. |
| `README.md` | This file. |

---

## How the skill works

When triggered with a niche brief like "site blueprint for roofers in Dallas":

1. **Clarify** — confirm niche + geography + page type + archetype (local-service, B2B SaaS, DTC ecom, marketplace, media, education, or high-ticket pro).
2. **Find contenders** — run 3–5 parallel Firecrawl searches tuned to the archetype. For local-service briefs that includes Google Maps top results, Yelp top-rated, BBB A+. Filter HARD — reject national chains, directory sites, sub-25-review listings.
3. **Scrape** the top 8–10 homepages in parallel + 2–3 underperformers for contrast.
4. **Extract** the section structure of each — top-to-bottom, position by position, with an OPEN taxonomy (invent new section labels when the data shows something new).
5. **Aggregate** into a position-frequency table — the universal sections (8+/10 consensus) ARE the blueprint. Section count varies with the niche.
6. **Ship** a single HTML deliverable to `~/Desktop/site-blueprint-{niche-slug}.html` styled like `example-output.html` but with the niche's real sections, real headlines, and real brand chips.
7. **Report** a terse chat summary with the top 3 surprising findings.

---

## How to trigger the skill

In Claude Code (where the skill is installed), say any of:

- "Site blueprint for [specific niche]"
- "What does a winning [niche] homepage look like"
- "Reverse-engineer the top [trade] in [city]"
- "Research the best [niche] websites and tell me the structure"
- "Analyze the top [niche] landing pages"

Examples that fire it well:
- `site blueprint for roofers in Dallas`
- `reverse-engineer the top wedding photographers in Brooklyn`
- `what does a winning DTC sleep brand homepage look like`
- `research the best AI video editing tool sites`
- `analyze the top boutique gyms in London`

---

## What makes a good brief

| Bad brief | Good brief |
|---|---|
| "Roofers" | "Roofers in Dallas" |
| "Skincare" | "Premium men's skincare DTC brands" |
| "Coaches" | "1-on-1 business coaches charging $5k+/mo" |
| "Photographers" | "Wedding photographers in Brooklyn" |
| "SaaS" | "AI coding tools" |

Geography is half the answer for local-service niches. Specificity is half the answer for everything else.

---

## What the deliverable contains

The output HTML on the Desktop follows the visual language of `example-output.html`:

- **Hero** — eyebrow tag · italic accent headline · standfirst · meta-pill row (sites scraped, sections counted, date)
- **The contenders** — logo grid with real brand chips of every site analyzed, plus a contrast row noting the underperformers
- **The archetype** — one-card framing of why this niche's structure differs from generic landing-page advice
- **The blueprint** — vertical wireframe diagram of the section order with frequency badges per beat (mint = universal, amber = majority, dim = split)
- **Beat by beat** — one card per universal section: mini-wireframe + winners-include checklist + real example rows (logo + verbatim headline from the site) + a "winners vs losers" one-liner
- **Anti-patterns** — a grid of what the bottom performers do that the winners never do
- **Monday checklist** — a binary numbered checklist you can run against your own site today

---

## To install or re-install the skill

The active copy lives at `~/.claude/skills/site-blueprint/SKILL.md`. If you ever delete it, restore by copying this folder's `SKILL.md` back:

```bash
mkdir -p ~/.claude/skills/site-blueprint
cp ~/Desktop/outlier-research-engine/SKILL.md ~/.claude/skills/site-blueprint/SKILL.md
cp ~/Desktop/outlier-research-engine/example-output.html ~/.claude/skills/site-blueprint/reference.html
```

The skill needs the Firecrawl MCP server connected (loads via `ToolSearch({ query: "firecrawl" })` at runtime).

---

## Non-negotiables baked into the skill

1. Structure is derived from data, never imposed from a template.
2. Geography + niche must be specific.
3. Real local sites for local niches (not national chains, not directories).
4. Order matters as much as presence — always report position.
5. Best vs bottom contrast in every beat.
6. Single HTML deliverable on the Desktop.
7. Reference HTML is a VISUAL template only — never copy its section count or labels.
8. No fluff sections.

Built 2026-05-23.
