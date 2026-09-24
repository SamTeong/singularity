// pricing.json — the harness-usage-report skill's only rate source (see
// .claude/skills/harness-usage-report/scripts/stats.mjs). Settings > Models >
// Prices reads/writes this file directly, no separate store to keep in sync.
// Schema: { base, above_200k, long_context_threshold, default_key } (rates are
// [input, output, cacheRead, cacheWrite] $/MTok). `base`'s key order is match
// order (first key that's a substring of the model id wins).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { USAGE_SKILL_STATE } from './app-dir.mjs';

const PRICING_JSON = join(USAGE_SKILL_STATE, 'pricing.json');
const MAX_KEY = 64;
const DEFAULT_THRESHOLD = 200000;

function isRate(a) {
  return Array.isArray(a) && a.length === 4 && a.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0);
}

// Validate one rate table (base or above_200k): trimmed non-empty unique
// keys <= MAX_KEY chars, each mapping to a valid rate. Throws on the first
// bad entry, labelled for the 400 message.
function validateTable(table, label) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error(`${label} must be an object`);
  const seen = new Set();
  const out = {};
  for (const [rawKey, rate] of Object.entries(table)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key) throw new Error(`${label} key must not be empty`);
    if (key.length > MAX_KEY) throw new Error(`${label} key too long (max ${MAX_KEY}): '${rawKey}'`);
    if (seen.has(key)) throw new Error(`${label} key '${key}' is duplicated`);
    seen.add(key);
    if (!isRate(rate)) throw new Error(`${label} rate for '${key}' must be [input, output, cacheRead, cacheWrite] as finite numbers >= 0`);
    out[key] = rate.slice();
  }
  return out;
}

// Validate a whole pricing.json document. Throws Error with a user-facing
// message on the first bad field — the route turns that into a 400 { error }.
function validate(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('doc must be an object');
  const base = validateTable(doc.base, 'base');
  const above_200k = validateTable(doc.above_200k ?? {}, 'above_200k');
  const threshold = doc.long_context_threshold;
  if (!Number.isInteger(threshold) || threshold <= 0) throw new Error('long_context_threshold must be a positive integer');
  const defaultKey = typeof doc.default_key === 'string' ? doc.default_key.trim() : '';
  if (defaultKey && !(defaultKey in base)) throw new Error(`default_key '${defaultKey}' must be a base key`);
  return { base, above_200k, long_context_threshold: threshold, default_key: defaultKey };
}

// Read pricing.json as-is: parsed doc, or {} if unreadable/absent/invalid.
function readPricingJson() {
  try {
    const parsed = JSON.parse(readFileSync(PRICING_JSON, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* unreadable/absent/invalid — start fresh */ }
  return {};
}

// Normalize a raw pricing.json read to the API/UI shape. A bare pre-layered
// file (the whole object is base rates, no base/above_200k/threshold/
// default_key keys) is wrapped as base for back-compat.
function normalize(doc) {
  const layered = ('base' in doc) || ('above_200k' in doc) || ('long_context_threshold' in doc) || ('default_key' in doc);
  const base = layered ? doc.base : doc;
  return {
    base: base && typeof base === 'object' && !Array.isArray(base) ? base : {},
    above_200k: doc.above_200k && typeof doc.above_200k === 'object' && !Array.isArray(doc.above_200k) ? doc.above_200k : {},
    long_context_threshold: Number.isInteger(doc.long_context_threshold) && doc.long_context_threshold > 0 ? doc.long_context_threshold : DEFAULT_THRESHOLD,
    default_key: typeof doc.default_key === 'string' ? doc.default_key : '',
  };
}

// GET /api/models/prices
export function getModelPrices() {
  return normalize(readPricingJson());
}

// PUT /api/models/prices — validate + write pricing.json (2-space JSON) in
// full; the caller always sends the whole doc, so a plain overwrite is safe.
export function putModelPrices(body) {
  const doc = validate(body);
  mkdirSync(USAGE_SKILL_STATE, { recursive: true });
  writeFileSync(PRICING_JSON, JSON.stringify(doc, null, 2));
  return doc;
}
