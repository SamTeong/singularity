// POC board — plan sessions as cards on a React Flow canvas ("Plans 2D").
// ponytail: POC — data is the in-memory mock (plansMockData.mjs); delete along
// with the losing view once a board is picked. No /api/plans fetch here.
import { useCallback, useMemo, useState } from 'react';
import { ReactFlow, Background, MiniMap, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Collapse from '@mui/material/Collapse';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { MOCK_SESSIONS, planBadge } from './plansMockData.mjs';

const NODE_W = 280;
const COLS = 6;
const COL_PITCH = 320;
const ROW_PITCH = 240;
const PLAN_PITCH = 250;

const STATUS_COLOR = { active: 'primary', done: 'success', blocked: 'error', superseded: 'warning', other: 'default' };
const statusColor = (s) => STATUS_COLOR[s] ?? 'default';
const dotColor = (s) => (s === 'other' ? 'text.disabled' : `${statusColor(s)}.main`);
const PHASE_GLYPH = { done: '✓', open: '○', skipped: '−' };

const relTime = (iso) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

const noop = () => {};

function SessionCard({ data }) {
  const { session, expanded, onToggle } = data;
  const statuses = [...new Set(session.plans.map((p) => p.status))];
  return (
    <Card className="nodrag nopan" variant="outlined" sx={{ width: NODE_W, borderColor: expanded ? 'primary.main' : undefined }}>
      <Handle type="source" position={Position.Right} />
      <CardActionArea onClick={onToggle} sx={{ p: 1.5 }}>
        <Stack spacing={0.75}>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
              {session.sid.slice(0, 8)}
            </Typography>
            <Stack direction="row" spacing={0.5}>
              {statuses.map((s) => (
                <Box key={s} sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: dotColor(s) }} />
              ))}
            </Stack>
          </Stack>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Chip size="small" variant="outlined" label={session.branch} sx={{ maxWidth: '100%' }} />
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
              {relTime(session.mtime)}
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {session.plans.length} plan{session.plans.length === 1 ? '' : 's'}
            {expanded ? ' · click to collapse' : ' · click to expand'}
          </Typography>
        </Stack>
      </CardActionArea>
    </Card>
  );
}

function PlanCard({ data }) {
  const { plan, notes, expanded, onToggle } = data;
  return (
    <Card className="nodrag nopan" variant="outlined" sx={{ width: NODE_W }}>
      <Handle type="target" position={Position.Left} />
      <CardActionArea onClick={onToggle} sx={{ p: 1.25 }}>
        <Stack spacing={0.5}>
          <Typography variant="subtitle2" sx={{ lineHeight: 1.3 }}>
            {plan.title}
          </Typography>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Chip size="small" variant="outlined" color={statusColor(plan.status)} label={`${planBadge(plan.status)} ${plan.status}`} />
            {plan.currentPhase && (
              <Typography variant="caption" color="text.secondary" noWrap>
                ▸ {plan.currentPhase}
              </Typography>
            )}
          </Stack>
          {plan.objective && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            >
              {plan.objective}
            </Typography>
          )}
        </Stack>
      </CardActionArea>
      <Collapse in={expanded} unmountOnExit>
        <Divider />
        <Box sx={{ p: 1.25 }}>
          <Stack spacing={0.25}>
            {plan.phases.map((ph, i) => (
              <Typography
                key={i}
                variant="caption"
                sx={{
                  color: ph.state === 'done' ? 'text.secondary' : 'text.primary',
                  textDecoration: ph.state === 'skipped' ? 'line-through' : 'none',
                }}
              >
                {PHASE_GLYPH[ph.state] ?? '○'} {ph.text}
              </Typography>
            ))}
          </Stack>
          {plan.nextSteps.length > 0 && (
            <Stack spacing={0.25} sx={{ mt: 1 }}>
              <Typography variant="overline" color="text.secondary">
                Next
              </Typography>
              {plan.nextSteps.map((s, i) => (
                <Typography key={i} variant="caption">
                  • {s}
                </Typography>
              ))}
            </Stack>
          )}
          {notes.length > 0 && (
            <Stack direction="row" sx={{ flexWrap: 'wrap', mt: 1, gap: 0.5 }}>
              {notes.map((n) => (
                <Chip key={n.file} size="small" variant="outlined" label={n.title} />
              ))}
            </Stack>
          )}
        </Box>
      </Collapse>
    </Card>
  );
}

const nodeTypes = { session: SessionCard, plan: PlanCard };

export default function PlansView() {
  const [openSession, setOpenSession] = useState(null);
  const [openPlan, setOpenPlan] = useState(null);

  // Newest-first snake: 6 per row, rows grow downward.
  const sessions = useMemo(() => [...MOCK_SESSIONS].sort((a, b) => new Date(b.mtime) - new Date(a.mtime)), []);

  const toggleSession = useCallback((sid) => {
    setOpenSession((cur) => (cur === sid ? null : sid));
    setOpenPlan(null);
  }, []);
  const togglePlan = useCallback((key) => setOpenPlan((cur) => (cur === key ? null : key)), []);

  const { nodes, edges } = useMemo(() => {
    const ns = [];
    const es = [];
    sessions.forEach((s, i) => {
      const x = (i % COLS) * COL_PITCH;
      const y = Math.floor(i / COLS) * ROW_PITCH;
      const expanded = openSession === s.sid;
      ns.push({
        id: s.sid,
        type: 'session',
        position: { x, y },
        draggable: false,
        data: { session: s, expanded, onToggle: () => toggleSession(s.sid) },
      });
      if (!expanded) return;
      s.plans.forEach((p, j) => {
        const key = `${s.sid}:${p.file}`;
        ns.push({
          id: key,
          type: 'plan',
          position: { x: x + COL_PITCH, y: y + j * PLAN_PITCH },
          draggable: false,
          zIndex: 10,
          data: {
            plan: p,
            notes: s.notes.filter((n) => !n.plan || n.plan === p.file),
            expanded: openPlan === key,
            onToggle: () => togglePlan(key),
          },
        });
        es.push({ id: `e-${key}`, source: s.sid, target: key, type: 'smoothstep' });
      });
    });
    return { nodes: ns, edges: es };
  }, [sessions, openSession, openPlan, toggleSession, togglePlan]);

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={noop}
        panOnScroll
        zoomOnPinch
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        minZoom={0.2}
        maxZoom={1.5}
      >
        <Background gap={24} />
        <MiniMap pannable zoomable />
      </ReactFlow>
      <Typography variant="caption" sx={{ position: 'absolute', bottom: 8, left: 8, color: 'text.disabled', pointerEvents: 'none' }}>
        POC — mock data
      </Typography>
    </Box>
  );
}
