/**
 * ZAPAC skin — the default Singularity theme.
 *
 * Thin descriptor over the vendored `@zapac/mui-theme` package: a dual light/dark
 * glass-over-gradient system on the Zühlke purple→cyan identity. The vendored
 * `ZapacThemeProvider` owns the MUI `ThemeProvider`, `CssBaseline`, and the
 * pre-paint color-scheme script, and exposes `useColorMode` for light/dark
 * toggling. This module just packages it as a registry {@link Skin}.
 */
import { ZapacThemeProvider } from '@zapac/mui-theme';
import { useTheme } from '@mui/material/styles';
import { assertSkinContract } from '../contract.js';

/** Dev-only: verify the vendored theme still satisfies the token contract. */
function ContractCheck() {
  assertSkinContract(useTheme(), 'zapac');
  return null;
}

function ZapacProvider({ children, defaultMode = 'dark' }) {
  return (
    <ZapacThemeProvider defaultMode={defaultMode}>
      <ContractCheck />
      {children}
    </ZapacThemeProvider>
  );
}

/** @type {import('../registry.js').Skin} */
export const zapacSkin = {
  id: 'zapac',
  label: 'ZAPAC',
  description: 'Glass-over-gradient on the Zühlke purple→cyan identity.',
  Provider: ZapacProvider,
  supportsColorMode: true,
};
