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
import { createContext, use, useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { getSkin, listSkins } from '@/theme/registry.js';
import { resolveSkin } from '@/theme/resolveSkin.js';

const STORAGE_KEY = 'sing-skin';

/** @type {React.Context<{ skinId: string, setSkin: (id: string, pendingRespawn?: number) => void, skins: import('@/theme/registry.js').Skin[], pendingRespawn: number, clearPendingRespawn: () => void } | null>} */
const ThemeSkinContext = createContext(null);

function readInitialSkinId() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return resolveSkin(saved)?.id;
  } catch {
    // localStorage unavailable (private mode / SSR) — fall through to default.
    return resolveSkin(null)?.id;
  }
}

export function AppThemeProvider({ children, defaultMode = 'dark' }) {
  const [skinId, setSkinId] = useState(readInitialSkinId);
  // Transient cross-remount signal (task 6.6's live-session respawn count):
  // switching skins remounts the child subtree below (`key={skin.id}` on
  // `SkinProvider`), so any state a callback sets before calling `setSkin`
  // would normally be lost by the time the fresh subtree mounts. This state
  // lives HERE, above that remount boundary, so it survives the switch
  // without round-tripping through Web Storage — `setSkin`'s optional second
  // argument sets it, and `clearPendingRespawn` lets the one consumer that
  // reads it (AppShell) clear it once it's been read.
  const [pendingRespawn, setPendingRespawn] = useState(0);

  const setSkin = useCallback((id, pendingRespawnCount) => {
    if (!getSkin(id)) return;
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Non-fatal — the selection still applies for this session.
    }
    if (pendingRespawnCount) setPendingRespawn(pendingRespawnCount);
    setSkinId(id);
  }, []);

  const clearPendingRespawn = useCallback(() => setPendingRespawn(0), []);

  // Resolve defensively: a persisted id whose skin was unregistered falls back.
  const skin = resolveSkin(skinId);

  // Publish the active skin to the document so PLAIN CSS can scope by skin.
  // `web/src/style.css` holds a few rules that predate multi-skin support and
  // are ZAPAC-specific (the lifted error red, the purple xterm scrollbar, the
  // terminal's 6px radius). They aren't reachable from `sx`/`getRoles()`, so
  // without a selector here they applied to every skin and painted ZAPAC
  // identity colours into the Phosphor console. `useLayoutEffect` runs before
  // paint; the CSS is written as `:not([data-skin="phosphor"])` so the ZAPAC
  // rules are the default even for the one frame before this lands.
  useLayoutEffect(() => {
    if (skin?.id) document.documentElement.dataset.skin = skin.id;
  }, [skin?.id]);

  const ctx = useMemo(
    () => ({ skinId: skin?.id, setSkin, skins: listSkins(), pendingRespawn, clearPendingRespawn }),
    [skin?.id, setSkin, pendingRespawn, clearPendingRespawn],
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
 * @returns {{ skinId: string, setSkin: (id: string, pendingRespawn?: number) => void, skins: import('@/theme/registry.js').Skin[], pendingRespawn: number, clearPendingRespawn: () => void }}
 */
export function useThemeSkin() {
  const ctx = use(ThemeSkinContext);
  if (!ctx) throw new Error('useThemeSkin must be used within <AppThemeProvider>');
  return ctx;
}
