import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIMITS, MAX_FILE_BYTES, normalizeCreateRequest, normalizeExecRequest,
  decodeWriteContent, validateLocalDockerEndpoint, validateProfiles, validateRelativePath,
} from '../src/runtime-policy.mjs';

const fails = (code) => (error) => error.code === code;

test('create is offline, bounded, and restricted to configured images', () => {
  assert.deepEqual(normalizeCreateRequest({ projectId: 'app-one' }), {
    projectId: 'app-one', profile: 'node', network: 'none', ports: [], limits: DEFAULT_LIMITS,
  });
  for (const field of ['image', 'mounts', 'privileged', 'env', 'dockerArgs']) {
    assert.throws(() => normalizeCreateRequest({ projectId: 'one', [field]: 'arbitrary' }), fails('INVALID_REQUEST'));
  }
  for (const profile of ['constructor', '__proto__', 'unknown']) {
    assert.throws(() => normalizeCreateRequest({ projectId: 'one', profile }), fails('UNKNOWN_PROFILE'));
  }
  assert.equal(Object.getPrototypeOf(validateProfiles()), null);
  assert.throws(() => normalizeCreateRequest({ projectId: 'one', network: 'bridge' }), fails('NETWORK_DISABLED'));
  assert.throws(() => normalizeCreateRequest({ projectId: 'one', ports: [3000] }), fails('NETWORK_REQUIRED'));
  assert.throws(() => normalizeCreateRequest({ projectId: 'one', network: 'host' }), fails('INVALID_NETWORK'));
});

test('network opt-in allows only distinct unprivileged preview ports', () => {
  const configured = { allowNetwork: true };
  assert.deepEqual(normalizeCreateRequest({ projectId: 'one', network: 'bridge', ports: [3000] }, configured).ports, [3000]);
  for (const ports of [[80], [3000, 3000], [65536], ['3000'], Array(6).fill(3000), [{ containerPort: 3000, hostPort: 80 }]]) {
    assert.throws(() => normalizeCreateRequest({ projectId: 'one', network: 'bridge', ports }, configured), fails('INVALID_PORTS'));
  }
  for (const limits of [{ memoryMb: 2049 }, { memoryMb: 0 }, { cpus: 20 }, { cpus: NaN }, { pids: 0 }, { pids: 257 }, { disk: 'unlimited' }]) {
    assert.throws(() => normalizeCreateRequest({ projectId: 'one', limits }));
  }
});

test('commands remain argv arrays with bounded input and timeout', () => {
  const input = { argv: ['node', '-e', 'console.log("hello; $(host-command)")'] };
  assert.deepEqual(normalizeExecRequest(input).argv, input.argv);
  for (const argv of ['echo hello', [], [''], ['node', '\0'], ['node', 'a'.repeat(65537)]]) {
    assert.throws(() => normalizeExecRequest({ argv }), fails('INVALID_COMMAND'));
  }
  for (const timeoutMs of [0, 99, 900001, Infinity, '1000']) {
    assert.throws(() => normalizeExecRequest({ argv: ['node'], timeoutMs }), fails('INVALID_TIMEOUT'));
  }
  assert.equal(normalizeExecRequest({ argv: ['node'], timeoutMs: 100 }).timeoutMs, 100);
});

test('workspace paths reject traversal and absolute paths before Docker calls', () => {
  assert.equal(validateRelativePath('./src//index.js'), 'src/index.js');
  assert.equal(validateRelativePath('.', { directory: true }), '.');
  for (const value of ['', '.', '/etc/passwd', '../secret', 'src/../../secret', 'a/../b', 'C:\\secret', 'C:/secret', 'a\0b', 'a\nb']) {
    assert.throws(() => validateRelativePath(value), fails('INVALID_PATH'));
  }
});

test('file transfer accepts exactly 1 MiB, validates base64, and rejects larger payloads', () => {
  const bytes = Buffer.alloc(MAX_FILE_BYTES, 0xfd);
  assert.deepEqual(decodeWriteContent({ content: bytes.toString('base64'), encoding: 'base64' }), bytes);
  assert.equal(decodeWriteContent({ content: 'a'.repeat(MAX_FILE_BYTES) }).length, MAX_FILE_BYTES);
  assert.throws(() => decodeWriteContent({ content: 'a'.repeat(MAX_FILE_BYTES + 1) }), fails('FILE_TOO_LARGE'));
  assert.throws(() => decodeWriteContent({ content: 'é'.repeat(MAX_FILE_BYTES) }), fails('FILE_TOO_LARGE'));
  for (const content of ['!!!!', 'YQ', 'YQ=\n', 'YR==']) {
    assert.throws(() => decodeWriteContent({ content, encoding: 'base64' }), fails('INVALID_FILE_CONTENT'));
  }
});

test('only local Unix sockets and local Windows named pipes are accepted', () => {
  assert.equal(validateLocalDockerEndpoint('unix:///var/run/docker.sock'), 'unix:///var/run/docker.sock');
  assert.equal(validateLocalDockerEndpoint('npipe:////./pipe/docker_engine'), 'npipe:////./pipe/docker_engine');
  for (const value of ['tcp://localhost:2375', 'tcp://remote:2376', 'ssh://host', 'npipe:////remote/pipe/docker_engine', 'unix://remote/socket']) {
    assert.throws(() => validateLocalDockerEndpoint(value), fails('REMOTE_DOCKER_FORBIDDEN'));
  }
});
