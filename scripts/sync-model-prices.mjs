import { readFile, writeFile, copyFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const catalog = JSON.parse(await readFile(new URL('../server/model-pricing-catalog.json', import.meta.url), 'utf8'));

// Keep custom rows in their existing relative order. Insert new versioned
// entries before any broader substring that would otherwise shadow them.
function mergeTable(current = {}, updates) {
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Invalid pricing table');
  const entries = Object.entries(current);
  for (const [key, rate] of Object.entries(updates)) {
    const existing = entries.findIndex(([candidate]) => candidate === key);
    const shadow = entries.findIndex(([candidate]) => candidate !== key && key.includes(candidate));
    if (existing >= 0 && (shadow < 0 || existing < shadow)) {
      entries[existing] = [key, rate];
      continue;
    }
    if (existing >= 0) entries.splice(existing, 1);
    const broad = entries.findIndex(([candidate]) => key.includes(candidate));
    entries.splice(broad < 0 ? entries.length : broad, 0, [key, rate]);
  }
  for (const [, rate] of entries) {
    if (!Array.isArray(rate) || rate.length !== 4 || !rate.every((n) => Number.isFinite(n) && n >= 0)) {
      throw new Error('Rates must contain four finite nonnegative numbers');
    }
  }
  return Object.fromEntries(entries);
}

export function reconcilePricing(current) {
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Invalid pricing document');
  const layered = ['base', 'above_200k', 'long_context_threshold', 'default_key'].some((key) => key in current);
  const doc = layered ? current : { base: current };
  return {
    ...doc,
    base: mergeTable(doc.base, catalog.pricing.base),
    above_200k: mergeTable(doc.above_200k, catalog.pricing.above_200k),
    long_context_threshold: catalog.pricing.long_context_threshold,
    default_key: doc.default_key ?? catalog.pricing.default_key,
  };
}

export async function syncModelPrices(path, write = false) {
  let original;
  try { original = await readFile(path, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const current = original === undefined ? {} : JSON.parse(original);
  const pricing = reconcilePricing(current);
  // JSON comparison includes key order: order is part of the matching contract.
  const changed = JSON.stringify(pricing) !== JSON.stringify(current);
  if (changed && write) {
    await mkdir(dirname(path), { recursive: true });
    if (original !== undefined) await copyFile(path, `${path}.bak`);
    const pending = `${path}.${process.pid}.pending`;
    await writeFile(pending, `${JSON.stringify(pricing, null, 2)}\n`, { flag: 'wx' });
    await rename(pending, path);
  }
  return { path, changed, written: changed && write, verified_on: catalog.verified_on, models: Object.keys(catalog.pricing.base).length };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--write')) throw new Error('Usage: node --env-file-if-exists=.env scripts/sync-model-prices.mjs [--write]');
  const { getModelPricesPath } = await import('../server/model-prices.mjs');
  console.log(JSON.stringify(await syncModelPrices(getModelPricesPath(), args.includes('--write'))));
}
