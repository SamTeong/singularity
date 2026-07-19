import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import SaveIcon from '@mui/icons-material/Save';

// Editor footer shared by the CodeMirror panels: optional left-aligned status
// slot (`children`, e.g. a JSON-error line) + save message + bottom-right Save.
export default function SaveBar({ msg, disabled, onSave, children }) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
      {children}
      {msg && <Typography color={msg.sev === 'error' ? 'error' : 'success.main'} sx={{ fontSize: 13 }}>{msg.text}</Typography>}
      <Box sx={{ flex: 1 }} />
      <Button size="small" variant="contained" startIcon={<SaveIcon />} sx={{ px: 2, '& .MuiButton-startIcon': { marginRight: 0.5 } }} onClick={onSave} disabled={disabled}>Save</Button>
    </Stack>
  );
}
