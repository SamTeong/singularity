import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';

const createBtnSx = { px: 2, '& .MuiButton-startIcon': { marginRight: 0.5 } };

// End-adornment clear button for a TextField; renders only when `show` is truthy.
// Usage: slotProps={{ input: { endAdornment: clearAdornment(value !== '', () => setValue('')) } }}
export const clearAdornment = (show, onClick) => show ? (
  <InputAdornment position="end">
    <IconButton size="small" aria-label="clear" onClick={onClick} edge="end" sx={{ p: 0.25 }}>
      <CloseIcon fontSize="small" />
    </IconButton>
  </InputAdornment>
) : null;

// Shared chrome for the New-session / New-task / New-background-job / New-scheduled-job
// dialogs: Dialog shell, title, content Stack, and a Cancel + submit action row.
// `editing` swaps the submit button to Save and drops the Add startIcon (edit mode
// has no "new" affordance). `createLabel` overrides the submit text when passed.
// Field bodies are children.
export default function CreateDialog({ open, onClose, title, onCancel, onCreate, editing = false, createLabel, createDisabled = false, children }) {
  if (!open) return null;
  const submitLabel = createLabel ?? (editing ? 'Save' : 'Create');
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent sx={{ pb: 1.5 }}>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          {children}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 2, pb: 2, pt: 0.5 }}>
        <Button size="small" variant="secondary" sx={{ px: 2 }} onClick={onCancel}>Cancel</Button>
        <Button size="small" sx={createBtnSx} variant="contained" startIcon={editing ? undefined : <AddIcon />} onClick={onCreate} disabled={createDisabled}>{submitLabel}</Button>
      </DialogActions>
    </Dialog>
  );
}