// Browser element subresources bypass Mirage's fetch/XHR interception. Serve
// the two mock-only assets from Vite itself so both `dev-mock` and the built
// mock preview exercise the same URLs as the real daemon.

// One real body per image extension a fixture may use. The daemon's /fs/raw
// picks the mime from the file's own bytes/extension (explorer.mjs rawEntry),
// so keying bodies off the extension keeps the mock from declaring, say, an SVG
// as image/png — which the `nosniff` below would then refuse to render. An
// extension with no entry here 404s exactly as the daemon does for a file that
// isn't there, so a new binary fixture fails loudly instead of silently
// rendering the wrong format: add its bytes here alongside the fixture.
const RAW_BY_EXT = {
  '.png': {
    type: 'image/png',
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  },
  '.gif': {
    type: 'image/gif',
    body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
  },
  '.svg': {
    type: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">'
      + '<rect width="16" height="16" fill="#7c5cff"/></svg>',
  },
};

const REPORT_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Mock usage report</title>
    <script>
      // Resolve presentation before the first painted frame, the way the real
      // report's bootstrap does — query string first (UsageReportView passes
      // ?skin=&theme= precisely so the first frame is right), then the
      // localStorage keys it seeds, then the ZAPAC/light default. Without this
      // the doc paints light and only goes dark once the parent's onLoad
      // syncTheme fires, a flash the real report doesn't have.
      (function () {
        var q = new URLSearchParams(location.search);
        var ls = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
        var d = document.documentElement;
        d.dataset.theme = q.get('theme') || ls('agents-report-theme') || 'light';
        d.dataset.skin = q.get('skin') || ls('agents-report-skin') || 'zapac';
      })();
    </script>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; padding: 2rem; background: #f7f8fa; color: #172033; }
      html[data-theme='dark'] body { background: #111827; color: #e5e7eb; }
      html[data-skin='phosphor'] body { background: #050505; color: #a7f3d0; }
      main { max-width: 48rem; margin: 0 auto; }
      h1 { margin: 0 0 0.75rem; font-size: 1.5rem; }
      p { margin: 0; line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <h1>Mock usage report</h1>
      <p>Seeded report content for daemon-free development and end-to-end tests.</p>
    </main>
  </body>
</html>`;

function send(res, method, status, type, body) {
  const length = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(length));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(method === 'HEAD' ? undefined : body);
}

// Error bodies match the daemon's: a JSON { ok:false, error } under the same
// status code, so a client that reads the failure sees the shape it expects.
const fail = (res, method, status, error) =>
  send(res, method, status, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error }));

const extOf = (p) => {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i).toLowerCase();
};

function mockAssetsMiddleware(req, res, next) {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') return next();

  const url = new URL(req.url || '/', 'http://vite.local');
  if (url.pathname === '/api/fs/raw') {
    // Mirrors explorer.mjs bad(): a non-empty absolute path. The mock's virtual
    // FS is POSIX-shaped (fixtures.js joins with '/'), so absolute means '/'.
    const path = url.searchParams.get('path');
    if (!path || !path.startsWith('/')) return fail(res, method, 400, 'bad path');
    const asset = RAW_BY_EXT[extOf(path)];
    if (!asset) return fail(res, method, 404, 'not found');
    return send(res, method, 200, asset.type, asset.body);
  }
  if (url.pathname === '/api/usagereport/report') {
    return send(res, method, 200, 'text/html; charset=utf-8', REPORT_HTML);
  }
  next();
}

export default function mockAssetsPlugin() {
  return {
    name: 'singularity-mock-assets',
    configureServer(server) {
      server.middlewares.use(mockAssetsMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(mockAssetsMiddleware);
    },
  };
}
