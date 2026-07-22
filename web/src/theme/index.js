/**
 * Theme framework public surface.
 *
 * Importing this module registers the built-in skins as a side effect, so the
 * registry is populated before `AppThemeProvider` first renders. Add a new
 * built-in skin by importing its descriptor and calling `registerSkin` here.
 */
import { registerSkin } from '@/theme/registry.js';
import { zapacSkin } from '@/theme/skins/zapac.jsx';
import { phosphorSkin } from '@/theme/skins/phosphor.jsx';

registerSkin(zapacSkin);
registerSkin(phosphorSkin);

export { AppThemeProvider, useThemeSkin } from '@/theme/AppThemeProvider.jsx';
export { getTokens } from '@/theme/contract.js';
export { listSkins, getSkin, registerSkin, DEFAULT_SKIN_ID } from '@/theme/registry.js';
