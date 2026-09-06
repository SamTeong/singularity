import { useState } from 'react';
import useMediaQuery from '@mui/material/useMediaQuery';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { PHONE_QUERY } from '@/shell/breakpoints.js';

// The phone representation shared by the five Rail-based editor panels
// (Config, Hooks, Rules, Memory, Skills) — Phase 4's SessionHistory pattern,
// extracted once five call sites needed the identical state. One pane at a
// time: the Rail's `useResizable` floor (`min`, ~200px) plus an editor pane
// cannot both fit a 375px screen, so a labelled switcher gives whichever pane
// is active the full page width instead of squeezing both.
//
// `hasDetail` is re-evaluated on every render, and the render-time state
// adjustment below is the load-bearing half: a desktop window shrunk with a
// file already open must surface that file, not the default list pane (the
// Phase 4 review's MEDIUM finding — a switcher without this half hides the
// open content behind the list). Like SessionDock's `wasPhone`, it runs once
// per crossing, not on every resize tick.
export function usePhonePane(hasDetail) {
  const isPhone = useMediaQuery(PHONE_QUERY);
  const [phonePane, setPhonePane] = useState('list');
  const [wasPhone, setWasPhone] = useState(isPhone);
  if (isPhone !== wasPhone) {
    setWasPhone(isPhone);
    if (isPhone && hasDetail) setPhonePane('detail');
  }
  return { isPhone, phonePane, setPhonePane };
}

// The switcher bar itself — MUI's ToggleButtonGroup, themed by each skin
// (SessionHistory's idiom), so there is no per-skin branch to get wrong.
// `Editor` is disabled until the panel has something open, mirroring
// SessionHistory's disabled "Transcript" before a selection.
export function PhonePaneSwitcher({ pane, onSwitch, detailDisabled }) {
  return (
    <ToggleButtonGroup value={pane} exclusive size="small" onChange={(_, v) => v && onSwitch(v)} sx={{ width: '100%' }}>
      <ToggleButton value="list" sx={{ flex: 1, fontSize: 12, textTransform: 'none' }}>Files</ToggleButton>
      <ToggleButton value="detail" disabled={detailDisabled} sx={{ flex: 1, fontSize: 12, textTransform: 'none' }}>Editor</ToggleButton>
    </ToggleButtonGroup>
  );
}