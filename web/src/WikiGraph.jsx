import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme, useColorScheme } from '@mui/material/styles';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { untildify } from './paths.js';

cytoscape.use(fcose);

// Categorical node palette (keyed by category order). Brand-neutral, readable
// on both themes.
const PALETTE = ['#6ea8fe', '#63c8a0', '#e0a458', '#c98bdb', '#e07a8b', '#7bc4c4', '#b0b34a'];

// Force-directed graph of one wiki's pages (nodes) and [[wikilinks]] (edges).
// Rendered to canvas, so colors must be concrete — theme.palette.* (not the
// var() strings in theme.vars). Clicking a node opens that page.
export default function WikiGraph({ root, wiki, selected, onOpenPage }) {
  const ref = useRef(null);
  const cyRef = useRef(null);
  const openRef = useRef(onOpenPage); // tap handler binds once; keep it pointing at the latest callback
  openRef.current = onOpenPage;
  const theme = useTheme();
  const { mode, systemMode } = useColorScheme();
  const dark = (mode === 'system' ? systemMode : mode) === 'dark';
  const [state, setState] = useState({ loading: true, error: null, empty: false });

  useEffect(() => {
    let cy;
    let cancelled = false;
    setState({ loading: true, error: null, empty: false });
    fetch(`/wiki/graph?root=${encodeURIComponent(untildify(root))}&wiki=${encodeURIComponent(wiki)}`)
      .then((r) => r.json()).then((d) => {
        if (cancelled) return;
        if (d.error) { setState({ loading: false, error: d.error, empty: false }); return; }
        if (!d.nodes?.length) { setState({ loading: false, error: null, empty: true }); return; }
        setState({ loading: false, error: null, empty: false });
        const cats = [...new Set(d.nodes.map((n) => n.category))];
        const colorOf = (c) => PALETTE[Math.max(0, cats.indexOf(c)) % PALETTE.length];
        const stroke = theme.palette.divider;
        cy = cytoscape({
          container: ref.current,
          elements: [
            ...d.nodes.map((n) => ({ data: { id: n.id, label: n.label, color: colorOf(n.category) } })),
            ...d.edges.map((e) => ({ data: { source: e.source, target: e.target } })),
          ],
          style: [
            { selector: 'node', style: {
              'background-color': 'data(color)', label: 'data(label)', 'font-size': 9,
              color: dark ? '#fff' : '#111', 'text-valign': 'bottom', 'text-margin-y': 3,
              width: 16, height: 16, 'min-zoomed-font-size': 6,
            } },
            { selector: 'node:selected', style: { 'border-width': 3, 'border-color': theme.palette.primary.main } },
            { selector: 'edge', style: {
              width: 1, 'line-color': stroke, 'target-arrow-color': stroke,
              'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.7, opacity: 0.7,
            } },
            { selector: '.hidden', style: { display: 'none' } },
          ],
          layout: { name: 'fcose', animate: false, quality: 'default', nodeRepulsion: 8000, idealEdgeLength: 80 },
          wheelSensitivity: 1.5,
        });
        cy.on('tap', 'node', (evt) => openRef.current(evt.target.id()));
        cyRef.current = cy;
      }).catch(() => { if (!cancelled) setState({ loading: false, error: 'failed to load graph', empty: false }); });
    return () => { cancelled = true; cyRef.current = null; if (cy) cy.destroy(); };
  }, [root, wiki, theme, dark]);

  // Sync selection from the left panel: show ONLY the matching node (as the
  // concentric root) plus its first-degree neighbors; hide all others.
  // No selection → show the full graph again.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.$('node:selected').unselect();
    const node = selected ? cy.getElementById(selected) : null;
    if (!node || node.empty()) {
      cy.elements().removeClass('hidden');
      cy.layout({ name: 'fcose', animate: false, nodeRepulsion: 8000, idealEdgeLength: 80 }).run();
      cy.fit(undefined, 30);
      return;
    }
    const nb = node.closedNeighborhood(); // node + adjacent nodes + connecting edges
    cy.elements().addClass('hidden');
    nb.removeClass('hidden');
    node.select();
    nb.layout({ name: 'concentric', animate: false, concentric: (n) => (n.same(node) ? 2 : 1), levelWidth: () => 1, minNodeSpacing: 40 }).run();
    cy.fit(nb, 40);
  }, [selected, state.loading]);

  return (
    <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
      <Box ref={ref} sx={(t) => ({
        position: 'absolute', inset: 0,
        border: `1px solid ${t.vars.palette.glass.stroke}`, borderRadius: `${t.zapac.radius.sm}px`,
      })} />
      {(state.loading || state.error || state.empty) && (
        <Stack sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <Typography color="text.secondary">
            {state.loading ? 'Loading graph…' : state.error || 'No links in this wiki.'}
          </Typography>
        </Stack>
      )}
    </Box>
  );
}
