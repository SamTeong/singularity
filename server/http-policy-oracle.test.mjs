import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
const websocketSource = readFileSync(new URL('./pty-ws.mjs', import.meta.url), 'utf8');
const fixtures = JSON.parse(readFileSync(new URL('../rust/backend/tests/fixtures/http-policy.json', import.meta.url), 'utf8'));

function between(start, end) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt);
  assert.notEqual(startAt, -1, `missing source anchor ${start}`);
  assert.notEqual(endAt, -1, `missing source boundary ${end}`);
  return source.slice(startAt, endAt);
}

function makeOracle(env = {}) {
  const syntheticHome = 'C:/http-fixture/home';
  const syntheticTemp = 'C:/http-fixture/temp';
  const userHomeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const allowedEnv = {
    DAEMON_PORT: '4317',
    VITE_PORT: '5317',
    SING_TOKEN: 'token_1',
    HOME: syntheticHome,
    [userHomeKey]: syntheticHome,
    USERPROFILE: syntheticHome,
    TEMP: syntheticTemp,
    TMP: syntheticTemp,
    ...env,
  };
  const fixtureProcess = { env: Object.fromEntries(Object.entries(allowedEnv).filter(([, value]) => value !== undefined)) };
  const context = vm.createContext({
    process: fixtureProcess,
    URL,
    Set,
    decodeURIComponent,
    globalThis: null,
  });
  context.globalThis = context;
  const envLines = source.match(/^const (?:PORT|VITE_PORT|TOKEN) = .*;$/gm).join('\n');
  const hooks = [];
  context.app = { addHook(_event, callback) { hooks.push(callback); } };
  context.hasShell = true;

  vm.runInContext([
    `${envLines}\nglobalThis.fixturePort = PORT; globalThis.fixtureVitePort = VITE_PORT; globalThis.fixtureToken = TOKEN;`,
    between('const SELF_HOSTS = new Set(', 'function originAllowed'),
    between('function redactTokenParam(url) {', 'const app = Fastify({'),
    between('function isShellRequest(req) {', '// Browser cross-origin guard'),
    between('function originAllowed(origin) {', '// Origin and Sec-Fetch-Site'),
    between('function requestAllowed(req) {', "app.addHook('onRequest'"),
  ].join('\n'), context);

  vm.runInContext(between("app.addHook('onRequest'", '// createTask/updateTask'), context);
  vm.runInContext(between('if (TOKEN) {\n  app.addHook(\'onRequest\'', "\n\napp.get('/health'"), context);
  vm.runInContext('globalThis.sourceRequestAllowed = requestAllowed;', context);
  return { context, shellHook: hooks[0], apiHook: hooks[1] };
}

function queryObject(url) {
  const query = new URL(url, 'http://fixture').searchParams;
  const output = {};
  for (const [key, value] of query) {
    if (Object.hasOwn(output, key)) output[key] = Array.isArray(output[key]) ? [...output[key], value] : [output[key], value];
    else output[key] = value;
  }
  return output;
}

function mockReply() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    code(status) { this.statusCode = status; return this; },
    type(value) { this.headers['content-type'] = value; return this; },
    header(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    send(body) { this.body = body; return this; },
    redirect(location, status) { this.headers.location = location; this.statusCode = status; return this; },
  };
}

function request(url, { method = 'GET', headers = {} } = {}) {
  return {
    method,
    raw: { url },
    headers: { accept: 'text/html', ...headers },
    query: queryObject(url),
  };
}

test('legacy HTTP policy source agrees with shared synthetic fixtures', async () => {
  for (const fixture of fixtures.environment) {
    const { context } = makeOracle({ DAEMON_PORT: fixture.input });
    const actual = context.fixturePort;
    const expected = fixture.number;
    const normalized = Number.isNaN(actual) ? null : actual === Infinity ? 'Infinity' : actual;
    assert.equal(normalized, expected, `Number(DAEMON_PORT=${JSON.stringify(fixture.input)})`);
  }

  for (const fixture of fixtures.tokens) {
    const { context } = makeOracle({ SING_TOKEN: fixture.input ?? undefined });
    assert.equal(context.fixtureToken, fixture.token);
  }

  const { context, shellHook, apiHook } = makeOracle();
  for (const fixture of fixtures.request_policy) {
    const headers = {};
    if (fixture.host !== null) headers.host = fixture.host;
    if (fixture.origin !== null) headers.origin = fixture.origin;
    if (fixture.fetch_site !== null) headers['sec-fetch-site'] = fixture.fetch_site;
    const req = request('/', { headers });
    // Combined verdict as the onRequest hook applies it: Host allowlist first, then requestAllowed.
    const hostAllowed = !req.headers.host || vm.runInContext('SELF_HOSTS', context).has(req.headers.host);
    assert.equal(hostAllowed && context.sourceRequestAllowed(req), fixture.allowed, JSON.stringify(fixture));
    const reply = mockReply();
    await shellHook(req, reply);
    assert.equal(reply.statusCode, fixture.allowed ? 401 : 403, JSON.stringify(fixture));
    if (!fixture.allowed) assert.deepEqual(JSON.parse(JSON.stringify(reply.body)), { error: fixture.error });
  }

  for (const fixture of fixtures.api_auth) {
    const headers = {};
    if (fixture.header !== null) headers['x-sing-token'] = fixture.header;
    if (fixture.cookie !== null) headers.cookie = fixture.cookie;
    const req = request(`/api/test${fixture.query === null ? '' : `?${fixture.query}`}`, { headers });
    const reply = mockReply();
    await apiHook(req, reply);
    assert.equal(reply.statusCode === 200, fixture.allowed, JSON.stringify(fixture));
  }

  for (const fixture of fixtures.redirects) {
    const url = `${fixture.path}${fixture.query ? `?${fixture.query}` : ''}`;
    const reply = mockReply();
    await shellHook(request(url), reply);
    assert.equal(reply.statusCode, 302, url);
    assert.equal(reply.headers.location, fixture.location, url);
    assert.equal(reply.headers['set-cookie'], 'sing_token=token_1; HttpOnly; SameSite=Strict; Path=/');
  }

  const duplicateShell = mockReply();
  await shellHook(request(`/?${fixtures.shell_duplicate.query}`), duplicateShell);
  assert.equal(duplicateShell.statusCode, fixtures.shell_duplicate.status);

  const wsTokenExpression = websocketSource.match(/const t = (new URL\(req\.url, 'http:\/\/localhost'\)\.searchParams\.get\('token'\));/)?.[1];
  assert.ok(wsTokenExpression, 'legacy WebSocket token lookup source anchor');
  for (const fixture of fixtures.websocket_auth) {
    const url = fixture.query === null ? '/' : `/?${fixture.query}`;
    const token = vm.runInNewContext(`(${wsTokenExpression})`, { req: { url }, URL });
    assert.equal(token === 'token_1', fixture.allowed, JSON.stringify(fixture));
  }

  const shellUnauthorized = mockReply();
  await shellHook(request('/'), shellUnauthorized);
  assert.equal(shellUnauthorized.statusCode, 401);
  assert.equal(shellUnauthorized.body, fixtures.responses.shell_unauthorized);

  const apiUnauthorized = mockReply();
  await apiHook(request('/api/private'), apiUnauthorized);
  assert.deepEqual(JSON.parse(JSON.stringify({ status: apiUnauthorized.statusCode, body: apiUnauthorized.body })), fixtures.responses.api_unauthorized);
});

test('legacy cookie decode errors and auth short-circuits match shared fixtures', async () => {
  const { apiHook } = makeOracle();
  const policy = fixtures.cookie_policy;
  for (const cookie of policy.malformed) {
    await assert.rejects(
      () => apiHook(request('/api/private', { headers: { cookie } }), mockReply()),
      (error) => error?.name === 'URIError' && error.message === 'URI malformed',
    );
  }

  const orderingReply = mockReply();
  await apiHook(request('/api/private', { headers: { cookie: policy.cookie_ordering.cookie } }), orderingReply);
  assert.equal(orderingReply.statusCode === 200, policy.cookie_ordering.allowed);

  const headerReply = mockReply();
  await apiHook(request('/api/private', { headers: {
    'x-sing-token': policy.header_short_circuit.header,
    cookie: policy.header_short_circuit.cookie,
  } }), headerReply);
  assert.equal(headerReply.statusCode, 200);

  const duplicateReply = mockReply();
  await apiHook(request(`/api/private?${policy.duplicate_query_short_circuit.query}`, {
    headers: { cookie: policy.duplicate_query_short_circuit.cookie },
  }), duplicateReply);
  assert.equal(duplicateReply.statusCode, 401);

  const { apiHook: sourceBoundHook } = makeOracle();
  const app = Fastify({ logger: false });
  app.addHook('onRequest', sourceBoundHook);
  app.get('/api/private', async () => ({ ok: true }));
  for (const cookie of policy.malformed) {
    const response = await app.inject({ method: 'GET', url: '/api/private', headers: { cookie } });
    assert.equal(response.statusCode, policy.error_response.status);
    assert.deepEqual(response.json(), policy.error_response.body);
  }
  await app.close();
});
