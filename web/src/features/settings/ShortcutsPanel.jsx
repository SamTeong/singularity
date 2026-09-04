import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import { alpha } from '@mui/material/styles';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import EditIcon from '@mui/icons-material/Edit';
import { ACTIONS, DEFAULTS, formatBinding, bindingFromEvent } from '@/lib/keys.js';
import { useKeys } from '@/providers/KeysProvider.jsx';

const GROUPS = [...new Set(ACTIONS.map((a) => a.group))];
const DOUBLE_TAP_KEYS = ['Shift', 'Control', 'Alt', 'Meta'];

// Compare by rendered chord, not by object identity — a recorded binding carries
// every modifier flag explicitly while a default omits the false ones.
const isDefault = (id, binding) => formatBinding(binding) === formatBinding(DEFAULTS[id]);

function ShortcutRow({ action, binding, recording, conflict, onRecord, onCancelRecord, onCommit, onReset }) {
  const btnRef = useRef(null);

  useEffect(() => { if (recording) btnRef.current?.focus(); }, [recording]);

  // Capture keydown at the window (capture phase) so the shell's own shortcuts
  // (Alt+Up/Down, etc.) never fire while a row is recording.
  useEffect(() => {
    if (!recording) return undefined;
    const onKeyDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { onCancelRecord(); return; }
      if (DOUBLE_TAP_KEYS.includes(e.key)) return; // bare modifier — keep waiting
      onCommit(bindingFromEvent(e));
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [recording, onCommit, onCancelRecord]);

  return (
    <ListItem
      secondaryAction={
        <Tooltip title="Reset to default">
          <span>
            <IconButton size="small" disabled={isDefault(action.id, binding)} onClick={onReset}>
              <RestartAltIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      }
      sx={{ pr: 6, py: 1.25, borderBottom: (t) => `1px solid ${alpha(t.palette.glass.stroke, 0.1)}` }}
    >
      <ListItemText
        primary={action.label}
        secondary={conflict ? 'Conflicts with another shortcut in this group' : undefined}
        slotProps={{ secondary: { sx: { color: 'warning.main' } } }}
      />
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        {action.id === 'paletteOpen' ? (
          <Select size="small" value={binding.doubleTap} onChange={(e) => onCommit({ doubleTap: e.target.value })}>
            {DOUBLE_TAP_KEYS.map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}
          </Select>
        ) : (
          <>
            <Chip label={recording ? 'Press a key… (Esc cancels)' : formatBinding(binding)} size="small" color={conflict ? 'warning' : 'default'} />
            <Tooltip title="Update binding">
              <IconButton ref={btnRef} size="small" onClick={onRecord} onBlur={() => recording && onCancelRecord()}>
                <EditIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Stack>
    </ListItem>
  );
}

/**
 * Shortcuts tab — rebindable keyboard shortcuts. Groups actions the same way
 * {@link ACTIONS} declares them (Global/Sessions/Editor/Palette/History/Chat),
 * flags same-group chord collisions (warn only, never blocks), and lets
 * `paletteOpen` pick its double-tap modifier from a select instead of Record.
 * All state lives in {@link useKeys} — this panel holds only which row (if any)
 * is currently recording. Owns its per-tab action (Reset all).
 */
export default function ShortcutsPanel() {
  const { keys, setKey, resetKey, resetAll } = useKeys();
  const [recordingId, setRecordingId] = useState(null);

  // Same-group chord collisions — display-string equality (doubleTap bindings
  // never collide with keydown bindings since formatBinding renders them
  // distinctly). Cross-group duplicates are intentional and excluded by scoping
  // the map per group.
  const conflicts = useMemo(() => {
    const conflictIds = new Set();
    for (const group of GROUPS) {
      const byChord = new Map();
      for (const a of ACTIONS) {
        if (a.group !== group) continue;
        const chord = formatBinding(keys[a.id]);
        if (!byChord.has(chord)) byChord.set(chord, []);
        byChord.get(chord).push(a.id);
      }
      for (const ids of byChord.values()) if (ids.length > 1) ids.forEach((id) => conflictIds.add(id));
    }
    return conflictIds;
  }, [keys]);

  return (
    <Box sx={{ p: 2 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 3, flexWrap: 'wrap' }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', flex: 1 }}>
          Customize the shortcuts used across the app. Changes apply immediately.
        </Typography>
        <Button size="small" startIcon={<RestartAltIcon />} onClick={resetAll}>Reset all</Button>
      </Stack>

      {GROUPS.map((group) => (
        <Box key={group} sx={{ mb: 3 }}>
          <Typography component="h2" sx={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'text.secondary', mb: 1 }}>
            {group}
          </Typography>
          <List dense disablePadding>
            {ACTIONS.filter((a) => a.group === group).map((action) => (
              <ShortcutRow
                key={action.id}
                action={action}
                binding={keys[action.id]}
                recording={recordingId === action.id}
                conflict={conflicts.has(action.id)}
                onRecord={() => setRecordingId(action.id)}
                onCancelRecord={() => setRecordingId(null)}
                // Recording the default chord back should drop the override, not
                // persist a no-op that never differs from what the default renders.
                onCommit={(binding) => {
                  if (isDefault(action.id, binding)) resetKey(action.id);
                  else setKey(action.id, binding);
                  setRecordingId(null);
                }}
                onReset={() => resetKey(action.id)}
              />
            ))}
          </List>
        </Box>
      ))}
    </Box>
  );
}