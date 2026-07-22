import React from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MermaidBlock from '@/components/MermaidBlock.jsx';

// Shared markdown renderer used by WikiPanel + SkillsPanel. Carries the common
// prose styling (moved out of WikiPanel's inline render box) and routes
// ```mermaid fences through MermaidBlock (escaped from the <pre> code-block
// framing so diagrams aren't boxed like code). Links open in a new tab.
const preRenderer = ({ children }) => {
  // children is the inner <code> element; detect a mermaid fence and render
  // the diagram in a plain centered box instead of a styled <pre>.
  const codeEl = Array.isArray(children) ? children[0] : children;
  const cls = codeEl?.props?.className || '';
  if (/\blanguage-mermaid\b/.test(cls)) {
    return <Box sx={{ my: 1.5, overflow: 'auto' }}><MermaidBlock chart={codeEl.props.children} /></Box>;
  }
  return <pre>{children}</pre>;
};

// [[target|label]] / [[target]] → markdown link with a wiki: scheme so the `a`
// renderer can intercept the click. Target is URL-encoded so pipes/spaces don't
// break link parsing.
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const expandWikilinks = (src) => src.replace(WIKILINK_RE, (_, target, label) =>
  `[${label || target}](wiki:${encodeURIComponent(target.trim())})`);

export default function MarkdownBody({ children, onWikiLink }) {
  const src = onWikiLink ? expandWikilinks(children || '') : children;
  const anchor = (p) => {
    if (onWikiLink && p.href?.startsWith('wiki:')) {
      const target = decodeURIComponent(p.href.slice(5));
      return <Link {...p} href="#" onClick={(e) => { e.preventDefault(); onWikiLink(target); }} sx={{ cursor: 'pointer' }} />;
    }
    return <Link {...p} target="_blank" rel="noopener noreferrer" />;
  };
  return (
    <Box sx={(t) => ({
      '& :is(h1,h2,h3,h4,h5,h6)': { fontWeight: 700, mt: 2.5, mb: 1, lineHeight: 1.25, '&:first-of-type': { mt: 0 } },
      '& h1': { fontSize: 24 }, '& h2': { fontSize: 20 }, '& h3': { fontSize: 17 }, '& h4,& h5,& h6': { fontSize: 15 },
      '& p': { my: 1.25, lineHeight: 1.7, fontSize: 14 },
      '& ul,& ol': { pl: 3, my: 1.25, lineHeight: 1.7, fontSize: 14, '& li': { my: 0.4, '&::marker': { color: t.vars.palette.text.secondary } } },
      '& :is(ul,ol) :is(ul,ol)': { my: 0.4 },
      '& blockquote': { ml: 0, pl: 2, my: 1.5, borderLeft: `3px solid ${t.vars.palette.glass.stroke}`, color: 'text.secondary' },
      '& a': { color: 'primary.main' },
      '& :is(code,pre)': { fontFamily: 'var(--mui-font-CodeFont, monospace)', fontSize: 13 },
      '& :not(pre) > code': { px: 0.5, py: 0.15, borderRadius: '4px', bgcolor: 'action.hover', fontSize: '0.9em' },
      '& pre': { p: 1.5, my: 1.5, overflow: 'auto', borderRadius: `${t.zapac.radius.sm}px`, bgcolor: 'action.hover', border: `1px solid ${t.vars.palette.glass.stroke}` },
      '& hr': { border: 'none', borderTop: `1px solid ${t.vars.palette.glass.stroke}`, my: 2.5 },
      '& table': { borderCollapse: 'collapse', my: 1.5, width: '100%', fontSize: 13 },
      '& th,& td': { border: `1px solid ${t.vars.palette.glass.stroke}`, px: 1, py: 0.75, textAlign: 'left' },
      '& th': { bgcolor: 'action.hover', fontWeight: 700 },
      '& img': { maxWidth: '100%' },
    })}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (url.startsWith('wiki:') ? url : defaultUrlTransform(url))}
        components={{ a: anchor, pre: preRenderer }}>
        {src}
      </ReactMarkdown>
    </Box>
  );
}