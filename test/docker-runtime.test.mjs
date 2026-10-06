import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDockerRuntime } from '../src/docker-runtime.mjs';
import { runDockerCommand } from '../src/docker-command.mjs';

const imageId = `sha256:${'a'.repeat(64)}`;
const success = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', timedOut: false, truncated: false });
const failed = (stderr) => ({ ...success(), exitCode: 1, stderr });
const fails = (code) => (error) => error.code === code;
const labelMap = (args) => Object.fromEntries(args.flatMap((arg, index) => arg === '--label' ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));

class FakeDocker {
  endpoint = 'unix:///var/run/docker.sock';
  os = 'linux';
  version = '29.0.0';
  calls = [];
  containers = new Map();
  volumes = new Map();
  networks = new Map();
  imagePresent = true;
  ignoreKill = false;
  beforeCommand;
  onExec = async () => success('ok\n');

  runner = async (options) => {
    const original = [...options.args];
    this.calls.push(original);
    const args = original[0] === '--host' ? original.slice(2) : original;
    if (this.beforeCommand) await this.beforeCommand(args);
    const [kind, action] = args;
    if (kind === 'context' && action === 'show') return success('default\n');
    if (kind === 'context' && action === 'inspect') return success(JSON.stringify(this.endpoint));
    if (kind === 'info') return success(JSON.stringify(this.os));
    if (kind === 'version') return success(JSON.stringify(this.version));
    if (kind === 'image' && action === 'inspect') {
      return this.imagePresent ? success(JSON.stringify([{ Id: imageId }])) : failed('No such image: operator image');
    }
    const collection = { container: this.containers, volume: this.volumes, network: this.networks }[kind];
    if (collection && action === 'inspect') {
      const value = collection.get(args[2]);
      return value ? success(JSON.stringify([value])) : failed(`Error response from daemon: No such ${kind}: ${args[2]}`);
    }
    if (['volume', 'network'].includes(kind) && action === 'create') {
      const name = args.at(-1);
      collection.set(name, { Name: name, Labels: labelMap(args), files: {} });
      return success(name);
    }
    if (kind === 'container' && action === 'create') {
      const name = args[args.indexOf('--name') + 1];
      const ports = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--publish') {
          const port = args[i + 1].split('::')[1];
          ports[port] = [{ HostIp: '127.0.0.1', HostPort: String(41000 + i) }];
        }
      }
      this.containers.set(name, {
        Name: name, Id: name, Image: imageId, Config: { Labels: labelMap(args) },
        State: { Running: false }, NetworkSettings: { Ports: ports },
      });
      return success(name);
    }
    if (kind === 'container' && ['start', 'stop', 'kill'].includes(action)) {
      const value = this.containers.get(args.at(-1));
      if (!value) return failed('No such container');
      if (!(action === 'kill' && this.ignoreKill)) value.State.Running = action === 'start';
      return success(args.at(-1));
    }
    if (collection && action === 'rm') { collection.delete(args.at(-1)); return success(args.at(-1)); }
    if (kind === 'exec') {
      const separator = args.indexOf('--');
      return this.onExec({ ...options, argv: args.slice(separator + 2), name: args[separator + 1] });
    }
    throw new Error(`Unhandled fake Docker command: ${args.join(' ')}`);
  };
}

async function fixture(t, settings = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opengen-runtime-test-'));
  const docker = new FakeDocker();
  const runtimes = [];
  const open = async (overrides = {}) => {
    const runtime = await createDockerRuntime({ dataDir, commandRunner: docker.runner, ...settings, ...overrides });
    runtimes.push(runtime);
    return runtime;
  };
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const runtime = await open();
  return { runtime, docker, dataDir, open };
}

test('creates an image-pinned, nonroot, offline sandbox with a managed persistent volume', async (t) => {
  const { runtime, docker } = await fixture(t);
  const sandbox = await runtime.create({ projectId: 'app-one' });
  assert.equal(sandbox.state, 'running');
  assert.equal(sandbox.imageId, imageId);
  assert.deepEqual(sandbox.limits, { memoryMb: 2048, cpus: 2, pids: 256 });
  const create = docker.calls.find((args) => args[2] === 'container' && args[3] === 'create');
  assert.deepEqual(create.slice(0, 2), ['--host', 'unix:///var/run/docker.sock']);
  for (const [flag, value] of [['--user', '1000:1000'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges=true'], ['--network', 'none'], ['--pids-limit', '256'], ['--memory-swap', '2048m'], ['--pull', 'never']]) {
    assert.equal(create[create.indexOf(flag) + 1], value);
  }
  assert.ok(create.includes('--read-only'));
  assert.equal(create.at(-1), imageId);
  assert.match(create[create.indexOf('--mount') + 1], /^type=volume,source=opengen-.+,target=\/workspace$/);
  assert.ok(!create.includes('--privileged'));
  assert.ok(!create.slice(2).some((arg) => arg.includes('docker.sock')));
  const environment = create.flatMap((arg, index) => arg === '--env' ? [create[index + 1]] : []);
  for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'FTP_PROXY', 'ftp_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
    assert.ok(environment.includes(`${name}=`), `${name} must explicitly override operator Docker proxy configuration`);
  }
  assert.equal(docker.volumes.size, 1);
  assert.equal((await runtime.health()).ready, true);
});

test('quotas are serialized across simultaneous create requests and restored state', async (t) => {
  const { runtime, open, docker } = await fixture(t, { maxSandboxes: 1 });
  const outcomes = await Promise.allSettled([runtime.create({ projectId: 'one' }), runtime.create({ projectId: 'two' })]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((result) => result.status === 'rejected').reason.code, 'SANDBOX_LIMIT_REACHED');
  assert.equal(docker.containers.size, 1);
  await runtime.close();
  const restored = await open();
  await assert.rejects(restored.create({ projectId: 'three' }), fails('SANDBOX_LIMIT_REACHED'));
});

test('state reload discovers daemon state, and stop/reset preserve the same workspace', async (t) => {
  const { runtime, open, docker } = await fixture(t);
  const first = await runtime.create({ projectId: 'one' });
  docker.volumes.get(first.workspaceVolume).files['app.js'] = 'saved work';
  await runtime.close();
  docker.containers.get(first.containerName).State.Running = false;
  const restored = await open();
  const found = await restored.get(first.id, { projectId: 'one' });
  assert.equal(found.state, 'stopped');
  assert.equal(found.containerName, first.containerName);
  await restored.start(first.id, { projectId: 'one' });
  const reset = await restored.reset(first.id, { projectId: 'one' });
  assert.equal(reset.state, 'running');
  assert.equal(reset.workspaceVolume, first.workspaceVolume);
  assert.equal(docker.volumes.get(first.workspaceVolume).files['app.js'], 'saved work');
  await restored.stop(first.id, { projectId: 'one' });
  assert.equal(docker.volumes.size, 1);
});

test('project scope and labels prevent touching foreign containers or volumes', async (t) => {
  const { runtime, docker } = await fixture(t);
  const sandbox = await runtime.create({ projectId: 'one' });
  const before = docker.calls.length;
  await assert.rejects(runtime.exec(sandbox.id, { projectId: 'different', argv: ['node'] }), fails('SANDBOX_NOT_FOUND'));
  assert.equal(docker.calls.length, before);
  const volume = docker.volumes.get(sandbox.workspaceVolume);
  const labels = { ...volume.Labels };
  volume.Labels['org.opengen.instance'] = 'foreign';
  await assert.rejects(runtime.stop(sandbox.id, { projectId: 'one' }), fails('RESOURCE_OWNERSHIP_MISMATCH'));
  await assert.rejects(runtime.remove(sandbox.id, { projectId: 'one', deleteWorkspace: true }), fails('RESOURCE_OWNERSHIP_MISMATCH'));
  assert.equal(docker.containers.get(sandbox.containerName).State.Running, true);
  volume.Labels = labels;
  docker.containers.get(sandbox.containerName).Config.Labels['org.opengen.sandbox'] = 'foreign';
  await assert.rejects(runtime.start(sandbox.id, { projectId: 'one' }), fails('RESOURCE_OWNERSHIP_MISMATCH'));
  assert.equal(docker.volumes.size, 1);
});

test('timeouts kill the entire owned sandbox, not only the Docker exec client', async (t) => {
  const { runtime, docker } = await fixture(t);
  const sandbox = await runtime.create({ projectId: 'one' });
  docker.onExec = async () => ({ ...success('partial'), exitCode: 124, timedOut: true });
  const result = await runtime.exec(sandbox.id, { projectId: 'one', argv: ['node', 'long.js'], timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.equal(result.stdout, 'partial');
  assert.equal((await runtime.get(sandbox.id)).state, 'stopped');
  assert.ok(docker.calls.some((args) => args.includes('kill') && args.includes(sandbox.containerName)));
  assert.equal(docker.volumes.size, 1);
});

test('caller cancellation stops the sandbox and reports cancellation explicitly', async (t) => {
  const { runtime, docker } = await fixture(t);
  const sandbox = await runtime.create({ projectId: 'one' });
  let launched;
  const started = new Promise((resolve) => { launched = resolve; });
  docker.onExec = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ ...success(), exitCode: 130, aborted: true }), { once: true });
    launched();
  });
  const controller = new AbortController();
  const operation = runtime.exec(sandbox.id, { projectId: 'one', argv: ['node', 'long.js'] }, { signal: controller.signal });
  const rejected = assert.rejects(operation, fails('EXEC_ABORTED'));
  await started;
  controller.abort();
  await rejected;
  assert.equal(docker.containers.get(sandbox.containerName).State.Running, false);
});

test('stop cancels an execution still in preflight without launching it', async (t) => {
  const { runtime, docker } = await fixture(t);
  const sandbox = await runtime.create({ projectId: 'one' });
  let entered;
  let unblock;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { unblock = resolve; });
  let blocked = false;
  docker.beforeCommand = async (args) => {
    if (!blocked && args[0] === 'container' && args[1] === 'inspect') { blocked = true; entered(); await barrier; }
  };
  const operation = runtime.exec(sandbox.id, { argv: ['node'] });
  const rejected = assert.rejects(operation, fails('EXEC_ABORTED'));
  await enteredPromise;
  const stopped = runtime.stop(sandbox.id);
  unblock();
  await rejected;
  assert.equal((await stopped).state, 'stopped');
  assert.ok(!docker.calls.some((args) => args[2] === 'exec'));
});

test('failure to stop a timed-out workload is reported truthfully', async (t) => {
  const { runtime, docker } = await fixture(t);
  const sandbox = await runtime.create({ projectId: 'one' });
  docker.ignoreKill = true;
  docker.onExec = async () => ({ ...success(), timedOut: true, exitCode: 124 });
  await assert.rejects(runtime.exec(sandbox.id, { argv: ['node'], timeoutMs: 100 }), fails('WORKLOAD_STOP_FAILED'));
  assert.equal(docker.containers.get(sandbox.containerName).State.Running, true);
});

test('deletion needs explicit workspace confirmation and remains recoverable after partial failure', async (t) => {
  const { runtime, docker } = await fixture(t);
  const sandbox = await runtime.create({ projectId: 'one' });
  await assert.rejects(runtime.remove(sandbox.id, {}), fails('WORKSPACE_DELETION_REQUIRED'));
  docker.beforeCommand = async (args) => {
    if (args[0] === 'volume' && args[1] === 'rm') throw new Error('daemon output must-not-leak');
  };
  await assert.rejects(runtime.remove(sandbox.id, { deleteWorkspace: true }), (error) => {
    assert.ok(!error.message.includes('must-not-leak'));
    return error.code === 'DOCKER_OPERATION_FAILED';
  });
  assert.equal(docker.containers.size, 0);
  assert.equal(docker.volumes.size, 1);
  assert.equal((await runtime.list()).length, 1);
  docker.beforeCommand = undefined;
  assert.equal((await runtime.remove(sandbox.id, { deleteWorkspace: true })).workspaceDeleted, true);
  assert.equal((await runtime.list()).length, 0);
});

test('remote Docker contexts are refused before executing workload commands', async (t) => {
  const { runtime, docker } = await fixture(t);
  docker.endpoint = 'tcp://remote.example:2375';
  assert.equal((await runtime.health()).error.code, 'REMOTE_DOCKER_FORBIDDEN');
  await assert.rejects(runtime.create({ projectId: 'one' }), fails('REMOTE_DOCKER_FORBIDDEN'));
  assert.ok(!docker.calls.some((args) => args.includes('--host') || args.includes('image') || args.includes('create')));
});

test('missing images are explained without auto-pulling or creating state', async (t) => {
  const { runtime, docker } = await fixture(t);
  docker.imagePresent = false;
  const health = await runtime.health();
  assert.equal(health.ready, false);
  assert.equal(health.profiles[0].error.code, 'IMAGE_UNAVAILABLE');
  await assert.rejects(runtime.create({ projectId: 'one' }), fails('IMAGE_UNAVAILABLE'));
  assert.equal((await runtime.list()).length, 0);
  assert.ok(!docker.calls.some((args) => args.includes('pull')));
});

test('health refreshes the daemon version and refuses a switch to Windows containers', async (t) => {
  const { runtime, docker } = await fixture(t);
  assert.equal((await runtime.health()).version, '29.0.0');
  docker.version = '29.1.0';
  assert.equal((await runtime.health()).version, '29.1.0');
  docker.os = 'windows';
  const health = await runtime.health();
  assert.equal(health.ready, false);
  assert.equal(health.error.code, 'LINUX_CONTAINERS_REQUIRED');
});

test('start verifies bridge network ownership before starting a stopped container', async (t) => {
  const { runtime, docker } = await fixture(t, { allowNetwork: true });
  const sandbox = await runtime.create({ projectId: 'one', network: 'bridge' });
  await runtime.stop(sandbox.id);
  docker.networks.get(sandbox.networkName).Labels['org.opengen.instance'] = 'foreign';
  const before = docker.calls.length;
  await assert.rejects(runtime.start(sandbox.id), fails('RESOURCE_OWNERSHIP_MISMATCH'));
  assert.equal(docker.containers.get(sandbox.containerName).State.Running, false);
  assert.ok(!docker.calls.slice(before).some((args) => args[2] === 'container' && args[3] === 'start'));
});

test('invalid persisted network policy is rejected before contacting Docker and releases its lock', async (t) => {
  const { runtime, docker, dataDir, open } = await fixture(t);
  const sandbox = await runtime.create({ projectId: 'one' });
  await runtime.close();
  const filename = path.join(dataDir, 'sandboxes', `${sandbox.id}.json`);
  const record = JSON.parse(await fs.readFile(filename, 'utf8'));
  record.requestedPorts = [3000];
  await fs.writeFile(filename, JSON.stringify(record));
  const before = docker.calls.length;
  await assert.rejects(open(), fails('INVALID_RUNTIME_STATE'));
  assert.equal(docker.calls.length, before);
  record.requestedPorts = [];
  await fs.writeFile(filename, JSON.stringify(record));
  assert.equal((await (await open()).get(sandbox.id)).state, 'running');
});

test('bridge networks are separately owned and publish previews only on dynamic loopback ports', async (t) => {
  const { runtime, docker } = await fixture(t, { allowNetwork: true });
  const sandbox = await runtime.create({ projectId: 'one', network: 'bridge', ports: [3000] });
  assert.equal(docker.networks.size, 1);
  assert.equal(sandbox.ports[0].containerPort, 3000);
  assert.match(sandbox.ports[0].url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const create = docker.calls.find((args) => args[2] === 'container' && args[3] === 'create');
  assert.ok(create.includes('127.0.0.1::3000/tcp'));
  await runtime.remove(sandbox.id, { deleteWorkspace: true });
  assert.equal(docker.networks.size, 0);
});

test('a single state-directory writer is enforced and close drains active work before releasing it', async (t) => {
  const { runtime, docker, dataDir, open } = await fixture(t);
  await assert.rejects(createDockerRuntime({ dataDir, commandRunner: docker.runner }), fails('RUNTIME_ALREADY_ACTIVE'));
  const sandbox = await runtime.create({ projectId: 'one' });
  let launched;
  const started = new Promise((resolve) => { launched = resolve; });
  docker.onExec = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ ...success(), exitCode: 130, aborted: true }), { once: true });
    launched();
  });
  const operation = runtime.exec(sandbox.id, { argv: ['node'] });
  const rejected = assert.rejects(operation, fails('EXEC_ABORTED'));
  await started;
  await runtime.close();
  await rejected;
  await assert.rejects(runtime.list(), fails('RUNTIME_CLOSED'));
  assert.equal((await (await open()).get(sandbox.id)).state, 'stopped');
});

test('file transport preserves the full 1 MiB limit and only uses the container helper', async (t) => {
  const { runtime, docker } = await fixture(t);
  const sandbox = await runtime.create({ projectId: 'one' });
  const content = Buffer.alloc(1024 * 1024, 0xfe).toString('base64');
  docker.onExec = async ({ argv, input, maxOutputBytes }) => {
    assert.equal(argv[0], '/usr/local/bin/node');
    assert.ok(maxOutputBytes > content.length);
    const request = JSON.parse(input);
    if (request.op === 'read') return success(JSON.stringify({ content }));
    return success(JSON.stringify({ bytes: Buffer.from(request.content, 'base64').length }));
  };
  assert.equal((await runtime.readFile(sandbox.id, { path: 'data.bin' })).content, content);
  assert.equal((await runtime.writeFile(sandbox.id, { path: 'nested/data.bin', content, encoding: 'base64' })).bytes, 1024 * 1024);
  const before = docker.calls.length;
  await assert.rejects(runtime.readFile(sandbox.id, { path: '../outside' }), fails('INVALID_PATH'));
  assert.equal(docker.calls.length, before);
});

test('Docker subprocess output is bounded and unrelated service secrets are not inherited', async () => {
  process.env.OPENGEN_TEST_SECRET = 'do-not-forward';
  try {
    const env = await runDockerCommand({ dockerPath: process.execPath, args: ['-e', 'process.stdout.write(process.env.OPENGEN_TEST_SECRET ?? "absent")'] });
    assert.equal(env.stdout, 'absent');
  } finally { delete process.env.OPENGEN_TEST_SECRET; }
  const output = await runDockerCommand({ dockerPath: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(65536));process.stderr.write("y".repeat(65536))'], maxOutputBytes: 1024 });
  assert.equal(output.truncated, true);
  assert.equal(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr), 1024);
  const timeout = await runDockerCommand({ dockerPath: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 100 });
  assert.equal(timeout.timedOut, true);
});
