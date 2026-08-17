// Shared overwrite-on-disk confirm. Six editors (Explorer/Hooks/Config/Memory/
// Rules/Skills) hit the daemon's `error: 'changed on disk'` guard and all ask
// the same question — this is that one prompt, so the wording stays in one
// place. `useDirtyGuard` (sibling file) handles a different concern: the
// discard-unsaved-changes case before navigation. This returns true on a user
// OK and false on cancel, drop-in for the old `window.confirm(...)` call.
export const confirmOverwrite = () =>
  window.confirm('This file changed on disk since it was opened. Overwrite it?');