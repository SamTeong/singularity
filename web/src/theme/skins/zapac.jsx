/**
 * ZAPAC skin — the default Singularity theme.
 *
 * Thin descriptor over the vendored `@zapac/mui-theme` package: a dual light/dark
 * glass-over-gradient system on the Zühlke purple→cyan identity. The vendored
 * `ZapacThemeProvider` owns the MUI `ThemeProvider`, `CssBaseline`, and the
 * pre-paint color-scheme script, and exposes `useColorMode` for light/dark
 * toggling. This module just packages it as a registry {@link Skin}.
 */
import { ZapacThemeProvider, AmbientBackground } from '@zapac/mui-theme';
import { useTheme } from '@mui/material/styles';
import Box from '@mui/material/Box';
import { assertSkinContract, getTokens } from '@/theme/contract.js';

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

const ZAPAC_LIGHT_GRAD = 'linear-gradient(150deg, #d9c6ee 0%, #c3ace3 40%, #9eb2e8 100%)';
const ZAPAC_DARK_GRAD = 'linear-gradient(150deg, #711f7d 0%, #4c2c8c 38%, #1c3a75 100%)';

/** Small representative preview of the ZAPAC skin identity. */
export function ZapacPreview() {
  const tokens = getTokens(useTheme());
  const paneSx = {
    flex: 1,
    p: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 0.75,
  };
  const glassSx = (isDark) => ({
    height: 16,
    borderRadius: `${tokens.radius.sm ?? 12}px`,
    background: isDark ? 'rgba(30,22,52,.55)' : 'rgba(255,255,255,.66)',
    border: isDark ? '1px solid rgba(160,130,255,.16)' : '1px solid rgba(152,91,156,.20)',
    backdropFilter: 'blur(8px)',
  });
  return (
    <Box
      aria-hidden
      sx={{
        width: '100%',
        height: 80,
        borderRadius: `${tokens.radius.md ?? 18}px`,
        position: 'relative',
        overflow: 'hidden',
        boxShadow: '0 4px 20px -8px rgba(0,0,0,.25)',
      }}
    >
      { /* Light pane: full width but only the left half is visible via clip. */ }
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          background: ZAPAC_LIGHT_GRAD,
          clipPath: 'polygon(0 0, 55% 0, 45% 100%, 0 100%)',
        }}
      />
      { /* Dark pane: fills the right half. */ }
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          background: ZAPAC_DARK_GRAD,
          clipPath: 'polygon(55% 0, 100% 0, 100% 100%, 45% 100%)',
        }}
      />
      <Box sx={{ position: 'relative', zIndex: 1, display: 'flex', height: '100%' }}>
        <Box sx={{ ...paneSx }}>
          <Box sx={glassSx(false)} />
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            <Box sx={{ width: 16, height: 8, borderRadius: 999, background: '#985b9c' }} />
            <Box sx={{ width: 10, height: 8, borderRadius: 999, background: '#0082b8' }} />
          </Box>
        </Box>
        <Box sx={{ ...paneSx }}>
          <Box sx={glassSx(true)} />
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            <Box sx={{ width: 16, height: 8, borderRadius: 999, background: '#c4a4ff' }} />
            <Box sx={{ width: 10, height: 8, borderRadius: 999, background: '#4cc3f0' }} />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}


/** @type {import('@/theme/registry.js').Skin} */
export const zapacSkin = {
  id: 'zapac',
  label: 'ZAPAC',
  description: 'Glass-over-gradient on the Zühlke purple→cyan identity.',
  Provider: ZapacProvider,
  Background: AmbientBackground, // the flowing WebGL gradient field behind the glass
  Preview: ZapacPreview,
  supportsColorMode: true,
};
