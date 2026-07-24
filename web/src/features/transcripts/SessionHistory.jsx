import { getTokens } from '@/theme/contract.js';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import IconButton from '@mui/material/IconButton';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChatBubbleOutlinedIcon from '@mui/icons-material/ChatBubbleOutlined';
import SubjectIcon from '@mui/icons-material/Subject';
import HistoryIcon from '@mui/icons-material/History';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { EmptyState } from '@zapac/mui-theme';
import TranscriptView from '@/features/transcripts/TranscriptView.jsx';
import DirPicker from '@/components/DirPicker.jsx';
import { tildify, untildify } from '@/lib/paths.js';
import { fmtUsd, fmtTokens, relTime } from '@/lib/format.js';
import Rail from '@/components/panelkit/Rail.jsx';
import RailSearch from '@/components/panelkit/RailSearch.jsx';

// Transcripts root persists across sessions on the daemon FS. Default
// ~/.claude/projects; loaded from /sessions/root on mount.
const DEFAULT_ROOT = '~/.claude/projects';

const shortModel = (id) => id.match(/opus|sonnet|haiku|fable|mythos/i)?.[0].toLowerCase() || id;

// Small pulsing status dot for running sessions/subagents.
function PulseDot({ sx }) {
  return (
    <Box
      sx={{
        width: 8, height: 8, borderRadius: '50%', bgcolor: 'success.main', flexShrink: 0,
        animation: 'sing-pulse-dot 1.4s ease-in-out infinite',
        '@keyframes sing-pulse-dot': {
          '0%': { opacity: 1, transform: 'scale(1)' },
          '50%': { opacity: 0.4, transform: 'scale(0.75)' },
          '100%': { opacity: 1, transform: 'scale(1)' },
        },
        // Reduced-motion: hold the steady (opacity 1, scale 1) state instead of animating.
        '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        ...sx,
      }}
    />
  );
}

export default function SessionHistory({ active, sendMsg, registerChat }) {
  const [sessions, setSessions] = useState([]);
  const [sel, setSel] = useState(null); // {project, id, title, cwd}
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('all'); // 'all' | 'one' — search + chat context
  const [tab, setTab] = useState('view'); // 'view' | 'chat'
  const [transcript, setTranscript] = useState(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [matches, setMatches] = useState(null); // cross-session results (scope 'all')
  const [capped, setCapped] = useState(false);
  const [chatMsgs, setChatMsgs] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [stats, setStats] = useState({}); // id -> { costUsd, costSource, inputTokens, ... }
  const [loadErr, setLoadErr] = useState(null);
  const [sessErr, setSessErr] = useState(null);
  const [expanded, setExpanded] = useState(new Set()); // "project:id" -> subagent tree expanded
  const [root, setRoot] = useState(DEFAULT_ROOT);
  const [picking, setPicking] = useState(false);
  const chatBoxRef = useRef(null);
  const chatIdRef = useRef(null);

  // Load the FS-persisted root once on mount (sessions load via the [root] effect).
  useEffect(() => {
    fetch('/sessions/root').then((r) => r.json()).then((d) => { if (d.root) setRoot(d.root); }).catch(() => {});
  }, []);

  // Poll the session list only while the Sessions view is active — avoids
  // background fetches when the panel is mounted-but-hidden behind another view.
  useEffect(() => {
    if (!active) return;
    const load = () => fetch(`/sessions?root=${encodeURIComponent(untildify(root))}`).then((r) => r.json()).then((d) => setSessions(d.sessions || [])).catch(() => setSessErr('Failed to load transcripts.'));
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [root, active]);

  // Cross-session search (scope 'all'): results replace the left list, like
  // Memory. Scope 'one' filters the open transcript in the right view instead.
  const searchAll = useCallback((query) => {
    if (!query.trim()) { setMatches(null); setCapped(false); return; }
    fetch(`/sessions/search?q=${encodeURIComponent(query.trim())}&root=${encodeURIComponent(untildify(root))}`).then((r) => r.json()).then((d) => {
      setMatches(d.results || []); setCapped(!!d.capped);
    });
  }, [root]);
  useEffect(() => { if (scope === 'all') { const id = setTimeout(() => searchAll(q), 250); return () => clearTimeout(id); } }, [q, scope, root, searchAll]);

  // Batch-fetch cost + token breakdown; merge into the id-keyed stats map.
  const loadStats = useCallback((items) => {
    const list = (items || []).filter((it) => it?.project && it?.id).map((it) => ({ project: it.project, id: it.id }));
    if (!list.length) return;
    fetch('/sessions/stats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: list, root: untildify(root) }) })
      .then((r) => r.json()).then((d) => setStats((prev) => ({ ...prev, ...(d.stats || {}) }))).catch(() => {});
  }, [root]);

  const open = (item) => {
    if (item.project === sel?.project && item.id === sel?.id) return;
    setSel(item); setMatches(null); setQ(''); setLoadErr(null);
    loadStats([item]); // ensure detail-header stats even when opened from search
    setLoadingFile(true);
    fetch(`/session?project=${encodeURIComponent(item.project)}&id=${encodeURIComponent(item.id)}&root=${encodeURIComponent(untildify(root))}`).then((r) => r.json()).then((d) => {
      setTranscript(d.ok ? d : null);
    }).catch(() => { setTranscript(null); setLoadErr('Failed to load transcript.'); }).finally(() => setLoadingFile(false));
  };

  const pickRoot = (p) => {
    setRoot(p); setPicking(false);
    setSel(null); setTranscript(null); setMatches(null); setQ(''); setPage(1);
    fetch('/sessions/root', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: p }) }).catch(() => {});
  };

  // Chat: stream deltas from the WS into the last assistant message.
  useEffect(() => {
    if (!registerChat) return;
    registerChat((m) => {
      if (m.chatId !== chatIdRef.current) return; // stale/superseded chat — ignore
      if (m.t === 'chat:delta') {
        setChatMsgs((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && last.streaming) last.content += m.text;
          else next.push({ role: 'assistant', content: m.text, streaming: true });
          return next;
        });
      } else if (m.t === 'chat:done') {
        setChatMsgs((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.role === 'assistant') last.streaming = false;
          return next;
        });
        setStreaming(false);
      } else if (m.t === 'chat:error') {
        setStreaming(false);
        setAuthNeeded(!!m.needsAuth);
        setChatMsgs((prev) => [...prev, { role: 'assistant', content: m.msg, error: true }]);
      }
    });
  }, [registerChat]);

  // Keep the chat scrolled to the latest delta.
  useEffect(() => { chatBoxRef.current?.scrollTo({ top: chatBoxRef.current.scrollHeight, behavior: 'smooth' }); }, [chatMsgs]);

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text || streaming) return;
    const history = chatMsgs.filter((m) => m.content).map((m) => ({ role: m.role, content: m.content }));
    const chatId = (crypto?.randomUUID?.() || String(Date.now() + Math.random()));
    chatIdRef.current = chatId;
    setChatMsgs((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '', streaming: true }]);
    setStreaming(true); setAuthNeeded(false); setChatInput('');
    const one = scope === 'one' && sel;
    sendMsg({ t: 'chat', chatId, scope: one ? 'one' : 'all', project: one ? sel.project : null, id: one ? sel.id : null, question: text, history, root: untildify(root) });
  };

  // scope 'one' needs a selected session; fall back to 'all' when none.
  const effScope = scope === 'one' && !sel ? 'all' : scope;
  const searching = !!q.trim();
  const leftResults = searching && effScope === 'all' ? (matches || []) : null;
  const viewMsgs = transcript?.messages || [];
  const viewFiltered = searching && effScope === 'one'
    ? viewMsgs.filter((m) => (m.text || '').toLowerCase().includes(q.trim().toLowerCase()))
    : viewMsgs;

  // Pagination over whatever the left list shows (all sessions, or cross-session
  // search results). Scope 'one' search filters the right view, not this list.
  const leftList = leftResults ?? sessions;
  const pageCount = Math.max(1, Math.ceil(leftList.length / pageSize));
  const curPage = Math.min(page, pageCount);
  const pageItems = leftList.slice((curPage - 1) * pageSize, curPage * pageSize);
  useEffect(() => { setPage(1); }, [q, scope, pageSize]);
  // Fetch cost/tokens for the visible session rows (not the per-match search rows).
  const pageKey = pageItems.map((s) => s.id).join(',');
  useEffect(() => { if (!leftResults) loadStats(pageItems); /* eslint-disable-line */ }, [pageKey, leftResults, loadStats]);

  return (
    <Box sx={{ height: '100%', display: 'flex', minHeight: 0 }}>
      {/* left: search + session list (collapsible) */}
      <Rail storageKey="sing-sesshist-w" defaultWidth={340} collapsedTitle="Show transcripts">
        {({ collapse }) => (
          <>
            <Box sx={{ p: 1.5, pb: 0.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <RailSearch placeholder="Search transcripts…" value={q} onChange={setQ} />
                <Tooltip title="Select transcripts folder" placement="bottom" disableInteractive>
                  <IconButton size="small" onClick={() => setPicking(true)}><FolderOpenIcon /></IconButton>
                </Tooltip>
                <IconButton size="small" onClick={collapse}><ChevronLeftIcon /></IconButton>
              </Stack>
              <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, mt: 1, ml: 2, display: 'block' }} noWrap>{tildify(root)}</Typography>
              <Stack direction="row" spacing={0.5} sx={{ mt: 1 }}>
                {['all', 'one'].map((s) => (
                  <Tooltip key={s} title={s === 'one' ? 'Search + chat about the selected transcript' : 'Search + chat across all transcripts'}>
                    {/* span: Tooltip needs a live event target — a disabled button fires none. */}
                    <span>
                      <Button
                        size="small"
                        variant={effScope === s ? 'contained' : 'outlined'}
                        disabled={s === 'one' && !sel}
                        onClick={() => setScope(s)}
                        sx={{ px: 1.5, minWidth: 0, fontSize: 12, textTransform: 'none' }}
                      >{s === 'all' ? 'All' : 'This transcript'}</Button>
                    </span>
                  </Tooltip>
                ))}
              </Stack>
              <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, mt: 1, ml: 2, display: 'block' }}>
                {leftResults ? `${leftResults.length}${capped ? '+ (capped)' : ''} matches` : `${sessions.length} transcript${sessions.length === 1 ? '' : 's'}`}
              </Typography>
            </Box>
            <List dense sx={{ flex: 1, overflow: 'auto', px: 0.5, pt: 0 }}>
              {leftResults ? (
                pageItems.map((r, i) => (
                  <ListItemButton key={`${r.project}:${r.id}:${r.lineIndex}:${i}`} onClick={() => open({ project: r.project, id: r.id, title: r.id, cwd: r.cwd })} sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, display: 'block', mb: 0.25 }}>
                    <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }} noWrap>{tildify(r.cwd) || r.project}</Typography>
                    <Typography sx={{ fontSize: 12, color: 'text.secondary' }} noWrap>[{r.role}] {r.snippet}</Typography>
                  </ListItemButton>
                ))
              ) : (
                pageItems.map((s) => {
                  const skey = `${s.project}:${s.id}`;
                  const hasSubs = !!s.subagents?.length;
                  const isExpanded = expanded.has(skey);
                  const toggleExpanded = (e) => {
                    e.stopPropagation();
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(skey)) next.delete(skey); else next.add(skey);
                      return next;
                    });
                  };
                  return (
                    <React.Fragment key={skey}>
                      <ListItemButton
                        selected={sel?.project === s.project && sel?.id === s.id}
                        onClick={() => open(s)}
                        sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, display: 'block', mb: 0.25 }}
                      >
                        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                          {hasSubs && (
                            <IconButton size="small" onClick={toggleExpanded} sx={{ p: 0.25, ml: -0.5 }}>
                              {isExpanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
                            </IconButton>
                          )}
                          <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0 }}>{s.title || `${s.id.slice(0, 8)}…`}</Typography>
                          {s.running && <PulseDot />}
                          {hasSubs && !isExpanded && (
                            <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>⚡{s.subagents.length} subagents</Typography>
                          )}
                        </Stack>
                        <Stack direction="row" spacing={1} sx={{ mt: 0.25, alignItems: 'center' }}>
                          <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }} noWrap>{tildify(s.cwd) || s.project}</Typography>
                        </Stack>
                        <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, display: 'block' }}>
                          {relTime(s.mtime)}{stats[s.id]?.costUsd != null ? ` · ${fmtUsd(stats[s.id].costUsd)}` : ''}
                        </Typography>
                      </ListItemButton>
                      {hasSubs && (
                        <Collapse in={isExpanded}>
                          {s.subagents.map((sub) => (
                            <ListItemButton
                              key={sub.id}
                              selected={sel?.project === s.project && sel?.id === sub.id}
                              onClick={() => open({ project: s.project, id: sub.id, title: sub.title || sub.agentId, cwd: s.cwd, mtime: sub.mtime })}
                              sx={{ borderRadius: (t) => `${getTokens(t).radius.sm}px`, display: 'block', mb: 0.25, pl: 3 }}
                            >
                              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                                <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0, fontSize: 12 }}>{sub.title || sub.agentId}</Typography>
                                {sub.running && <PulseDot />}
                              </Stack>
                              <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, display: 'block' }}>{relTime(sub.mtime)}</Typography>
                            </ListItemButton>
                          ))}
                        </Collapse>
                      )}
                    </React.Fragment>
                  );
                })
              )}
              {!leftResults && sessions.length === 0 && <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>{sessErr || 'No transcripts.'}</Typography>}
              {leftResults && leftResults.length === 0 && <Typography sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>No matches.</Typography>}
            </List>
            <Box sx={(t) => ({ width: '100%', display: 'flex', justifyContent: 'center', py: 1, borderTop: `1px solid ${getTokens(t).glass.stroke}`, flexShrink: 0 })}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Select size="small" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} sx={{ height: 34, '& .MuiSelect-select': { py: 0.5, fontSize: 12 } }}>
                  {[25, 50, 100].map((n) => <MenuItem key={n} value={n}>{n}</MenuItem>)}
                </Select>
                <IconButton size="small" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}><ChevronLeftIcon /></IconButton>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 52, height: 34 }}>
                  <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1 }}>{leftList.length ? `${curPage}/${pageCount}` : '—'}</Typography>
                </Box>
                <IconButton size="small" disabled={curPage >= pageCount} onClick={() => setPage(curPage + 1)}><ChevronRightIcon /></IconButton>
              </Stack>
            </Box>
          </>
        )}
      </Rail>

      {/* right: View / Chat */}
      <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0 }} spacing={0}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 1.5, py: 1, borderBottom: (t) => `1px solid ${getTokens(t).glass.stroke}` }}>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 36, flex: 1 }}>
            <Tab icon={<SubjectIcon />} iconPosition="start" value="view" label="View" sx={{ minHeight: 36, textTransform: 'none' }} />
            <Tab icon={<ChatBubbleOutlinedIcon />} iconPosition="start" value="chat" label="Chat" sx={{ minHeight: 36, textTransform: 'none' }} />
          </Tabs>
          {tab === 'chat' && (
            <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }} noWrap>
              {effScope === 'one' && sel ? `Referring to: ${sel.title || sel.id}` : 'Referring to all transcripts'}
            </Typography>
          )}
        </Stack>

        {tab === 'view' ? (
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 2 }}>
            {!sel ? (
              <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
                <EmptyState icon={<HistoryIcon />} title="Select a transcript" description="Browse your past transcripts on this machine." />
              </Box>
            ) : loadingFile ? (
              <Typography color="text.secondary">Loading…</Typography>
            ) : !transcript ? (
              <Typography color="text.secondary">{loadErr || 'Transcript not found.'}</Typography>
            ) : (
              <>
                <Typography variant="subtitle2" noWrap>{transcript.meta?.title || sel?.title || sel?.id}</Typography>
                <Stack direction="row" spacing={1.5} sx={{ mb: 0.5 }}>
                  <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }} noWrap>{tildify(transcript.meta?.cwd || sel?.cwd)}</Typography>
                  <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11 }}>{transcript.meta?.turns ?? 0} turns · {relTime(sel.mtime)}</Typography>
                </Stack>
                {sel && stats[sel.id] && (
                  <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, display: 'block', mb: 1.5 }}>
                    {fmtTokens(stats[sel.id].inputTokens)} sent · {fmtTokens(stats[sel.id].outputTokens)} received · {fmtTokens(stats[sel.id].cacheReadTokens)} reused from cache · {fmtTokens(stats[sel.id].cacheWriteTokens)} saved to cache
                    {stats[sel.id].models?.length ? ` · ${stats[sel.id].models.map(shortModel).join(', ')}` : ''}
                    {stats[sel.id].costUsd != null ? ` · ${fmtUsd(stats[sel.id].costUsd)} ${stats[sel.id].costSource === 'statusline' ? 'measured' : 'estimated'}` : ''}
                  </Typography>
                )}
                {searching && effScope === 'one' && (
                  <Typography variant="code" sx={{ color: 'text.secondary', fontSize: 11, mb: 1.5 }}>
                    {viewFiltered.length} match{viewFiltered.length === 1 ? '' : 'es'} in this transcript
                  </Typography>
                )}
                <TranscriptView messages={viewFiltered} />
              </>
            )}
          </Box>
        ) : (
          /* chat */
          <Stack sx={{ flex: 1, minHeight: 0 }}>
            <Box ref={chatBoxRef} sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 2 }}>
              {chatMsgs.length === 0 && (
                <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
                  <EmptyState
                    icon={<ChatBubbleOutlinedIcon />}
                    title={effScope === 'one' && sel ? `Ask about this transcript` : 'Ask across all transcripts'}
                    description={effScope === 'one' && sel ? 'It can see this transcript.' : 'It can see a list of your recent transcripts. Switch to "This transcript" for full detail.'}
                  />
                </Box>
              )}
              <Stack spacing={1.5}>
                {chatMsgs.map((m, i) => (
                  <Box key={i} sx={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                    <Box sx={(t) => ({
                      px: 1.5, py: 1, borderRadius: `${getTokens(t).radius.sm}px`,
                      bgcolor: m.error ? 'error.main' : m.role === 'user' ? 'primary.main' : (getTokens(t).glass.surface),
                      color: m.error || m.role === 'user' ? 'common.white' : 'text.primary',
                      border: m.role === 'assistant' && !m.error ? `1px solid ${getTokens(t).glass.stroke}` : 'none',
                    })}>
                      <Typography sx={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content || (m.streaming ? '…' : '')}</Typography>
                    </Box>
                  </Box>
                ))}
              </Stack>
            </Box>
            <Stack direction="row" spacing={1} sx={{ p: 1.5, borderTop: (t) => `1px solid ${getTokens(t).glass.stroke}` }}>
              <TextField
                size="small" multiline maxRows={4} fullWidth
                placeholder={authNeeded ? 'Sign in to chat…' : (streaming ? 'Generating…' : 'Ask about this transcript…')}
                value={chatInput} disabled={streaming || authNeeded}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
              />
              <Button size="small" variant="contained" onClick={sendChat} disabled={streaming || authNeeded || !chatInput.trim()}>Send</Button>
            </Stack>
          </Stack>
        )}
      </Stack>

      {picking && <DirPicker start={untildify(root)} onPick={pickRoot} onClose={() => setPicking(false)} />}
    </Box>
  );
}