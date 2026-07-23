/**
 * Skin registry — the single extension point for the app's visual skins.
 *
 * Adding a new skin is two steps:
 *   1. Write a skin descriptor module under `theme/skins/` (see `skins/zapac.jsx`).
 *   2. Call `registerSkin(mySkin)` here (or from that module) — one line.
 *
 * The `AppThemeProvider` renders the selected skin's `Provider`, and the skin
 * switcher enumerates `listSkins()`. Nothing else in the app needs to change to
 * gain a new skin.
 *
 * @typedef {Object} Skin
 * @property {string} id            Stable identifier, persisted in localStorage.
 * @property {string} label         Human-readable name for the switcher.
 * @property {string} [description] Short blurb for the switcher.
 * @property {React.ComponentType<{ children: React.ReactNode, defaultMode?: 'light'|'dark' }>} Provider
 *   Theme-boundary component that themes everything below it.
 * @property {React.ComponentType} [Background] Optional full-bleed background
 *   painted behind the shell (e.g. ZAPAC's ambient gradient). Omit for none.
 * @property {React.ComponentType} [Preview] Optional thumbnail rendered in the
 *   skin switcher to show the theme's identity. Should be self-contained and
 *   avoid external assets.
 * @property {boolean} [supportsColorMode] Whether the skin honours light/dark
 *   toggling via `@zapac/mui-theme`'s `useColorMode`. Defaults to true.
 */

/** @type {Map<string, Skin>} */
const skins = new Map();

/** Id of the skin used when none is persisted / a persisted id is unknown. */
export const DEFAULT_SKIN_ID = 'zapac';

/**
 * Register a skin. Idempotent per id — a later call with the same id wins, so a
 * skin module can be imported more than once without duplicating entries.
 * @param {Skin} skin
 * @returns {Skin} the registered skin
 */
export function registerSkin(skin) {
  if (!skin?.id || typeof skin.Provider !== 'function') {
    throw new Error('registerSkin: a skin needs an `id` and a `Provider` component');
  }
  skins.set(skin.id, { supportsColorMode: true, ...skin });
  return skins.get(skin.id);
}

/** @param {string} id @returns {Skin | undefined} */
export function getSkin(id) {
  return skins.get(id);
}

/** @returns {Skin[]} registered skins, in registration order */
export function listSkins() {
  return [...skins.values()];
}
