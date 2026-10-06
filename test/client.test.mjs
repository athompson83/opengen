import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createClient } from '../src/client.mjs';

const token = 'test_only_owner_token_012345678901234567890123';
test('the client accepts only a trusted local endpoint and token', () => {
  for (const baseUrl of ['https://127.0.0.1:47831', 'http://example.com', 'http://localhost:47831', 'http://127.0.0.1/path', 'http://user:pass@127.0.0.1', 'http://127.0.0.1?token=x']) {
    assert.throws(() => createClient({ baseUrl, token }), { code: 'INVALID_ENDPOINT' });
  }
  assert.throws(() => createClient({ token: 'short' }), { code: 'INVALID_TOKEN' });
  const client = createClient({ token });
  assert.throws(() => client.get('../health', { projectId: 'a' }), { code: 'INVALID_ID' });
});

test('the client does not follow redirects or retry a mutation', async (t) => {
  let requests = 0;
  let received;
  const server = createServer((req, res) => {
    requests++;
    received = { authorization: req.headers.authorization, url: req.url };
    res.writeHead(307, { Location: '/redirected' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const client = createClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token });
  await assert.rejects(client.create({ projectId: 'a' }), { code: 'TRANSPORT_ERROR' });
  assert.equal(requests, 1);
  assert.equal(received.authorization, `Bearer ${token}`);
  assert.ok(!received.url.includes(token));
});
