import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AgentsProvider } from '@/providers/AgentsProvider.jsx';
import AppShell from '@/shell/AppShell.jsx';
import { VIEWS } from '@/shell/views.mjs';

// Bare `/` resumes the last-visited view. localStorage is no longer the source
// of truth for `view` (the URL is) — just the "where was I" memory this reads.
function DefaultRedirect() {
  const saved = localStorage.getItem('sing-view');
  return <Navigate replace to={`/${VIEWS.has(saved) ? saved : 'tasks'}`} />;
}

// Validation lives here, at the route boundary, not in AppShell: masking an
// unknown id (`VIEWS.has(v) ? v : 'tasks'`) would render Tasks while leaving
// /nonsense in the address bar — a URL that no longer describes the screen and
// that a reload or a share reproduces. Redirect instead, `replace` so a typo'd
// URL leaves no dead entry in the back stack. AppShell can then trust `view`.
function ViewRoute() {
  const { view } = useParams();
  if (!VIEWS.has(view)) return <Navigate replace to="/tasks" />;
  return <AppShell />;
}

// App is the composition root: the router and the domain-state boundary
// (AgentsProvider) around the shell. Theme/colour boundaries live above this,
// in main.jsx. AgentsProvider sits *outside* <Routes> so its WebSocket survives
// every navigation and redirect — route elements come and go, the fleet doesn't.
export default function App() {
  return (
    <BrowserRouter>
      <AgentsProvider>
        <Routes>
          {/* `:view`, not `:view/*` — a wildcard would render Tasks for
              /tasks/anything and keep a URL that describes nothing. Extra
              segments fall to the catch-all. Add a nested route only when a
              view earns a real subpath. */}
          <Route path="/" element={<DefaultRedirect />} />
          <Route path=":view" element={<ViewRoute />} />
          <Route path="*" element={<Navigate replace to="/tasks" />} />
        </Routes>
      </AgentsProvider>
    </BrowserRouter>
  );
}
