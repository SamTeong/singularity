import { getTokens } from '@/theme/contract.js';
import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

const ROLE_COLOR = { user: 'primary.main', assistant: 'text.primary', tool: 'text.secondary' };

// Read-only transcript message list — shared by SessionHistory's "View" tab
// and the History dock panel on TasksBoard.
export default function TranscriptView({ messages, emptyText = 'No messages.' }) {
  return (
    <Stack spacing={1.5}>
      {messages.map((m, i) => (
        <Box key={i} sx={(t) => ({ px: 1.5, py: 1, borderRadius: `${getTokens(t).radius.sm}px`, border: `1px solid ${getTokens(t).glass.stroke}`, bgcolor: m.role === 'user' ? 'action.hover' : 'transparent' })}>
          <Typography variant="code" sx={{ color: ROLE_COLOR[m.kind === 'toolUse' || m.kind === 'toolResult' ? 'tool' : m.role], fontSize: 11, fontWeight: 700 }}>
            {m.kind === 'toolUse' ? `tool: ${m.name}` : m.kind === 'toolResult' ? 'tool result' : m.kind === 'thinking' ? 'thinking' : m.role}
          </Typography>
          <Typography sx={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', mt: 0.25, opacity: m.kind === 'thinking' ? 0.7 : 1 }}>{m.text}</Typography>
        </Box>
      ))}
      {messages.length === 0 && <Typography color="text.secondary">{emptyText}</Typography>}
    </Stack>
  );
}
