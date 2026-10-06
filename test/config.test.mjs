import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, chmod, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, stateSummary, validateSettings } from '../src/config.mjs';

async function directory(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'opengen-config-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

test('initialization persists a random owner token without exposing it in diagnostics', async (t) => {
  const stateDir = await directory(t);
  const state = await loadState({ stateDir, env: {} });
  assert.match(state.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(state.settings.allowNetwork, false);
  assert.equal(state.baseUrl, 'http://127.0.0.1:47831');
  assert.ok(!JSON.stringify(stateSummary(state)).includes(state.token));
  assert.equal((await loadState({ stateDir, env: {} })).token, state.token);
  if (process.platform !== 'win32') {
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(state.tokenFile)).mode & 0o777, 0o600);
    assert.equal((await stat(state.settingsFile)).mode & 0o777, 0o600);
  }
});

test('token overrides stay out of persisted token files and summaries', async (t) => {
  const stateDir = await directory(t);
  const initial = await loadState({ stateDir, env: {} });
  const override = 'test_only_override_token_012345678901234567890';
  const state = await loadState({ stateDir, env: { OPENGEN_TOKEN: override, OPENGEN_PORT: '47832' } });
  assert.equal(state.token, override);
  assert.equal(state.baseUrl, 'http://127.0.0.1:47832');
  assert.equal((await readFile(state.tokenFile, 'utf8')).trim(), initial.token);
  assert.ok(!JSON.stringify(stateSummary(state)).includes(override));
  await assert.rejects(loadState({ stateDir, env: { OPENGEN_TOKEN: 'bad' } }));
});

test('unsafe state files fail closed', { skip: process.platform === 'win32' ? 'POSIX permission/symlink contract; Windows ACL verification is manual.' : false }, async (t) => {
  const stateDir = await directory(t);
  const state = await loadState({ stateDir, env: {} });
  await chmod(state.tokenFile, 0o644);
  await assert.rejects(loadState({ stateDir, env: {} }), /restricted to its owner/);
  await chmod(state.tokenFile, 0o600);
  await rm(state.tokenFile);
  const target = join(stateDir, 'target');
  await writeFile(target, 'sensitive fixture', { mode: 0o600 });
  await symlink(target, state.tokenFile);
  await assert.rejects(loadState({ stateDir, env: {} }), /symbolic links/);
  assert.equal(await readFile(target, 'utf8'), 'sensitive fixture');
});

test('settings cannot introduce host access or unbounded resources', () => {
  for (const value of [
    { host: '0.0.0.0' }, { allowNetwork: 'yes' }, { maxSandboxes: 1000 },
    { profiles: { node: { image: 'node:24', privileged: true } } },
    { profiles: { node: { image: '--privileged' } } },
    { profiles: {} }, { port: 0 },
  ]) assert.throws(() => validateSettings(value));
  assert.equal(validateSettings({ allowNetwork: true }).allowNetwork, true);
});
