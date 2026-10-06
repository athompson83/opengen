import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { startServer } from '../src/server.mjs';
import { createClient } from '../src/client.mjs';
import { fakeRuntime } from './helpers/fake-runtime.mjs';

const TOKEN = 'test_only_owner_token_012345678901234567890123';
async function fixture(t, runtime = fakeRuntime()) {
  const api = await startServer({ runtime, token: TOKEN, port: 0 });
  t.after(() => api.close());
  return { api, runtime, client: createClient({ baseUrl: api.url, token: TOKEN }) };
}
function raw(url, { method = 'GET', path = '/v1/health', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${url}${path}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, value: text ? JSON.parse(text) : undefined }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const auth = { Authorization: `Bearer ${TOKEN}` };

test('the actual HTTP client completes lifecycle, file, and execution routes with project scope', async (t) => {
  const { client, runtime } = await fixture(t);
  assert.equal((await client.health()).runtime.ready, true);
  const sandbox = await client.create({ projectId: 'project-a' });
  assert.equal(sandbox.network, 'none');
  assert.equal((await client.list({ projectId: 'project-a' })).length, 1);
  assert.equal((await client.list({ projectId: 'project-b' })).length, 0);
  await assert.rejects(client.get(sandbox.id, { projectId: 'project-b' }), { code: 'SANDBOX_NOT_FOUND', status: 404 });
  const bytes = Buffer.from([0, 255, 13, 10, 123]);
  assert.equal((await client.writeFile(sandbox.id, { projectId: 'project-a', path: 'nested/file.bin', encoding: 'base64', content: bytes.toString('base64') })).bytes, bytes.length);
  const argv = ['node', '-e', 'console.log("literal; $(no-host-shell)")'];
  assert.equal((await client.exec(sandbox.id, { projectId: 'project-a', argv })).exitCode, 0);
  assert.deepEqual(runtime.calls.find(([name]) => name === 'exec')[1].argv, argv);
  assert.equal((await client.stop(sandbox.id, { projectId: 'project-a' })).state, 'stopped');
  await client.start(sandbox.id, { projectId: 'project-a' });
  await client.reset(sandbox.id, { projectId: 'project-a' });
  assert.equal((await client.readFile(sandbox.id, { projectId: 'project-a', path: 'nested/file.bin' })).content, bytes.toString('base64'));
  await assert.rejects(client.remove(sandbox.id, { projectId: 'project-a' }), { code: 'DELETE_CONFIRMATION_REQUIRED' });
  assert.equal((await client.get(sandbox.id, { projectId: 'project-a' })).id, sandbox.id);
  await client.remove(sandbox.id, { projectId: 'project-a', deleteWorkspace: true });
  assert.deepEqual(await client.list(), []);
});

test('authentication, host, and browser-origin rejection happen before runtime access', async (t) => {
  const { api, runtime } = await fixture(t);
  const host = new URL(api.url).host;
  const cases = [
    [{}, 401], [{ Authorization: 'Bearer incorrect' }, 401],
    [{ ...auth, Origin: 'https://attacker.invalid' }, 403], [{ ...auth, Origin: '' }, 403],
    [{ ...auth, Host: 'attacker.invalid' }, 403],
    [{ ...auth, 'Access-Control-Request-Method': 'POST' }, 403],
    [['Host', host, 'Host', host, 'Authorization', `Bearer ${TOKEN}`], 403],
    [['Host', host, 'Authorization', `Bearer ${TOKEN}`, 'Authorization', `Bearer ${TOKEN}`], 401],
  ];
  for (const [headers, status] of cases) {
    const result = await raw(api.url, { headers });
    assert.equal(result.status, status);
    assert.ok(!result.text.includes(TOKEN));
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(runtime.calls.length, 0);
  const result = await raw(api.url, { headers: auth });
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('the API rejects ambiguous queries, malformed input, and client-selected Docker flags', async (t) => {
  const { api, runtime } = await fixture(t);
  for (const path of ['/v1/health?token=secret', '/v1/sandboxes?projectId=a&projectId=b']) {
    assert.equal((await raw(api.url, { path, headers: auth })).status, 400);
  }
  const payloads = [
    { projectId: 'a', mounts: ['/host:/workspace'] },
    { projectId: 'a', image: 'attacker/image' },
    { projectId: 'a', network: 'host' },
    { projectId: 'a', limits: { pids: 99999 } },
    { projectId: 'a', limits: { memoryMb: 8192 } },
    { projectId: 'a:escape' },
    { projectId: 'a', ports: [3000, 3000] },
    [], null,
  ];
  for (const payload of payloads) {
    const result = await raw(api.url, { method: 'POST', path: '/v1/sandboxes', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(result.status, 400);
  }
  assert.equal((await raw(api.url, { method: 'POST', path: '/v1/sandboxes', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{invalid' })).status, 400);
  assert.equal((await raw(api.url, { method: 'POST', path: '/v1/sandboxes', headers: auth, body: '{}' })).status, 415);
  assert.equal(runtime.calls.length, 0);
});

test('declared and streamed request bodies are bounded', async (t) => {
  const { api, runtime } = await fixture(t);
  assert.equal((await raw(api.url, { method: 'POST', path: '/v1/sandboxes', headers: { ...auth, 'Content-Type': 'application/json', 'Content-Length': '2000000' } })).status, 413);
  assert.equal((await raw(api.url, { method: 'POST', path: '/v1/sandboxes', headers: { ...auth, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }, body: ' '.repeat(1_450_001) })).status, 413);
  assert.equal(runtime.calls.length, 0);
});

test('unexpected internal errors cannot disclose private diagnostics', async (t) => {
  const runtime = fakeRuntime();
  runtime.health = async () => { throw new Error('private-daemon-secret-value'); };
  const { api } = await fixture(t, runtime);
  const response = await raw(api.url, { headers: auth });
  assert.equal(response.status, 500);
  assert.equal(response.value.error.code, 'INTERNAL_ERROR');
  assert.ok(!response.text.includes('private-daemon-secret-value'));
  assert.ok(!response.text.includes(TOKEN));
});

test('close drains in-flight mutations before the runtime ownership lock can be released', async (t) => {
  let begin;
  const begun = new Promise((resolve) => { begin = resolve; });
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let mutationFinished = false;
  const runtime = fakeRuntime();
  const originalCreate = runtime.create;
  runtime.create = async (input) => { begin(); await barrier; const result = await originalCreate(input); mutationFinished = true; return result; };
  const { api, client } = await fixture(t, runtime);
  const pending = client.create({ projectId: 'a' }).catch(() => undefined);
  await begun;
  let closed = false;
  const closing = api.close().then(() => { closed = true; });
  await nextTurn();
  assert.equal(closed, false);
  assert.equal(mutationFinished, false);
  release();
  await closing;
  await pending;
  assert.equal(mutationFinished, true);
  await api.close();
});

test('disconnecting an execution request passes cancellation into the runtime', async (t) => {
  let begin;
  const begun = new Promise((resolve) => { begin = resolve; });
  let cancelled;
  const observed = new Promise((resolve) => { cancelled = resolve; });
  const runtime = fakeRuntime();
  runtime.exec = async (_id, _input, { signal }) => {
    begin();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    cancelled();
    throw new Error('execution aborted');
  };
  const { client } = await fixture(t, runtime);
  const sandbox = await client.create({ projectId: 'a' });
  const controller = new AbortController();
  const execution = client.exec(sandbox.id, { projectId: 'a', argv: ['node'] }, { signal: controller.signal });
  const rejection = assert.rejects(execution, { code: 'REQUEST_ABORTED' });
  await begun;
  controller.abort();
  await rejection;
  await observed;
});
