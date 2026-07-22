/**
 * AppThemeProvider — the app's single theming boundary.
 *
 * Selects a skin from the {@link module:theme/registry registry} (persisted in
 * localStorage), renders that skin's `Provider`, and exposes the current skin +
 * a setter through {@link useThemeSkin}. Colour-mode (light/dark) stays owned by
 * the skin (ZAPAC's `useColorMode`); this layer only chooses *which skin*.
 *
 * Switching skins remounts the skin subtree (`key={skin.id}`) because different
 * skins are different MUI theme trees with their own pre-paint scheme scripts.
 * That is intentionally heavier than a colour-mode toggle — skin changes are
 * rare — and callers that hold volatile UI (e.g. live terminals) should expect
 * a remount, mirroring how a colour-mode change already prompts session respawn.
 */
import { createContext, use, useCallback, useMemo, useState } from 'react';
import { DEFAULT_SKIN_ID, getSkin, listSkins } from '@/theme/registry.js';

const STORAGE_KEY = 'sing-skin';

/** @type {React.Context<{ skinId: string, setSkin: (id: string) => void, skins: import('@/theme/registry.js').Skin[] } | null>} */
const ThemeSkinContext = createContext(null);

function readInitialSkinId() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && getSkin(saved)) return saved;
  } catch {
    // localStorage unavailable (private mode / SSR) — fall through to default.
  }
  return DEFAULT_SKIN_ID;
}

export function AppThemeProvider({ children, defaultMode = 'dark' }) {
  const [skinId, setSkinId] = useState(readInitialSkinId);

  const setSkin = useCallback((id) => {
    if (!getSkin(id)) return;
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Non-fatal — the selection still applies for this session.
    }
    setSkinId(id);
  }, []);

  // Resolve defensively: a persisted id whose skin was unregistered falls back.
  const skin = getSkin(skinId) ?? getSkin(DEFAULT_SKIN_ID) ?? listSkins()[0];

  const ctx = useMemo(
    () => ({ skinId: skin?.id, setSkin, skins: listSkins() }),
    [skin?.id, setSkin],
  );

  if (!skin) {
    throw new Error('AppThemeProvider: no skins registered — call registerSkin() first');
  }

  const SkinProvider = skin.Provider;
  return (
    <ThemeSkinContext value={ctx}>
      <SkinProvider key={skin.id} defaultMode={defaultMode}>
        {children}
      </SkinProvider>
    </ThemeSkinContext>
  );
}

/**
 * Read the active skin and switch skins.
 * @returns {{ skinId: string, setSkin: (id: string) => void, skins: import('@/theme/registry.js').Skin[] }}
 */
export function useThemeSkin() {
  const ctx = use(ThemeSkinContext);
  if (!ctx) throw new Error('useThemeSkin must be used within <AppThemeProvider>');
  return ctx;
}
