import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { startServer } from '../src/server.mjs';
import { loadState } from '../src/config.mjs';
import { fakeRuntime } from './helpers/fake-runtime.mjs';

function output() {
  let stdout = ''; let stderr = '';
  return { out: { write: (text) => { stdout += text; } }, err: { write: (text) => { stderr += text; } }, get stdout() { return stdout; }, get stderr() { return stderr; } };
}
async function directory(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'opengen-cli-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

test('CLI initialization works without Docker and keeps the credential private', async (t) => {
  const stateDir = await directory(t);
  const io = output();
  assert.equal(await main(['init', '--state-dir', stateDir], { ...io, env: {} }), 0);
  const token = (await readFile(join(stateDir, 'token'), 'utf8')).trim();
  assert.ok(!io.stdout.includes(token));
  assert.equal(JSON.parse(io.stdout).baseUrl, 'http://127.0.0.1:47831');
  assert.equal(io.stderr, '');
});

test('invalid and destructive CLI invocations fail before accessing state', async (t) => {
  const stateDir = await directory(t);
  for (const args of [
    ['delete', 'id', '--project', 'a'], ['serve', '--host', '0.0.0.0'],
    ['exec', 'id', '--project', 'a'], ['init', '--allow-network'],
    ['create', 'a', '--port', '80'], ['list', '--project', 'a', '--project', 'b'],
  ]) {
    const io = output();
    assert.equal(await main([...args, '--state-dir', stateDir], { ...io, env: {} }), 1);
    assert.equal(io.stdout, '');
    assert.ok(JSON.parse(io.stderr).error.message);
  }
  await assert.rejects(readFile(join(stateDir, 'token')), { code: 'ENOENT' });
});

test('CLI create and exec use the authenticated client and preserve literal argv', async (t) => {
  const stateDir = await directory(t);
  const state = await loadState({ stateDir, env: {} });
  const runtime = fakeRuntime();
  const api = await startServer({ runtime, token: state.token, port: 0 });
  t.after(() => api.close());
  const env = { OPENGEN_STATE_DIR: stateDir, OPENGEN_PORT: new URL(api.url).port };
  const created = output();
  assert.equal(await main(['create', 'cli-project'], { ...created, env }), 0);
  const sandbox = JSON.parse(created.stdout);
  const io = output();
  const argv = ['node', '-e', 'console.log("; $(literal)")', '--any-program-flag'];
  assert.equal(await main(['exec', sandbox.id, '--project', 'cli-project', '--', ...argv], { ...io, env }), 0);
  assert.deepEqual(runtime.calls.find(([name]) => name === 'exec')[1].argv, argv);
  const doctor = output();
  assert.equal(await main(['doctor'], { ...doctor, env }), 0);
  assert.equal(JSON.parse(doctor.stdout).runtime.ready, true);
});
