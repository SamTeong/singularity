# Model pricing

`server/model-pricing-catalog.json` records the official rates verified on
2026-11-19 for Astra, Sol, Terra, Luna, Fable, Opus, Sonnet and Haiku. Rates are
USD per million tokens, ordered `[input, output, cache_read, cache_write]`.
Historical entries reprice old transcripts; they do not imply API availability.
The GPT-5.6 Sol entries use promotional rates. OpenAI lists November 30,
2026 as the promotion end date. Recheck the published rates before updating
the catalog and estimators for requests after the promotion.
[GPT-5.6 Sol pricing](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
Haiku 3.5's historical rates are retained from the archived pricing record in
`~/wiki/agentic-coding/building/model-pricing.md`; the old documentation URL now
redirects to the current page.

The live table is `<USAGE_REPORT_STATE>/pricing.json`, normally
`~/.agents/.harness-usage-report/state/pricing.json`. Preview from the repository:

```powershell
node --env-file-if-exists=.env scripts/sync-model-prices.mjs
node --env-file-if-exists=.env scripts/sync-model-prices.mjs --write
```

The explicit write updates catalog entries, inserts specific versions before
broader fallbacks, preserves custom entries and `default_key`, and backs up the
original bytes to `pricing.json.bak`. Repeated writes skip unchanged documents.
Invalid input is rejected before writing. This command does not run at startup.

Runtime arrays retain the existing four-column contract. Standard cache writes
mean OpenAI 30 minutes and Claude 5 minutes. `reference` records extended cache
retention and Batch/Flex/Fast/Ultrafast pricing separately: aggregate transcript
usage does not identify those dimensions, so the shared report cannot apply them
accurately. The embedded Claude session estimator uses 5-minute/1-hour write
breakdowns when present. Billed cost takes precedence where supplied.

OpenAI long pricing applies above 272,000 prompt tokens; Haiku 5.5 switches above
100,000. Cached input and cache creation count toward the prompt boundary, and
the selected tier prices the entire request. The legacy `above_200k` field name
does not set either boundary. For known OpenAI long-context models, a table
without `long_context_threshold` defaults to 272,000. Existing custom global
thresholds still apply to entries that used that setting. Version matching
rejects partial numeric segments so a dated Fable 5 ID does not resolve to Fable
5.2.

Reports use the synced tier data from the live `pricing.json`, including any
`above_200k` entries. A table without one applies base rates and the report does
not fall back to embedded prices, because custom tables are supported. The
embedded session estimators are independent: `server/stats.mjs` and
`rust/backend/src/stats.rs` carry their own Haiku 5.5 above-100,000 tier, so the
two surfaces intentionally diverge for Haiku 5.5 until
`scripts/sync-model-prices.mjs --write` has populated `above_200k`.

A fresh report process loads the updated live table. Running session estimators
cache parsed costs and embedded rates until the daemon is restarted; syncing
does not restart services. Usage-history requests read the live table afresh.
`~/.singularity/state/models.json` stores model suggestions, not pricing.

Validate with `node --test scripts/sync-model-prices.test.mjs`, `pnpm lint`,
`pnpm test`, and `cargo test --manifest-path rust/backend/Cargo.toml`.
