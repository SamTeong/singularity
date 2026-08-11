/**
 * Pure skin-id resolution — extracted from `AppThemeProvider` so the
 * persisted/unknown-id fallback chain is unit-testable without a JSX loader
 * (localStorage access and React state stay in `AppThemeProvider.jsx`; this
 * module only implements the "which registered skin wins" logic).
 *
 * Imports its sibling relatively (not via the `@/` alias) so this module —
 * and its co-located `*.test.mjs` — stay importable under Node's native test
 * runner, which doesn't resolve the Vite-only `@/` alias (see vite.config.mjs).
 */
import { DEFAULT_SKIN_ID, getSkin, listSkins } from './registry.js';

/**
 * Resolve a candidate (e.g. persisted) skin id to a registered {@link Skin},
 * falling back to {@link DEFAULT_SKIN_ID}'s skin, then the first registered
 * skin, so an unknown/stale persisted id (or no persisted id at all) never
 * breaks the app.
 * @param {string|null|undefined} candidateId
 * @returns {import('@/theme/registry.js').Skin|undefined} the resolved skin,
 *   or `undefined` only if no skins are registered at all
 */
export function resolveSkin(candidateId) {
  return getSkin(candidateId) ?? getSkin(DEFAULT_SKIN_ID) ?? listSkins()[0];
}
