// Pure fallback-key rules for PricesAccordion's base table (`default_key`).

// Deleting the selected fallback picks the row that slides into its slot, else
// the preceding row, else none. `rows` is the table after the delete.
export function defaultKeyAfterDelete(defaultKey, deletedKey, rows, i) {
  if (deletedKey?.trim() !== defaultKey) return defaultKey;
  return rows[i]?.key.trim() || rows[i - 1]?.key.trim() || '';
}

// Renaming the selected fallback's key keeps it selected under the new name.
export function defaultKeyAfterRename(defaultKey, oldKey, newKey) {
  return oldKey.trim() === defaultKey ? newKey.trim() : defaultKey;
}
