import { getTokens } from '@/theme/contract.js';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { useColorMode } from '@zapac/mui-theme';
import { useThemeSkin } from '@/theme/index.js';
import { getTerminalTheme } from '@/features/sessions/term-theme.js';

// Role/kind → xterm ANSI palette key (matches the live Terminal). Kept as a
// palette-key lookup rather than raw hex so a theme tweak in term-theme.js
// propagates here without an edit.
const ROLE_KEY = {
  user: 'brightBlue',
  assistant: 'foreground',
  tool: 'green',      // toolUse header
  toolResult: 'yellow',
  thinking: 'brightBlack',
};

// Read-only transcript message list — shared by SessionHistory's "View" tab
// and the History dock panel on TasksBoard. Styled to mimic the live xterm
// terminal: opaque machine-output bg + ANSI palette colors per role, monospace
// via Typography variant="code" (same JetBrains Mono stack as Terminal.jsx).
export default function TranscriptView({ messages, emptyText = 'No messages.' }) {
  const { skinId } = useThemeSkin();
  const mode = useColorMode().resolved === 'light' ? 'light' : 'dark';
  const theme = useTheme();
  const pal = getTerminalTheme(skinId, mode);
  const radius = getTokens(theme).radius?.sm ?? 6;
  const labelOf = (m) => (m.kind === 'toolUse' ? `tool: ${m.name}` : m.kind === 'toolResult' ? 'tool result' : m.kind === 'thinking' ? 'thinking' : m.role);
  const keyFor = (m) => ROLE_KEY[m.kind === 'toolUse' ? 'tool' : m.kind === 'toolResult' ? 'toolResult' : m.kind === 'thinking' ? 'thinking' : m.role] || 'foreground';

  return (
    <Stack spacing={1} sx={{ bgcolor: pal.background, color: pal.foreground, p: 1, borderRadius: `${radius}px` }}>
      {messages.map((m, i) => {
        const labelColor = pal[keyFor(m)] || pal.foreground;
        const dim = m.kind === 'thinking';
        return (
          <Box key={i} sx={{ px: 1.5, py: 1, borderLeft: `2px solid ${labelColor}`, bgcolor: 'transparent' }}>
            <Typography variant="code" sx={{ color: labelColor, fontSize: 11, fontWeight: 700, lineHeight: 1.2 }}>
              {labelOf(m)}
            </Typography>
            <Typography variant="code" sx={{ display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-word', mt: 0.25, opacity: dim ? 0.7 : 1, color: pal.foreground }}>
              {m.text}
            </Typography>
          </Box>
        );
      })}
      {messages.length === 0 && <Typography variant="code" sx={{ color: pal.brightBlack }}>{emptyText}</Typography>}
    </Stack>
  );
}