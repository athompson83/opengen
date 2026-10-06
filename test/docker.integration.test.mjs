import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDockerRuntime } from '../src/docker-runtime.mjs';
import { startServer } from '../src/server.mjs';
import { createClient } from '../src/client.mjs';

const runFile = promisify(execFile);
const enabled = process.env.OPENGEN_DOCKER_TESTS === '1';
const dockerPath = process.env.OPENGEN_DOCKER || 'docker';

async function docker(...args) {
  const result = await runFile(dockerPath, args, {
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
  });
  return result.stdout.trim();
}

async function inspect(kind, name) {
  return JSON.parse(await docker(kind, 'inspect', name))[0];
}

function decode(file) {
  assert.equal(file.encoding, 'base64');
  return Buffer.from(file.content, 'base64').toString('utf8');
}

async function previewText(url) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return await response.text();
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error('The local preview did not become ready.', { cause: lastError });
}

test('real Docker: public API, container boundaries, persistence, and previews', {
  skip: enabled ? false : 'Set OPENGEN_DOCKER_TESTS=1 with a real local Linux Docker daemon and built image.',
  timeout: 300000,
}, async (t) => {
  // Explicit execution fails on a missing daemon/image. It never falls back to
  // the host or substitutes a mocked runner for evidence of container behavior.
  assert.equal((await docker('info', '--format', '{{.OSType}}')).trim(), 'linux');
  const workloadImage = await inspect('image', 'opengen/node:0.1.0');
  assert.match(workloadImage.Id, /^sha256:[0-9a-f]{64}$/);

  const dataDir = await mkdtemp(join(tmpdir(), 'opengen-docker-test-'));
  const token = randomBytes(32).toString('base64url');
  let runtime = await createDockerRuntime({ dataDir, dockerPath, allowNetwork: true, maxSandboxes: 4 });
  let service = await startServer({ runtime, token, port: 0 });
  let client = createClient({ baseUrl: service.url, token });
  const created = new Map();
  const scopeA = { projectId: 'integration-alpha' };
  const scopeB = { projectId: 'integration-beta' };
  let alpha;
  let beta;

  t.after(async () => {
    const failures = [];
    if (service.server.listening) await service.close();
    // Creation failures may leave recorded resources for explicit recovery.
    // This state directory belongs only to this test, so include those records.
    let cleanupTargets;
    try { cleanupTargets = await runtime.list(); }
    catch (error) { failures.push(error); cleanupTargets = [...created.values()]; }
    for (const sandbox of cleanupTargets) {
      try {
        await runtime.remove(sandbox.id, { projectId: sandbox.projectId, deleteWorkspace: true });
      } catch (error) {
        if (error.status !== 404) failures.push(error);
      }
    }
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
    assert.equal(failures.length, 0, 'Integration cleanup must remove its own resources without a global Docker prune.');
  });

  await t.test('the authenticated public API creates managed isolated workspaces', async () => {
    const health = await client.health();
    assert.equal(health.service, 'opengen');
    assert.equal(health.mode, 'local-single-owner');
    assert.equal(health.runtime.ready, true);
    alpha = await client.create({ ...scopeA, profile: 'node', network: 'none', limits: { memoryMb: 256, cpus: 0.5 } });
    created.set(alpha.id, alpha);
    beta = await client.create({ ...scopeB, profile: 'node', network: 'none', limits: { memoryMb: 256, cpus: 0.5 } });
    created.set(beta.id, beta);
    assert.equal(alpha.state, 'running');
    assert.notEqual(alpha.id, beta.id);
    assert.notEqual(alpha.workspaceVolume, beta.workspaceVolume);

    const container = await inspect('container', alpha.containerName);
    assert.equal(container.Image, alpha.imageId);
    assert.equal(container.Image, workloadImage.Id);
    assert.equal(container.Config.User, '1000:1000');
    assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert.equal(container.HostConfig.Privileged, false);
    assert.ok(container.HostConfig.CapDrop.includes('ALL'));
    assert.ok(container.HostConfig.SecurityOpt.some((value) => value.startsWith('no-new-privileges')));
    assert.equal(container.HostConfig.Memory, 256 * 1024 * 1024);
    assert.equal(container.HostConfig.NanoCpus, 500000000);
    assert.equal(container.HostConfig.PidsLimit, 256);
    assert.equal(container.HostConfig.NetworkMode, 'none');
    assert.ok(container.Mounts.every((mount) => mount.Type !== 'bind'));
    assert.ok(!container.Mounts.some((mount) => mount.Destination.includes('docker.sock')));
    const workspace = container.Mounts.find((mount) => mount.Destination === '/workspace');
    assert.equal(workspace.Type, 'volume');
    assert.equal(workspace.Name, alpha.workspaceVolume);
    assert.equal(workspace.RW, true);
    assert.equal(container.Config.Labels['org.opengen.managed'], 'true');
    assert.equal(container.Config.Labels['org.opengen.sandbox'], alpha.id);
    assert.ok(!container.Config.Env.some((value) => value.includes(token)));

    const checked = await client.exec(alpha.id, { ...scopeA, argv: ['node', '-e', `
      const fs = require('node:fs');
      const os = require('node:os');
      let rootWrite;
      try { fs.writeFileSync('/home/node/opengen-root-write', 'blocked'); rootWrite = 'allowed'; }
      catch (error) { rootWrite = error.code; }
      fs.writeFileSync('/tmp/opengen-temporary', 'ok');
      fs.writeFileSync(process.env.HOME + '/home-check', 'ok');
      const status = fs.readFileSync('/proc/self/status', 'utf8');
      console.log(JSON.stringify({
        uid: process.getuid(), gid: process.getgid(), rootWrite,
        workspaceUid: fs.statSync('/workspace').uid,
        home: process.env.HOME, interfaces: Object.keys(os.networkInterfaces()),
        capEff: status.match(/^CapEff:\\s+(\\w+)/m)[1],
        noNewPrivileges: status.match(/^NoNewPrivs:\\s+(\\d+)/m)[1],
      }));
    `] });
    assert.equal(checked.exitCode, 0, checked.stderr);
    const facts = JSON.parse(checked.stdout);
    assert.equal(facts.uid, 1000);
    assert.equal(facts.gid, 1000);
    assert.equal(facts.workspaceUid, 1000);
    assert.equal(facts.rootWrite, 'EROFS');
    assert.equal(facts.home, '/workspace/.home');
    assert.ok(facts.interfaces.every((name) => name === 'lo'));
    assert.match(facts.capEff, /^0+$/);
    assert.equal(facts.noNewPrivileges, '1');
  });

  await t.test('Docker configuration proxy credentials are not injected into workloads', async () => {
    // Read only the selected context's endpoint. Do not copy the operator's
    // config.json, authentication entries, certificates, or context store.
    const selectedContext = await docker('context', 'show');
    const endpoint = JSON.parse(await docker('context', 'inspect', selectedContext,
      '--format', '{{json .Endpoints.docker.Host}}'));
    assert.ok(typeof endpoint === 'string' &&
      (endpoint.startsWith('unix:///') || endpoint.startsWith('npipe:////./pipe/')));
    const fixtureDir = await mkdtemp(join(tmpdir(), 'opengen-proxy-test-'));
    const credential = `opengen-fixture-not-a-real-secret-${randomBytes(8).toString('hex')}`;
    const proxy = `http://fixture-user:${credential}@127.0.0.1:9`;
    const environmentKeys = ['DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST',
      'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'];
    const originalEnvironment = new Map(environmentKeys.map((name) => [name, process.env[name]]));
    const proxyNames = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy',
      'FTP_PROXY', 'ftp_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
    let proxyRuntime;
    try {
      await writeFile(join(fixtureDir, 'config.json'), JSON.stringify({
        proxies: { default: {
          httpProxy: proxy, httpsProxy: proxy, ftpProxy: proxy,
          allProxy: proxy, noProxy: credential,
        } },
      }), { mode: 0o600 });
      process.env.DOCKER_CONFIG = fixtureDir;
      for (const name of environmentKeys.slice(1)) delete process.env[name];
      // A private context preserves the selected local daemon for discovery;
      // context create/use write only within the throwaway DOCKER_CONFIG.
      await docker('context', 'create', 'opengen-proxy-fixture', '--docker', `host=${endpoint}`);
      await docker('context', 'use', 'opengen-proxy-fixture');
      proxyRuntime = await createDockerRuntime({ dataDir: join(fixtureDir, 'state'), dockerPath, maxSandboxes: 1 });
      const sandbox = await proxyRuntime.create({
        projectId: 'integration-proxy', network: 'none', limits: { memoryMb: 256, cpus: 0.5 },
      });
      const container = await inspect('container', sandbox.containerName);
      assert.ok(!container.Config.Env.some((value) => value.includes(credential)));
      for (const name of proxyNames) {
        assert.ok(container.Config.Env.includes(`${name}=`), `${name} must be explicitly empty.`);
      }
      const result = await proxyRuntime.exec(sandbox.id, {
        projectId: sandbox.projectId,
        argv: ['node', '-e', `console.log(JSON.stringify(${JSON.stringify(proxyNames)}.map(name => process.env[name])))`],
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), proxyNames.map(() => ''));
    } finally {
      try {
        if (proxyRuntime) {
          try {
            // Include any recorded partial creation, scoped to this fixture.
            for (const sandbox of await proxyRuntime.list()) {
              await proxyRuntime.remove(sandbox.id, { projectId: sandbox.projectId, deleteWorkspace: true });
            }
          } finally {
            await proxyRuntime.close();
          }
        }
      } finally {
        for (const [name, value] of originalEnvironment) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        await rm(fixtureDir, { recursive: true, force: true });
      }
    }
  });

  await t.test('file transfer and project scope do not expose another workspace', async () => {
    await client.writeFile(alpha.id, { ...scopeA, path: 'nested/value.txt', content: 'alpha value\n', encoding: 'utf8' });
    await client.writeFile(beta.id, { ...scopeB, path: 'nested/value.txt', content: Buffer.from('beta value\n').toString('base64'), encoding: 'base64' });
    assert.equal(decode(await client.readFile(alpha.id, { ...scopeA, path: 'nested/value.txt' })), 'alpha value\n');
    assert.equal(decode(await client.readFile(beta.id, { ...scopeB, path: 'nested/value.txt' })), 'beta value\n');
    const binary = Buffer.alloc(1024 * 1024, 0xa5);
    const binaryPath = 'nested/多言語-😀.bin';
    await client.writeFile(alpha.id, { ...scopeA, path: binaryPath, content: binary.toString('base64'), encoding: 'base64' });
    const roundTrip = await client.readFile(alpha.id, { ...scopeA, path: binaryPath });
    assert.equal(roundTrip.encoding, 'base64');
    assert.deepEqual(Buffer.from(roundTrip.content, 'base64'), binary);
    await assert.rejects(client.writeFile(alpha.id, {
      ...scopeA, path: 'too-large.bin', encoding: 'base64',
      content: Buffer.alloc(1024 * 1024 + 1).toString('base64'),
    }), (error) => error.status === 413);
    await assert.rejects(client.get(alpha.id, scopeB), (error) => error.status === 404);
    await assert.rejects(client.readFile(alpha.id, { ...scopeB, path: 'nested/value.txt' }), (error) => error.status === 404);
    await assert.rejects(client.writeFile(alpha.id, { ...scopeA, path: '../escape', content: 'blocked' }), (error) => error.code === 'INVALID_PATH');
    await assert.rejects(client.create({ ...scopeA, image: 'unapproved-image' }), (error) => error.status === 400);

    const link = await client.exec(alpha.id, { ...scopeA, argv: ['node', '-e', `
      const fs = require('node:fs');
      fs.symlinkSync('/etc', '/workspace/outward');
      fs.symlinkSync('/etc/hostname', '/workspace/final-link');
    `] });
    assert.equal(link.exitCode, 0, link.stderr);
    await assert.rejects(client.readFile(alpha.id, { ...scopeA, path: 'outward/hostname' }), (error) => error.code === 'PATH_UNSAFE');
    await assert.rejects(client.readFile(alpha.id, { ...scopeA, path: 'final-link' }), (error) => error.code === 'PATH_UNSAFE');
    const fifo = await client.exec(alpha.id, { ...scopeA, argv: ['mkfifo', '/workspace/pipe'] });
    assert.equal(fifo.exitCode, 0, fifo.stderr);
    await assert.rejects(client.readFile(alpha.id, { ...scopeA, path: 'pipe', signal: AbortSignal.timeout(3000) }),
      (error) => error.code === 'PATH_UNSAFE');
    const list = await client.list(scopeB);
    assert.ok(Array.isArray(list));
    assert.deepEqual(list.map((sandbox) => sandbox.id), [beta.id]);
  });

  await t.test('workspace data survives stop/start, reset, and runtime reconstruction', async () => {
    await client.stop(alpha.id, scopeA);
    assert.equal((await client.get(alpha.id, scopeA)).state, 'stopped');
    await client.start(alpha.id, scopeA);
    assert.equal(decode(await client.readFile(alpha.id, { ...scopeA, path: 'nested/value.txt' })), 'alpha value\n');
    const beforeReset = await inspect('container', alpha.containerName);
    const reset = await client.reset(alpha.id, scopeA);
    const afterReset = await inspect('container', reset.containerName);
    assert.notEqual(afterReset.Id, beforeReset.Id);
    assert.equal(reset.workspaceVolume, alpha.workspaceVolume);
    assert.equal(decode(await client.readFile(alpha.id, { ...scopeA, path: 'nested/value.txt' })), 'alpha value\n');

    await service.close();
    await runtime.close();
    runtime = await createDockerRuntime({ dataDir, dockerPath, allowNetwork: true, maxSandboxes: 4 });
    service = await startServer({ runtime, token, port: 0 });
    client = createClient({ baseUrl: service.url, token });
    assert.equal((await client.get(alpha.id, scopeA)).state, 'running');
    assert.equal(decode(await client.readFile(alpha.id, { ...scopeA, path: 'nested/value.txt' })), 'alpha value\n');
    assert.equal(decode(await client.readFile(beta.id, { ...scopeB, path: 'nested/value.txt' })), 'beta value\n');
  });

  await t.test('execution timeout stops the workload and its detached child', async () => {
    const childScript = 'setInterval(() => require("node:fs").appendFileSync("/workspace/heartbeat", "x"), 50)';
    const result = await client.exec(alpha.id, {
      ...scopeA,
      timeoutMs: 1500,
      argv: ['node', '-e', `
        require('node:fs').writeFileSync('/workspace/heartbeat', '');
        const child = require('node:child_process').spawn(process.execPath,
          ['-e', ${JSON.stringify(childScript)}], { detached: true, stdio: 'ignore' });
        child.unref();
        setInterval(() => {}, 1000);
      `],
    });
    assert.equal(result.timedOut, true);
    assert.equal((await client.get(alpha.id, scopeA)).state, 'stopped');
    assert.equal((await inspect('container', alpha.containerName)).State.Running, false);
    await client.start(alpha.id, scopeA);
    const check = await client.exec(alpha.id, { ...scopeA, argv: ['node', '-e', `
      const fs = require('node:fs');
      const before = fs.statSync('/workspace/heartbeat').size;
      setTimeout(() => console.log(JSON.stringify({ before, after: fs.statSync('/workspace/heartbeat').size })), 250);
    `] });
    assert.equal(check.exitCode, 0, check.stderr);
    const heartbeat = JSON.parse(check.stdout);
    assert.ok(heartbeat.before > 0, 'The child must have run before the timeout.');
    assert.equal(heartbeat.after, heartbeat.before, 'A detached child must not survive the sandbox timeout.');
  });

  await t.test('preview networking requires operator opt-in and binds only to loopback', async () => {
    const restrictedDir = await mkdtemp(join(tmpdir(), 'opengen-network-test-'));
    const restricted = await createDockerRuntime({ dataDir: restrictedDir, dockerPath, allowNetwork: false });
    try {
      await assert.rejects(restricted.create({ projectId: 'blocked-network', network: 'bridge', ports: [3000] }),
        (error) => error.code === 'NETWORK_DISABLED');
    } finally {
      await restricted.close();
      await rm(restrictedDir, { recursive: true, force: true });
    }
    const preview = await client.create({ projectId: 'integration-preview', network: 'bridge', ports: [3000], limits: { memoryMb: 256, cpus: 0.5 } });
    created.set(preview.id, preview);
    assert.equal(preview.ports.length, 1);
    assert.equal(preview.ports[0].containerPort, 3000);
    const url = new URL(preview.ports[0].url);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(Number(url.port), preview.ports[0].hostPort);
    const container = await inspect('container', preview.containerName);
    const published = container.NetworkSettings.Ports['3000/tcp'];
    assert.ok(published.length > 0);
    assert.ok(published.every((binding) => binding.HostIp === '127.0.0.1'));

    const serverScript = 'require("node:http").createServer((req, res) => res.end("OpenGen integration preview")).listen(3000, "0.0.0.0")';
    const launched = await client.exec(preview.id, {
      projectId: preview.projectId,
      argv: ['node', '-e', `const child = require('node:child_process').spawn(process.execPath,
        ['-e', ${JSON.stringify(serverScript)}], { detached: true, stdio: 'ignore' }); child.unref();`],
    });
    assert.equal(launched.exitCode, 0, launched.stderr);
    assert.equal(await previewText(preview.ports[0].url), 'OpenGen integration preview');
    await client.remove(preview.id, { projectId: preview.projectId, deleteWorkspace: true });
    created.delete(preview.id);
    await assert.rejects(docker('container', 'inspect', preview.containerName));
    if (preview.networkName) await assert.rejects(docker('network', 'inspect', preview.networkName));
  });

  await t.test('deletion is explicit and leaves the other project intact', async () => {
    await assert.rejects(client.remove(alpha.id, scopeA), (error) => error.code === 'DELETE_CONFIRMATION_REQUIRED');
    assert.equal(decode(await client.readFile(alpha.id, { ...scopeA, path: 'nested/value.txt' })), 'alpha value\n');
    await assert.rejects(client.remove(alpha.id, { ...scopeB, deleteWorkspace: true }), (error) => error.status === 404);
    await client.remove(alpha.id, { ...scopeA, deleteWorkspace: true });
    created.delete(alpha.id);
    await assert.rejects(docker('container', 'inspect', alpha.containerName));
    await assert.rejects(docker('volume', 'inspect', alpha.workspaceVolume));
    assert.equal(decode(await client.readFile(beta.id, { ...scopeB, path: 'nested/value.txt' })), 'beta value\n');
  });
});
