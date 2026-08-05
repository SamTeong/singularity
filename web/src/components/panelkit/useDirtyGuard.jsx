import { useCallback, useRef, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';

// 3-way discard guard shared by the non-Explorer panels. Replaces the old
// `if (dirty && !window.confirm('Discard unsaved changes?')) return;` pattern
// with Save / Discard / Cancel:
//   - Save    → await the panel's save(), then proceed (resolve true).
//   - Discard → proceed without saving (resolve true).
//   - Cancel  → abort the navigation (resolve false); also the Escape/backdrop
//               behavior (onClose maps to Cancel so a stray click doesn't drop
//               unsaved edits silently).
//
// `ensureSaved({ dirty, save })` returns a Promise<boolean>; `dialogEl` is the
// MUI <Dialog> — render it ONCE at the panel root. A `dirty === false` call
// resolves `true` synchronously without opening the dialog (back-compat with
// the no-dirty fast path the window.confirm guard had).
export function useDirtyGuard() {
  const [open, setOpen] = useState(false);
  const resolver = useRef(null);
  const saveRef = useRef(null);

  const ensureSaved = useCallback(({ dirty, save }) => {
    if (!dirty) return Promise.resolve(true);
    saveRef.current = save;
    return new Promise((resolve) => { resolver.current = resolve; setOpen(true); });
  }, []);

  const close = (val) => {
    setOpen(false);
    if (resolver.current) { resolver.current(val); resolver.current = null; }
  };

  const onSave = async () => { try { if (saveRef.current) await saveRef.current(); } catch { /* save surfaces its own error msg */ } close(true); };
  const onDiscard = () => close(true);
  const onCancel = () => close(false);

  const dialogEl = (
    <Dialog open={open} onClose={(_, reason) => { if (reason === 'backdropClick' || reason === 'escapeKeyDown') onCancel(); }}>
      <DialogTitle>Discard unsaved changes?</DialogTitle>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button onClick={onDiscard}>Discard</Button>
        <Button onClick={onSave} variant="contained">Save</Button>
      </DialogActions>
    </Dialog>
  );

  return { ensureSaved, dialogEl };
}