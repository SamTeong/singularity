// Plans board — plan sessions as cards on a React Flow canvas ("Plans 2D").
// Real data: GET /api/plans/sessions (list) + /api/plans/session?sid= (detail,
// fetched on expand). planBadge is a pure helper from plansMockData.mjs.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, MiniMap, Controls, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Collapse from '@mui/material/Collapse';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useQueryState } from '@/hooks/useQueryState.js';
import { planBadge } from './plansMockData.mjs';

const NODE_W = 280;
const COLS = 6;
const COL_PITCH = 320;
const ROW_PITCH = 240;
const PLAN_PITCH = 250;

const BUCKETS = ['active', 'done', 'blocked', 'superseded', 'other'];
const STATUS_COLOR = { active: 'primary', done: 'success', blocked: 'error', superseded: 'warning', other: 'default' };
const statusColor = (s) => STATUS_COLOR[s] ?? 'default';
const dotColor = (s) => (s === 'other' ? 'text.disabled' : `${statusColor(s)}.main`);
const PHASE_GLYPH = { done: '✓', open: '○', skipped: '−' };

// mtime arrives as epoch ms from the server; the date-parse also accepts an ISO
// string, so both shapes render.
const relTime = (ms) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(ms).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

const fmtTokens = (n) => (n == null ? null : `${Math.round(n / 1000)}k tokens`);

const noop = () => {};

function SessionCard({ data }) {
  const { session, expanded, dimmed, onToggle } = data;
  const active = BUCKETS.filter((b) => (session.statusBuckets?.[b] ?? 0) > 0);
  const tokens = fmtTokens(session.contextTokens);
  return (
    <Card
      variant="outlined"
      sx={{
        width: NODE_W,
        borderColor: expanded ? 'primary.main' : undefined,
        // VERIFY: refine-dim
        opacity: dimmed ? 0.25 : 1,
        pointerEvents: dimmed ? 'none' : 'auto',
      }}
    >
      <Handle type="source" position={Position.Right} />
      <CardActionArea onClick={onToggle} sx={{ p: 1.5, userSelect: 'text' }}>
        <Stack spacing={0.75}>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
              {session.sid.slice(0, 8)}
            </Typography>
            <Stack direction="row" spacing={0.5}>
              {active.map((s) => (
                <Box key={s} sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: dotColor(s) }} />
              ))}
            </Stack>
          </Stack>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
            {session.branch && (
              <Chip size="small" variant="outlined" label={session.branch} sx={{ maxWidth: '100%' }} />
            )}
            {tokens && (
              <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                {tokens}
              </Typography>
            )}
          </Stack>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
              {relTime(session.mtime)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {session.planCount} plan{session.planCount === 1 ? '' : 's'}
              {expanded ? ' · click to collapse' : ' · click to expand'}
            </Typography>
          </Stack>
        </Stack>
      </CardActionArea>
    </Card>
  );
}

function PlanCard({ data }) {
  const { plan, notes, expanded, onToggle } = data;
  return (
    <Card variant="outlined" sx={{ width: NODE_W }}>
      <Handle type="target" position={Position.Left} />
      <CardActionArea onClick={onToggle} sx={{ p: 1.25, userSelect: 'text' }}>
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

// Placeholder node under an expanded session while its detail request is in
// flight, or when it failed (retry re-runs the fetch).
function InfoCard({ data }) {
  const { loading, error, onRetry } = data;
  return (
    <Card variant="outlined" sx={{ width: NODE_W, p: 1.5 }}>
      <Handle type="target" position={Position.Left} />
      {loading ? (
        <Stack sx={{ alignItems: 'center', py: 1 }}>
          <CircularProgress size={20} />
        </Stack>
      ) : (
        <Stack spacing={1} sx={{ alignItems: 'center', py: 0.5 }}>
          <Typography variant="caption" color="error">
            {error}
          </Typography>
          <Button size="small" variant="outlined" onClick={onRetry}>
            Retry
          </Button>
        </Stack>
      )}
    </Card>
  );
}

const nodeTypes = { session: SessionCard, plan: PlanCard, info: InfoCard };

export default function PlansView() {
  const [list, setList] = useState(null);
  const [listError, setListError] = useState(null);
  const [listNonce, setListNonce] = useState(0);
  const [openSession, setOpenSession] = useState(null);
  const [openPlan, setOpenPlan] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailErr, setDetailErr] = useState(null);
  const [retry, setRetry] = useState(0);
  const [status, setStatus] = useQueryState('status', 'all');

  // VERIFY: refine-fetch
  useEffect(() => {
    let cancelled = false;
    fetch('/api/plans/sessions')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (!cancelled) setList(j);
      })
      .catch((e) => {
        if (!cancelled) setListError(String(e.message || e));
      });
    return () => {
      cancelled = true;
    };
  }, [listNonce]);

  useEffect(() => {
    if (!openSession) return undefined;
    let cancelled = false;
    fetch('/api/plans/session?sid=' + encodeURIComponent(openSession))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (cancelled) return;
        setDetail(j);
        setDetailErr(null);
      })
      .catch((e) => {
        if (!cancelled) setDetailErr({ sid: openSession, message: String(e.message || e) });
      });
    return () => {
      cancelled = true;
    };
  }, [openSession, retry]);

  const retryList = useCallback(() => {
    setListError(null);
    setListNonce((n) => n + 1);
  }, []);

  const toggleSession = useCallback((sid) => {
    setOpenSession((cur) => (cur === sid ? null : sid));
    setOpenPlan(null);
  }, []);
  const togglePlan = useCallback((key) => setOpenPlan((cur) => (cur === key ? null : key)), []);

  // VERIFY: refine-filter
  const sessions = useMemo(() => {
    const rows = list ?? [];
    const kept = status === 'all' ? rows : rows.filter((s) => (s.statusBuckets?.[status] ?? 0) > 0);
    return [...kept].sort((a, b) => b.mtime - a.mtime);
  }, [list, status]);

  // Detail counts only when it belongs to the open session — a stale row from a
  // previously expanded session is ignored rather than cleared in an effect.
  const openDetail = detail && detail.sid === openSession ? detail : null;
  const openErr = detailErr && detailErr.sid === openSession ? detailErr.message : null;
  const detailLoading = openSession !== null && openDetail == null && openErr == null;

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
        data: { session: s, expanded, dimmed: openSession !== null && !expanded, onToggle: () => toggleSession(s.sid) },
      });
      if (!expanded) return;
      if (openDetail == null) {
        ns.push({
          id: `${s.sid}:info`,
          type: 'info',
          position: { x: x + COL_PITCH, y },
          draggable: false,
          zIndex: 10,
          data: { loading: detailLoading, error: openErr, onRetry: () => setRetry((n) => n + 1) },
        });
        return;
      }
      openDetail.plans.forEach((p, j) => {
        const key = `${s.sid}:${p.file}`;
        ns.push({
          id: key,
          type: 'plan',
          position: { x: x + COL_PITCH, y: y + j * PLAN_PITCH },
          draggable: false,
          zIndex: 10,
          data: {
            plan: p,
            notes: openDetail.notes.filter((n) => !n.plan || n.plan === p.file),
            expanded: openPlan === key,
            onToggle: () => togglePlan(key),
          },
        });
        es.push({ id: `e-${key}`, source: s.sid, target: key, type: 'smoothstep' });
      });
    });
    return { nodes: ns, edges: es };
  }, [sessions, openSession, openPlan, openDetail, detailLoading, openErr, toggleSession, togglePlan]);

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={noop}
        // VERIFY: refine-panondrag
        panOnDrag={[0, 1, 2]}
        panOnScroll={false}
        zoomOnScroll
        zoomOnPinch
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        minZoom={0.2}
        maxZoom={1.5}
      >
        <Background gap={24} />
        <MiniMap pannable zoomable />
        <Controls />
      </ReactFlow>
      <Stack
        direction="row"
        spacing={0.5}
        sx={{ position: 'absolute', top: 8, left: 8, zIndex: 5, flexWrap: 'wrap', gap: 0.5 }}
      >
        {['all', ...BUCKETS].map((b) => (
          <Chip
            key={b}
            size="small"
            label={b}
            color={status === b ? 'primary' : 'default'}
            variant={status === b ? 'filled' : 'outlined'}
            onClick={() => setStatus(b)}
          />
        ))}
      </Stack>
      {list == null && listError == null && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 20 }}>
          <CircularProgress />
        </Box>
      )}
      {listError != null && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 20 }}>
          <Stack spacing={1} sx={{ alignItems: 'center' }}>
            <Typography variant="body2" color="error">
              {listError}
            </Typography>
            <Button size="small" variant="outlined" onClick={retryList}>
              Retry
            </Button>
          </Stack>
        </Box>
      )}
    </Box>
  );
}
