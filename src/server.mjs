import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { validateToken } from './config.mjs';
import { VERSION, API_VERSION } from './version.mjs';
import { RequestError, object, projectId, queryParams, filePath, createRequest, execRequest } from './request.mjs';

const MAX_BODY = 1_450_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function send(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
    throw new RequestError('JSON_REQUIRED', 'Content-Type must be application/json.', 415);
  }
  if (req.headers['content-encoding'] !== undefined) throw new RequestError('ENCODING_UNSUPPORTED', 'Compressed request bodies are not accepted.', 415);
  if (Number(req.headers['content-length']) > MAX_BODY) throw new RequestError('BODY_TOO_LARGE', 'The request body exceeds the allowed size.', 413);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted);
    };
    const fail = (reason) => { cleanup(); reject(reason); };
    const data = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.pause();
        fail(new RequestError('BODY_TOO_LARGE', 'The request body exceeds the allowed size.', 413));
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new RequestError('INVALID_JSON', 'The request body is not valid JSON.')); }
    };
    const error = () => fail(new RequestError('REQUEST_INTERRUPTED', 'The request was interrupted.', 400));
    const aborted = () => fail(new RequestError('REQUEST_INTERRUPTED', 'The request was interrupted.', 400));
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
}

/** A single-owner, authenticated loopback API. Browser access and remote binding are intentionally absent. */
export async function startServer({ runtime, token, port = 47831 }) {
  validateToken(token);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid listen port.');
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const active = new Set();
  const pending = new Set();
  let expectedHost;
  let closing = false;
  let closePromise;
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    let admitted = false;
    let completion;
    let finish;
    try {
      if (closing || active.size >= 32) throw new RequestError('BUSY', 'The local service is busy. Try again after checking the current operation.', 503);
      const raw = req.rawHeaders.filter((_, index) => index % 2 === 0).map((key) => key.toLowerCase());
      if (req.headers.host !== expectedHost || raw.filter((key) => key === 'host').length !== 1) throw new RequestError('HOST_REJECTED', 'Use the exact loopback service address.', 403);
      if (req.headers.origin !== undefined || req.headers['access-control-request-method'] !== undefined) throw new RequestError('ORIGIN_REJECTED', 'Browser origins cannot call the local runtime API.', 403);
      const received = Buffer.from(req.headers.authorization ?? '');
      if (raw.filter((key) => key === 'authorization').length !== 1 || received.length !== expectedAuthorization.length || !timingSafeEqual(received, expectedAuthorization)) {
        throw new RequestError('UNAUTHORIZED', 'A valid API bearer token is required.', 401);
      }
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new RequestError('INVALID_URL', 'Use an API-relative request path.');
      const url = new URL(req.url, `http://${expectedHost}`);
      if (url.hash) throw new RequestError('INVALID_URL', 'URL fragments are not accepted.');
      active.add(controller); admitted = true;
      completion = new Promise((resolve) => { finish = resolve; });
      pending.add(completion);

      if (url.pathname === '/v1/health' && req.method === 'GET') {
        queryParams(url, []);
        return send(res, 200, { service: 'opengen', version: VERSION, apiVersion: API_VERSION, mode: 'local-single-owner', runtime: await runtime.health() });
      }
      if (url.pathname === '/v1/sandboxes') {
        if (req.method === 'GET') {
          const query = queryParams(url, ['projectId']);
          return send(res, 200, await runtime.list({ projectId: projectId(query.projectId, false) }));
        }
        if (req.method === 'POST') {
          queryParams(url, []);
          return send(res, 201, await runtime.create(createRequest(await readJson(req))));
        }
      }
      const match = /^\/v1\/sandboxes\/([^/]+)(?:\/(start|stop|reset|exec|files))?$/.exec(url.pathname);
      if (!match || !UUID.test(match[1])) throw new RequestError('NOT_FOUND', 'The API route was not found.', 404);
      const [, id, action] = match;
      if (!action && req.method === 'GET') {
        const query = queryParams(url, ['projectId']);
        return send(res, 200, await runtime.get(id, { projectId: projectId(query.projectId) }));
      }
      if (!action && req.method === 'DELETE') {
        const query = queryParams(url, ['projectId', 'deleteWorkspace']);
        if (query.deleteWorkspace !== 'true') throw new RequestError('DELETE_CONFIRMATION_REQUIRED', 'Deleting a sandbox requires deleteWorkspace=true. Use stop to retain work.', 409);
        return send(res, 200, await runtime.remove(id, { projectId: projectId(query.projectId), deleteWorkspace: true }));
      }
      if (['start', 'stop', 'reset'].includes(action) && req.method === 'POST') {
        queryParams(url, []);
        const body = object(await readJson(req), ['projectId'], ['projectId']);
        return send(res, 200, await runtime[action](id, { projectId: projectId(body.projectId) }));
      }
      if (action === 'exec' && req.method === 'POST') {
        queryParams(url, []);
        const body = execRequest(await readJson(req));
        return send(res, 200, await runtime.exec(id, body, { signal: controller.signal }));
      }
      if (action === 'files' && req.method === 'GET') {
        const query = queryParams(url, ['projectId', 'path']);
        return send(res, 200, await runtime.readFile(id, { projectId: projectId(query.projectId), path: filePath(query.path) }));
      }
      if (action === 'files' && req.method === 'PUT') {
        queryParams(url, []);
        const body = object(await readJson(req), ['projectId', 'path', 'content', 'encoding'], ['projectId', 'path', 'content']);
        projectId(body.projectId); filePath(body.path);
        if (typeof body.content !== 'string' || !['utf8', 'base64', undefined].includes(body.encoding)) throw new RequestError('INVALID_FILE', 'File content must be text with utf8 or base64 encoding.');
        return send(res, 200, await runtime.writeFile(id, body));
      }
      throw new RequestError('METHOD_NOT_ALLOWED', 'The HTTP method is not supported for this route.', 405);
    } catch (error) {
      const publicError = error instanceof RequestError || error?.name === 'RuntimeError';
      const status = publicError && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      if (!res.destroyed && !res.headersSent) res.setHeader('Connection', 'close');
      send(res, status, { error: {
        code: publicError ? error.code : 'INTERNAL_ERROR',
        message: publicError ? error.message : 'OpenGen could not complete the request.',
        requestId,
      } });
    } finally {
      if (admitted) active.delete(controller);
      if (completion) { pending.delete(completion); finish(); }
      res.off('close', disconnected);
    }
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.headersTimeout = 5000;
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 2000;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  expectedHost = `127.0.0.1:${server.address().port}`;
  return {
    url: `http://${expectedHost}`,
    server,
    close() {
      if (!closePromise) closePromise = (async () => {
        closing = true;
        for (const controller of active) controller.abort();
        const handlers = Promise.all([...pending]);
        const sockets = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server.closeIdleConnections();
        server.closeAllConnections();
        // Closed sockets do not imply completed mutations. Keep the runtime's
        // ownership lock until every admitted handler has settled.
        await Promise.all([sockets, handlers]);
      })();
      return closePromise;
    },
  };
}
