---
name: site-blueprint
description: Reverse-engineer the winning homepage structure of a SPECIFIC niche by actually scraping the top performers in that niche with Firecrawl. The output is data-driven and niche-specific — never a generic template. Trigger when the user says "site blueprint for [specific niche]", "what does a winning [niche] site look like", "reverse-engineer the top [niche] sites", "research the best [trade] in [city]", "what should my [trade/business] homepage have", "analyze the top [niche] landing pages", or any variant asking for the optimal section order / wireframe of a specific industry's website. Especially fires on LOCAL SERVICE briefs ("roofers in Texas", "plumbers in Phoenix", "wedding photographers in Brooklyn") where geography is half the answer. Pulls 10–15 actual contenders for THAT exact niche via Firecrawl + Google Maps + Yelp + BBB where appropriate, scrapes the winners, derives the structure FROM the data, and ships a niche-specific blueprint HTML on the Desktop. Do NOT trigger for: single-site critiques, copywriting-only requests, or brand-identity work.
---

# Site Blueprint Skill

The user asks for the **winning homepage structure** of a specific niche — like "roofers in Texas", "men's barbershops in London", "wedding photographers in Brooklyn", "newsletter platforms", or "DTC sleep brands". This skill reverse-engineers the structure from the actual top performers in that exact niche.

The output is **niche-specific**: section order, section count, and section content all vary based on what the scrapes actually show. A Texas roofer blueprint should look nothing like a SaaS blueprint, which looks nothing like a DTC supplement brand blueprint. **The whole point of this skill is the per-niche research.** Generic landing-page advice is what it competes against, not what it produces.

---

## Non-negotiables

1. **Structure is derived from data, never imposed from a template.** If 8/10 Texas roofers lead with "Years in Business + License Number" right after the hero, that IS position 2 — even if zero SaaS sites do that. Let the structure emerge from the scrapes. Section count varies — could be 5, could be 14. Let the data decide.

2. **Geography + niche must be SPECIFIC.** "Roofers" is not a niche — "Roofers in Dallas" is. "Skincare" is not a niche — "Premium men's skincare DTC" is. Before running anything, confirm the brief is specific enough to produce a tight contender list.

3. **Real local sites for local niches.** If the brief is a local service business ("plumbers in Phoenix"), the contenders must be ACTUAL Phoenix plumbers — not national chains operating in Phoenix, not directory sites, not generic plumbing-tips blogs. Pull from Google Maps top results, Yelp top-rated, BBB A+ — these surface the real local outliers.

4. **Order matters more than presence.** A trust badge in position 1 is a different message than a trust badge in position 7. Always report the position alongside the section type.

5. **Best vs bottom contrast.** Don't just describe what winners do — call out what losers do that winners don't. Pick 2–3 underperformers (page-3 results, dated template sites, sub-3-star listings) for explicit contrast.

6. **Single HTML deliverable** at `~/Desktop/site-blueprint-{niche-slug}.html`. Long-scroll explainer, dark theme, real brand logos for every named site.

7. **Reference HTML is a visual template, NOT a content template.** `~/.claude/skills/site-blueprint/reference.html` (the AI-coding-tools mock) shows the design language to copy — vertical wireframe, frequency badges, beat cards, winners-vs-losers contrast lines, Monday checklist. **DO NOT copy its 9-beat count, its section labels, or its SaaS examples** into the new deliverable. Build the new deliverable from the actual scraped data.

8. **No fluff sections.** Output section count must match what the data supports.

---

## Workflow

### Step 1 — Clarify the brief (under 30 seconds)

Before running anything, confirm with the user:

1. **Specific niche** — what kind of business + what makes them distinct
2. **Geography** — local (specific city / state), regional, national, or global
3. **Page type** — homepage (default), pricing page, service-detail page, lead-magnet landing page
4. **Archetype** (you infer, the user overrides):

| Archetype | Examples | Primary conversion | Distinct section signals |
|---|---|---|---|
| **Local service business** | Roofers, plumbers, dentists, gyms, salons, landscapers, contractors, HVAC, lawyers, accountants | Phone call, "free quote/estimate" form, book-an-appointment | Phone CTA in hero · License #/BBB/insurance badges · Service-area map · Before/after gallery · Real team photos · Financing offers · Emergency-service banner · Google review widget |
| **B2B SaaS / dev tools** | Cursor, Vercel, Notion, HubSpot | Free trial / signup / book demo | Customer logo strip · Live demo GIF · Feature trio · Pricing tiers · "Used by N developers" stat |
| **DTC ecom** | Skincare, supplements, apparel, home goods | Add to cart / first purchase | Product hero shot · Press logos · Bestseller grid · Ingredient/how-it-works · Star ratings · Subscribe-and-save · UGC gallery |
| **Marketplace** | Airbnb, Etsy, ClassPass | Two-sided signup | Search bar in hero · Category tiles · Featured listings · Host/seller CTA strip · Trust & safety section |
| **Media / creator** | Newsletters, podcasts, niche publications | Newsletter signup, paid subscription | Email capture in hero · "As featured in" · Subscriber count · Sample issue/episode · Author bio |
| **Education** | Course platforms, cohort courses, bootcamps | Enrollment, lead magnet, application | Outcome H1 + cohort dates · Curriculum module list · Instructor credentials · Student-outcome stats · Apply/enroll CTA |
| **High-ticket professional** | Coaches, consultants, agencies | Discovery-call booking | Founder-to-camera video · Case studies with revenue impact · "Who this is for" filter · Calendly embed · Long-form sales-page sections |

**The archetype shapes the optimal structure FIRST**, then the per-niche scrapes refine it. A local roofer hero has a phone number; a SaaS hero has a "start free trial" button. The archetype decision drives the search strategy below.

---

### Step 2 — Find contenders (archetype-aware Firecrawl + niche-appropriate sources)

Load Firecrawl tools first via ToolSearch if not already loaded:
```
ToolSearch({ query: "firecrawl", max_results: 10 })
```

Run **3–5 parallel searches** tuned to the archetype. Don't reuse the same search pattern for every brief.

**For local service businesses** (the most common case):
```
firecrawl_search({ query: "best [trade] in [city/state]", limit: 15 })
firecrawl_search({ query: "top rated [trade] [city]", limit: 15 })
firecrawl_search({ query: "[trade] [city] reviews", limit: 15 })
firecrawl_search({ query: "[trade] near me [city]", limit: 15 })
firecrawl_search({ query: "[trade] [city]", limit: 10 })  // bare commercial-intent query
```
Plus scrape these surfaces and harvest the top-ranked individual businesses:
- `firecrawl_scrape("https://www.google.com/maps/search/[trade]+[city]")` — Google Maps top results
- `firecrawl_scrape("https://www.yelp.com/search?find_desc=[trade]&find_loc=[city]")` — Yelp top-rated
- `firecrawl_scrape("https://www.bbb.org/search?find_country=USA&find_text=[trade]&find_loc=[city]")` — BBB A+ rated
- HomeAdvisor / Angi top picks (US trades)

**Filter HARD** for local-service briefs:
- ❌ Reject national chains (Home Depot, Lowe's, big franchises with the city in the URL)
- ❌ Reject directory sites themselves (Yelp.com, Yellowpages.com, BBB.org — these are sources, not contenders)
- ❌ Reject sites without a phone number or service-area in the hero
- ❌ Reject sites whose Google review count is under 25 or rating is under 4.5
- ✅ Keep small/medium independents with 100+ reviews and 4.7+ stars where possible
- ✅ Keep family-owned operators (often local heroes that outperform franchises)

**For B2B SaaS / dev tools**:
```
firecrawl_search({ query: "top [category] tools 2026", limit: 15 })
firecrawl_search({ query: "best [category] software", limit: 15 })
firecrawl_search({ query: "[category] G2 leader", limit: 15 })
firecrawl_search({ query: "[category] alternatives", limit: 15 })
firecrawl_search({ query: "[category] funded series B series C" })
```

**For DTC ecom**:
```
firecrawl_search({ query: "best [product category] brands 2026", limit: 15 })
firecrawl_search({ query: "[product category] trustpilot 5 star", limit: 15 })
firecrawl_search({ query: "[product category] reddit recommendations", limit: 15 })
firecrawl_search({ query: "[product category] press coverage" })
```

**For marketplaces, media, education, high-ticket professional** — adapt with the right discovery surfaces (Substack leaderboards for newsletters, top-course rankings for education, "best [city] [profession]" + LinkedIn / Instagram for high-ticket pros).

**Rank the contenders** by:
- Frequency across searches (3+ surfaces mention them = strong signal)
- Search ranking on commercial-intent queries
- Review counts and ratings (for local + ecom)
- Editorial / directory recognition (G2, Capterra, Awwwards, BBB A+, "Top Rated 2025")

Pick the **top 8–10** to scrape. Pick **2–3 underperformers** (page-3 results, sub-3-star, dated template) for contrast.

---

### Step 3 — Scrape homepages (parallel)

For each contender:
```
firecrawl_scrape({
  url: "https://site.com",
  formats: ["markdown", "html"],
  onlyMainContent: false
})
```
Run in parallel (single message, multiple tool calls). 10 scrapes per batch max.

---

### Step 4 — Extract section structure (open taxonomy)

For each scraped page, walk it top-to-bottom and catalog every section. **The section types you encounter depend on the niche — extend the taxonomy whenever you see something new.** Do not bend the data to fit a pre-existing list.

**Common section types per archetype (extend as needed):**

| Section type | Where it commonly appears |
|---|---|
| `hero` | All |
| `phone-cta-bar` (sticky or hero phone number) | **Local service** |
| `trust-badge-row` (license #, BBB, insurance, years-in-business) | **Local service**, high-ticket pro |
| `service-area-map` | **Local service** |
| `emergency-cta-banner` (24/7, storm damage, urgent) | **Local service** (roofing, plumbing, HVAC, towing, locksmith) |
| `free-quote-form` (inline, not nav button) | **Local service**, high-ticket pro |
| `before-after-gallery` | **Local service** (roofing, landscaping, dentistry, home reno, fitness) |
| `team-photo-wall` (real local faces) | **Local service**, high-ticket pro |
| `financing-options` | **Local service** (roofing, HVAC, dentistry) |
| `google-reviews-widget` | **Local service** |
| `social-proof-logo-bar` (customer logos) | SaaS, marketplace, DTC, ecom |
| `live-demo` (GIF, video, interactive) | SaaS |
| `feature-trio` (3 cards) | SaaS, marketplace |
| `deep-dive-feature-blocks` (alternating) | SaaS |
| `product-grid` / `bestsellers` | DTC ecom |
| `ingredient-callout` / `how-it-works` | DTC (supplements, skincare) |
| `subscribe-and-save` | DTC consumables |
| `ugc-gallery` (real customer photos) | DTC ecom |
| `press-strip` ("As seen in" media logos) | DTC, creator |
| `testimonial-grid` (named + photo + outcome) | All |
| `case-study` (long-form proof, revenue impact) | SaaS, high-ticket pro |
| `pricing-tiers` | SaaS, education |
| `comparison-table` (vs competitors) | SaaS, DTC |
| `cohort-dates-bar` / `apply-now` | Education |
| `instructor-bio` / `curriculum-list` | Education |
| `email-capture-hero` | Media, creator |
| `founder-video` (face to camera) | High-ticket pro |
| `calendly-embed` (book-a-call) | High-ticket pro |
| `faq` | All |
| `final-cta` | All |
| `footer` | All |

For each section catalog:
- **Position** (top-to-bottom number)
- **Section type** (existing label OR a new one — invent labels when needed)
- **Headline / lede copy** (verbatim from the page)
- **CTA presence + label** ("Get Free Estimate", "Call Now", "Start Free Trial")
- **Visual element** (image, video, map, gallery, none)
- **Niche-specific details** (for a roofer: did they show license #, phone, service area, financing?)

Use `firecrawl_extract` with a structured schema on sites that resist clean markdown parsing.

---

### Step 5 — Aggregate the blueprint (the data tells you the count)

Build a position-frequency table from the scrapes. The number of "universal" sections (8+/10 sites) IS the blueprint — not a target you aim for.

**Example for "Texas roofers" (illustrative — actual run would scrape and report real numbers):**

```
Position 1 — Hero with "Free Inspection" CTA + phone # + storm-damage angle  — 10/10  ✓ universal
Position 2 — Trust badges (license #, BBB A+, "Family-owned since 19XX")     —  9/10  ✓ universal
Position 3 — Services list (Repair · Replacement · Inspection · Storm)       —  8/10  ✓ universal
Position 4 — Before/after gallery                                             —  7/10  ◐ majority
Position 5 — Google reviews widget (live star rating + count)                 —  9/10  ✓ universal
Position 6 — Service-area map (counties / cities served)                      —  6/10  ◐ majority
Position 7 — Financing offer ("$0 down / 0% APR for 24 mo")                  —  5/10  ◐ split
Position 8 — FAQ (warranty, timeline, insurance claim help)                   —  6/10  ◐ majority
Position 9 — Final CTA + repeat phone number + service-area reminder          — 10/10  ✓ universal
```

**Notice: this Texas-roofer blueprint shares almost zero sections with the AI-coding 9-beat. THAT IS THE POINT.** The roofer blueprint has phone-CTA, trust badges, before/after gallery, service-area map, financing. The SaaS blueprint has feature trio, demo, pricing tiers. The skill produces whichever one the data demands.

For each consensus section, document:
- **What the winners include** (specific copy/element patterns, anchored to which sites)
- **What the losers do instead** (or skip entirely)
- **The "do this not that"** one-liner with named examples on both sides

---

### Step 6 — Generate the HTML deliverable

Output to `~/Desktop/site-blueprint-{niche-slug}.html`. Slug examples: `texas-roofers`, `phoenix-plumbers`, `brooklyn-wedding-photographers`, `dtc-sleep-brands`.

Copy the **visual** language from `~/.claude/skills/site-blueprint/reference.html`:
- Hero with eyebrow tag + italic accent + standfirst + meta-pill row
- Logo grid for "the contenders" (real sites you analyzed)
- Archetype card
- Vertical-wireframe blueprint with frequency badges (mint/amber/dim)
- Per-beat cards (mini-wireframe + winners-include block + real example rows + winners-vs-losers contrast)
- Pull quotes
- Anti-patterns grid
- Monday checklist

**Do NOT copy:**
- The 9-beat count (your data might say 6 or 12)
- The "Hero · Social proof · Live demo · Feature trio · Deep dives · Testimonials · Pricing · FAQ · Final CTA" labels
- AI-coding-tools example headlines / brand chips

Fill the visual components with the niche-specific structure the data actually revealed.

For the logo grid, fetch real site favicons:
- Local kit at `~/Desktop/brand-kit/logos/` for known national/global brands
- For local businesses (Joe's Roofing in Houston): `https://www.google.com/s2/favicons?domain={site.com}&sz=128`
- Or scrape the site's real logo file with `firecrawl_extract` if the favicon is poor quality

---

### Step 7 — Preview + report

`preview_start` + `preview_screenshot`, then give the user a tight chat summary:

```
Niche: [specific niche + geo]
Archetype: [archetype]
Analyzed: [N] top sites + [M] contrast underperformers
Sources used: [Google Maps top X, Yelp top Y, organic search top Z]
Universal sections found: [count] (8+/10 consensus)
Top 3 surprising findings:
  • [finding 1]
  • [finding 2]
  • [finding 3]
HTML: ~/Desktop/site-blueprint-{slug}.html
```

---

## Anti-patterns the skill must avoid

- **Imposing the AI-coding 9-beat on every niche.** The mock is one example for one archetype. Roofers don't have a "feature trio". Newsletters don't have a "pricing teaser". Let the data decide.
- **Running on "industry" without geography for local businesses.** "Roofers" is meaningless. "Roofers in Dallas" is workable. "Roofers in the Dallas-Fort Worth metro with 100+ Google reviews" is gold.
- **Confusing directory listings with winners.** A Yelp page ranking #1 for "best roofers in Dallas" is not a winner — it's the directory. The winners are the businesses INSIDE that directory.
- **Picking national chains for local-service queries.** Home Depot offers roofing — they are not a Texas roofer. Skip.
- **Mocking the output instead of running the scrapes.** When the user asks for a real blueprint, RUN Firecrawl. Don't pattern-match from training data and pretend it's a real analysis. Real means real scrapes, real headlines, real frequency counts.
- **Reporting "9 universal beats" because that's what the reference showed.** Report the number you actually found.

---

## Brand logos

Real SVG/PNG logos for every named site:
1. Local kit at `~/Desktop/brand-kit/logos/` (60+ logos) — for known national/global brands
2. Wikipedia Commons SVGs
3. Site's favicon — `https://www.google.com/s2/favicons?domain={site.com}&sz=128` (works great for local businesses)
4. Last resort: scrape the site's real logo file with `firecrawl_extract` and save locally

Never use emoji as logos. Never use plain text in place of a logo for a NAMED site.

---

## Design tokens (mirrors `reference.html`)

```css
--bg: #0a0a0b;  --bg-2: #111114;  --bg-3: #16161a;  --bg-4: #1c1c22;
--border: #23232a;  --border-2: #2f2f38;
--text: #f4f4f5;  --muted: #a1a1aa;  --dim: #71717a;
--mint: #10B981;      /* winners / universal consensus */
--amber: #ffd166;     /* split / majority */
--red: #ef476f;       /* losers / anti-pattern */
--violet: #8B5CF6;    /* accent */
--peach: #ff8c5a;     /* hero accent */
```

Fonts: `Inter` (UI), `JetBrains Mono` (positions, frequencies), `Newsreader` italic (hero accents, pull quotes, example headlines).

---

## Caveats

- **Firecrawl anti-bot walls.** If `firecrawl_scrape` fails on a JS-heavy site, fall back to `firecrawl_extract` with a prompt — uses the browser tier and handles more sites.
- **Don't analyze ad landing pages** (`/lp/foo`, `/promo/x`) — check URL is the actual homepage.
- **Localized sites.** Scrape the right TLD for the geography (`.co.uk`, `.de`, etc.).
- **Mobile vs desktop.** Firecrawl returns desktop. For local-service businesses, mobile often inverts hero/phone-CTA order — note in deliverable.
- **For local-service queries, Google Maps and Yelp top results often beat search-engine listicles.** Don't skip them.
- **Pricing pages aren't homepages.** If the brief asks "optimal pricing page for [niche]", swap to `/pricing` URL scrapes.
