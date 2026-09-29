import { useEffect } from 'react';
import Box from '@mui/material/Box';
import SnackbarContent from '@mui/material/SnackbarContent';
import { SNACK_GLASS, snackDrain, isDrainEnd } from '@/shell/shellStyles.js';

export default function ToastHost({ toasts, onDismiss }) {
  useEffect(() => {
    if (!toasts.length) return undefined;
    const closeTopToast = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest('input,textarea,[contenteditable]:not([contenteditable="false"]),[role="dialog"],.xterm')) return;
      onDismiss(toasts[toasts.length - 1].id);
    };
    window.addEventListener('keydown', closeTopToast);
    return () => window.removeEventListener('keydown', closeTopToast);
  }, [toasts, onDismiss]);

  if (!toasts.length) return null;
  return (
    <Box sx={(t) => ({
      position: 'fixed', bottom: 'calc(72px + env(safe-area-inset-bottom))', left: '50%', transform: 'translateX(-50%)',
      zIndex: t.zIndex.snackbar, display: 'flex', flexDirection: 'column-reverse', gap: 1, alignItems: 'center',
      width: 'min(300px, calc(100vw - 32px))',
    })}>
      {toasts.map((toast) => (
        <SnackbarContent
          key={toast.id}
          sx={[SNACK_GLASS, snackDrain(toast.duration), { width: '100%', boxSizing: 'border-box', overflowWrap: 'anywhere' }]}
          onAnimationEnd={(e) => isDrainEnd(e) && onDismiss(toast.id)}
          message={toast.message}
          action={toast.action}
        />
      ))}
    </Box>
  );
}
