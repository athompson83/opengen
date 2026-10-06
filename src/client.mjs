export class OpenGenError extends Error {
  constructor(code, message, status = 0, requestId) {
    super(message);
    this.name = 'OpenGenError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

/** The local owner token belongs to a trusted application process, never a renderer or sandbox. */
export function createClient({ baseUrl = 'http://127.0.0.1:47831', token }) {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new OpenGenError('INVALID_ENDPOINT', 'The local client requires an http://127.0.0.1:port endpoint without credentials or a path.');
  }
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/.test(token)) throw new OpenGenError('INVALID_TOKEN', 'A local owner token is required.');
  const urlFor = (path, query = {}) => {
    const url = new URL(path, endpoint);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return url;
  };
  const request = async (method, path, { body, query, signal, timeoutMs = 60000 } = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(urlFor(path, query), {
        method,
        redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      });
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new OpenGenError('RESPONSE_TOO_LARGE', 'OpenGen returned more data than the client permits.');
        chunks.push(chunk);
      }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new OpenGenError('INVALID_RESPONSE', 'OpenGen returned an invalid response.', response.status); }
      if (!response.ok) throw new OpenGenError(value.error?.code ?? 'REQUEST_FAILED', value.error?.message ?? 'The runtime rejected the request.', response.status, value.error?.requestId);
      return value;
    } catch (error) {
      if (error instanceof OpenGenError) throw error;
      throw new OpenGenError(combined.aborted ? 'REQUEST_ABORTED' : 'TRANSPORT_ERROR',
        'A complete runtime response was not received. Check sandbox state before retrying an operation.');
    }
  };
  const resource = (id) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new OpenGenError('INVALID_ID', 'A sandbox UUID is required.');
    return `/v1/sandboxes/${id}`;
  };
  const lifecycle = (action) => (id, { projectId, signal } = {}) => request('POST', `${resource(id)}/${action}`, { body: { projectId }, signal });
  return Object.freeze({
    health: ({ signal } = {}) => request('GET', '/v1/health', { signal }),
    list: ({ projectId, signal } = {}) => request('GET', '/v1/sandboxes', { query: { projectId }, signal }),
    create: (input, { signal } = {}) => request('POST', '/v1/sandboxes', { body: input, signal }),
    get: (id, { projectId, signal } = {}) => request('GET', resource(id), { query: { projectId }, signal }),
    start: lifecycle('start'),
    stop: lifecycle('stop'),
    reset: lifecycle('reset'),
    remove: (id, { projectId, deleteWorkspace = false, signal } = {}) => request('DELETE', resource(id), { query: { projectId, deleteWorkspace }, signal }),
    exec: (id, input, { signal } = {}) => request('POST', `${resource(id)}/exec`, { body: input, signal, timeoutMs: (input.timeoutMs ?? 120000) + 45000 }),
    readFile: (id, { projectId, path, signal } = {}) => request('GET', `${resource(id)}/files`, { query: { projectId, path }, signal }),
    writeFile: (id, input, { signal } = {}) => request('PUT', `${resource(id)}/files`, { body: input, signal }),
  });
}
