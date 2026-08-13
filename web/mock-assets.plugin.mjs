// Browser element subresources bypass Mirage's fetch/XHR interception. Serve
// the two mock-only assets from Vite itself so both `dev-mock` and the built
// mock preview exercise the same URLs as the real daemon.

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const REPORT_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Mock usage report</title>
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

function send(res, method, type, body) {
  const length = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(length));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(method === 'HEAD' ? undefined : body);
}

function mockAssetsMiddleware(req, res, next) {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') return next();

  const pathname = new URL(req.url || '/', 'http://vite.local').pathname;
  if (pathname === '/fs/raw') {
    send(res, method, 'image/png', PIXEL_PNG);
    return;
  }
  if (pathname === '/usagereport/report') {
    send(res, method, 'text/html; charset=utf-8', REPORT_HTML);
    return;
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
