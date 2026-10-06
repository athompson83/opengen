import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runDockerCommand } from './docker-command.mjs';
import {
  RuntimeError, DEFAULT_PROFILES, MAX_EXEC_OUTPUT_BYTES, MAX_FILE_BYTES,
  normalizeCreateRequest, normalizeExecRequest, decodeWriteContent, onlyFields,
  validateLimits, validateLocalDockerEndpoint, validateProfiles, validateProjectId,
  validateRelativePath, validateSandboxId,
} from './runtime-policy.mjs';

export { RuntimeError } from './runtime-policy.mjs';

const LABEL = 'org.opengen';
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const NOT_FOUND = /(?:no such (?:container|volume|network|object)\b|\bnetwork [^\r\n]+ not found\b)/i;
const PROXY_ENVIRONMENT = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'FTP_PROXY', 'ftp_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];

// Directory descriptors remain anchored even if a workload renames an ancestor.
// O_NOFOLLOW rejects symlinks at every segment; no host file is extracted or opened.
const FILE_HELPER = String.raw`
const fs = require('node:fs/promises');
const C = require('node:fs').constants;
const crypto = require('node:crypto');
const MAX = 1048576;
(async () => {
  const handles = [];
  let temporary;
  try {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 1500000) throw { code: 'FILE_TOO_LARGE' };
    }
    const request = JSON.parse(raw);
    const parts = request.path.split('/');
    if (!parts.length || parts.some(p => !p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) throw { code: 'PATH_UNSAFE' };
    let dir = await fs.open('/workspace', C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    handles.push(dir);
    for (const segment of parts.slice(0, -1)) {
      const nextPath = '/proc/self/fd/' + dir.fd + '/' + segment;
      if (request.op === 'write') {
        try { await fs.mkdir(nextPath, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      dir = await fs.open(nextPath, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      handles.push(dir);
    }
    const target = '/proc/self/fd/' + dir.fd + '/' + parts.at(-1);
    if (request.op === 'read') {
      const file = await fs.open(target, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      handles.push(file);
      const stat = await file.stat();
      if (!stat.isFile()) throw { code: 'PATH_UNSAFE' };
      if (stat.size > MAX) throw { code: 'FILE_TOO_LARGE' };
      const buffer = Buffer.alloc(MAX + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX) throw { code: 'FILE_TOO_LARGE' };
      process.stdout.write(JSON.stringify({ content: buffer.subarray(0, total).toString('base64') }));
    } else if (request.op === 'write') {
      const bytes = Buffer.from(request.content, 'base64');
      if (bytes.length > MAX) throw { code: 'FILE_TOO_LARGE' };
      try {
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) throw { code: 'PATH_UNSAFE' };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      temporary = '/proc/self/fd/' + dir.fd + '/.opengen-' + crypto.randomUUID() + '.tmp';
      const file = await fs.open(temporary, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await fs.rename(temporary, target);
      temporary = undefined;
      process.stdout.write(JSON.stringify({ bytes: bytes.length }));
    } else throw { code: 'PATH_UNSAFE' };
  } catch (error) {
    const code = ({ ENOENT: 'FILE_NOT_FOUND', ELOOP: 'PATH_UNSAFE', ENOTDIR: 'PATH_UNSAFE', EACCES: 'FILE_ACCESS_DENIED', EPERM: 'FILE_ACCESS_DENIED' })[error.code]
      || (['PATH_UNSAFE', 'FILE_TOO_LARGE'].includes(error.code) ? error.code : 'FILE_OPERATION_FAILED');
    process.stdout.write(JSON.stringify({ error: code }));
    process.exitCode = 2;
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    for (const handle of handles.reverse()) await handle.close().catch(() => {});
  }
})();
`;

function sanitized(error, fallbackCode = 'DOCKER_OPERATION_FAILED') {
  return error instanceof RuntimeError ? error : new RuntimeError(fallbackCode, 'The sandbox operation could not be completed.', 503);
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch { throw new RuntimeError('INVALID_DOCKER_RESPONSE', 'Docker returned an invalid response.', 503); }
}

function resourceNames(instanceId, id) {
  const base = `opengen-${instanceId.slice(0, 12)}-${id}`;
  return { containerName: base, workspaceVolume: `${base}-workspace`, networkName: `${base}-network` };
}

function descriptor(record) {
  return {
    id: record.id, projectId: record.projectId, profile: record.profile,
    network: record.network, state: record.state, createdAt: record.createdAt,
    updatedAt: record.updatedAt, limits: { ...record.limits },
    ports: record.ports.map((port) => ({ ...port })),
    containerName: record.containerName, workspaceVolume: record.workspaceVolume,
    ...(record.network === 'bridge' ? { networkName: record.networkName } : {}),
    imageId: record.imageId,
    ...(record.lastError ? { error: { code: record.lastError } } : {}),
  };
}

async function acquireStateLock(root) {
  const filename = path.join(root, 'runtime.lock');
  const recovery = path.join(root, 'runtime-lock-recovery');
  const nonce = randomUUID();
  const payload = JSON.stringify({ version: 1, pid: process.pid, host: os.hostname(), nonce });
  const busy = () => new RuntimeError('RUNTIME_ALREADY_ACTIVE', 'Another OpenGen runtime owns this state directory. Stop it before starting a second service.', 409);
  const write = () => fs.writeFile(filename, payload, { flag: 'wx', mode: 0o600 });
  async function readLock() {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw busy();
    let owner;
    try { owner = JSON.parse(await fs.readFile(filename, 'utf8')); } catch { throw busy(); }
    if (owner.version !== 1 || !Number.isInteger(owner.pid) || owner.pid < 1 || owner.host !== os.hostname()
      || typeof owner.nonce !== 'string') throw busy();
    return owner;
  }
  function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  }
  try { await write(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw new RuntimeError('STATE_UNAVAILABLE', 'The runtime ownership lock could not be created.', 503);
    const owner = await readLock();
    if (isAlive(owner.pid)) throw busy();
    // Only one process may reclaim a confirmed-dead local PID's lock. Re-read
    // under the recovery lock before unlinking so another live owner is safe.
    try { await fs.mkdir(recovery, { mode: 0o700 }); } catch { throw busy(); }
    try {
      const current = await readLock();
      if (current.nonce !== owner.nonce || isAlive(current.pid)) throw busy();
      await fs.unlink(filename);
      try { await write(); } catch (next) { if (next.code === 'EEXIST') throw busy(); throw next; }
    } finally { await fs.rmdir(recovery).catch(() => {}); }
  }
  return async () => {
    let current;
    try { current = await readLock(); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (current.nonce !== nonce || current.pid !== process.pid) throw busy();
    await fs.unlink(filename);
  };
}

export async function createDockerRuntime({
  dataDir, dockerPath = 'docker', allowNetwork = false, maxSandboxes = 4,
  profiles = DEFAULT_PROFILES, commandRunner,
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir || typeof dockerPath !== 'string' || !dockerPath
    || !Number.isInteger(maxSandboxes) || maxSandboxes < 1 || maxSandboxes > 16 || typeof allowNetwork !== 'boolean') {
    throw new RuntimeError('INVALID_CONFIGURATION', 'Provide a state directory, Docker executable, and 1–16 sandbox limit.');
  }
  profiles = validateProfiles(profiles);
  const root = path.resolve(dataDir);
  const recordsDir = path.join(root, 'sandboxes');
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.mkdir(recordsDir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw new RuntimeError('STATE_UNAVAILABLE', 'The sandbox state directory is not writable.', 503);
  }
  const rootStat = await fs.lstat(root);
  const recordsStat = await fs.lstat(recordsDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !recordsStat.isDirectory() || recordsStat.isSymbolicLink()) {
    throw new RuntimeError('UNSAFE_STATE_DIRECTORY', 'Sandbox state directories must be real directories.', 503);
  }
  if (process.platform !== 'win32') {
    await fs.chmod(root, 0o700);
    await fs.chmod(recordsDir, 0o700);
  }
  const releaseStateLock = await acquireStateLock(root);
  const identityPath = path.join(root, 'runtime-instance.json');
  let instanceId;
  const records = new Map();
  try {
  try {
    await fs.writeFile(identityPath, JSON.stringify({ version: 1, instanceId: randomUUID() }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw new RuntimeError('STATE_UNAVAILABLE', 'The sandbox identity could not be saved.', 503);
  }
  try {
    if ((await fs.lstat(identityPath)).isSymbolicLink()) throw new Error('Invalid identity file');
    const identity = JSON.parse(await fs.readFile(identityPath, 'utf8'));
    if (identity.version !== 1) throw new Error('Unsupported identity version');
    instanceId = validateSandboxId(identity.instanceId);
  } catch {
    throw new RuntimeError('INVALID_RUNTIME_STATE', 'The saved sandbox identity is invalid. Restore a valid state backup.', 503);
  }

  for (const filename of await fs.readdir(recordsDir)) {
    if (!filename.endsWith('.json')) continue;
    try {
      const id = validateSandboxId(filename.slice(0, -5));
      const recordPath = path.join(recordsDir, filename);
      if ((await fs.lstat(recordPath)).isSymbolicLink()) throw new Error('Invalid record file');
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
      if (record.version !== 1 || record.id !== id || record.instanceId !== instanceId || !IMAGE_ID.test(record.imageId)
        || !['none', 'bridge'].includes(record.network) || !Array.isArray(record.requestedPorts)
        || record.requestedPorts.length > 5 || record.requestedPorts.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535)
        || new Set(record.requestedPorts).size !== record.requestedPorts.length || (record.requestedPorts.length && record.network !== 'bridge')
        || !/^[a-z][a-z0-9-]{0,31}$/.test(record.profile) || record.limits?.pids !== 256
        || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string'
        || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error('Invalid record');
      validateProjectId(record.projectId);
      record.limits = validateLimits({ memoryMb: record.limits.memoryMb, cpus: record.limits.cpus });
      Object.assign(record, resourceNames(instanceId, id));
      record.ports = [];
      record.state = 'unknown';
      records.set(id, record);
    } catch {
      throw new RuntimeError('INVALID_RUNTIME_STATE', 'A saved sandbox record is invalid. Restore a valid state backup.', 503);
    }
  }
  } catch (error) {
    await releaseStateLock();
    throw error;
  }

  const runner = commandRunner ?? ((options) => runDockerCommand({ dockerPath, ...options }));
  let connection;
  let connecting;
  let createQueue = Promise.resolve();
  const queues = new Map();
  const activeExecutions = new Map();
  const cancellationGenerations = new Map();
  let closed = false;

  function cancelExecution(id) {
    cancellationGenerations.set(id, (cancellationGenerations.get(id) ?? 0) + 1);
    activeExecutions.get(id)?.abort();
  }

  async function raw(args, options = {}) {
    try {
      const result = await runner({ args, timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024, ...options });
      if (!result || !Number.isInteger(result.exitCode)) throw new Error('Invalid command runner response');
      return { stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, ...result };
    } catch (error) { throw sanitized(error); }
  }

  async function requireSuccess(args, options = {}) {
    const result = await raw(args, options);
    if (result.exitCode !== 0 || result.timedOut || result.aborted || result.truncated) {
      throw new RuntimeError('DOCKER_OPERATION_FAILED', 'Docker could not complete the requested operation.', 503);
    }
    return result;
  }

  async function ensureDocker() {
    if (connection) return connection;
    if (connecting) return connecting;
    connecting = (async () => {
      const context = (await requireSuccess(['context', 'show'])).stdout.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context)) {
        throw new RuntimeError('INVALID_DOCKER_CONTEXT', 'Docker did not select a valid local context.', 503);
      }
      const endpoint = parseJson((await requireSuccess(['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'])).stdout);
      validateLocalDockerEndpoint(endpoint);
      // Pin the validated socket itself so context-file changes cannot redirect
      // later operations. The command runner strips environment host/context overrides.
      const prefix = ['--host', endpoint];
      const os = parseJson((await requireSuccess([...prefix, 'info', '--format', '{{json .OSType}}'])).stdout);
      if (os !== 'linux') throw new RuntimeError('LINUX_CONTAINERS_REQUIRED', 'Use Docker with Linux containers enabled.', 409);
      const version = parseJson((await requireSuccess([...prefix, 'version', '--format', '{{json .Server.Version}}'])).stdout);
      connection = { context, endpoint, prefix, version };
      return connection;
    })();
    try { return await connecting; } finally { connecting = undefined; }
  }

  async function docker(args, options) {
    const { prefix } = await ensureDocker();
    return raw([...prefix, ...args], options);
  }

  async function checked(args, options) {
    const result = await docker(args, options);
    if (result.exitCode !== 0 || result.timedOut || result.aborted || result.truncated) {
      throw new RuntimeError('DOCKER_OPERATION_FAILED', 'Docker could not complete the requested operation.', 503);
    }
    return result;
  }

  async function inspect(kind, name) {
    const result = await docker([kind, 'inspect', name]);
    if (result.exitCode !== 0) {
      if (!result.timedOut && !result.aborted && NOT_FOUND.test(result.stderr)) return null;
      throw new RuntimeError('DOCKER_OPERATION_FAILED', 'Docker resource state could not be inspected.', 503);
    }
    if (result.truncated) throw new RuntimeError('INVALID_DOCKER_RESPONSE', 'Docker returned an oversized response.', 503);
    const parsed = parseJson(result.stdout);
    if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0] !== 'object') {
      throw new RuntimeError('INVALID_DOCKER_RESPONSE', 'Docker returned an invalid resource description.', 503);
    }
    return parsed[0];
  }

  function labels(record, kind) {
    return { [`${LABEL}.managed`]: 'true', [`${LABEL}.instance`]: instanceId, [`${LABEL}.sandbox`]: record.id, [`${LABEL}.kind`]: kind };
  }

  function labelArgs(record, kind) {
    return Object.entries(labels(record, kind)).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  }

  async function owned(record, kind, name, labelKind) {
    const resource = await inspect(kind, name);
    if (!resource) return null;
    const actual = kind === 'container' ? resource.Config?.Labels : resource.Labels;
    if (!actual || Object.entries(labels(record, labelKind)).some(([key, value]) => actual[key] !== value)) {
      throw new RuntimeError('RESOURCE_OWNERSHIP_MISMATCH', 'A Docker resource does not belong to this OpenGen sandbox. No foreign resource was changed.', 409);
    }
    return resource;
  }

  async function persist(record) {
    const filename = path.join(recordsDir, `${record.id}.json`);
    const temp = `${filename}.${randomUUID()}.tmp`;
    try {
      const file = await fs.open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(record, null, 2) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await fs.rename(temp, filename);
      records.set(record.id, record);
    } catch {
      await fs.unlink(temp).catch(() => {});
      throw new RuntimeError('STATE_UNAVAILABLE', 'Sandbox state could not be saved. Existing workspace resources were retained.', 503);
    }
  }

  function withLock(id, action) {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.then(action, action);
    const settled = next.catch(() => {});
    queues.set(id, settled);
    settled.finally(() => { if (queues.get(id) === settled) queues.delete(id); });
    return next;
  }

  function recordFor(id, projectId) {
    validateSandboxId(id);
    if (projectId !== undefined) validateProjectId(projectId);
    const record = records.get(id);
    if (!record || (projectId !== undefined && record.projectId !== projectId)) {
      throw new RuntimeError('SANDBOX_NOT_FOUND', 'The requested sandbox was not found.', 404);
    }
    return record;
  }

  function actualPorts(record, container) {
    const result = [];
    for (const containerPort of record.requestedPorts) {
      const bindings = container.NetworkSettings?.Ports?.[`${containerPort}/tcp`] ?? [];
      for (const binding of bindings) {
        const hostPort = Number(binding.HostPort);
        if (binding.HostIp !== '127.0.0.1' || !Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
          throw new RuntimeError('UNSAFE_PORT_BINDING', 'The sandbox has an unexpected preview binding.', 409);
        }
        result.push({ containerPort, hostPort, url: `http://127.0.0.1:${hostPort}` });
      }
    }
    return result;
  }

  async function refresh(record) {
    const container = await owned(record, 'container', record.containerName, 'container');
    await owned(record, 'volume', record.workspaceVolume, 'workspace');
    if (record.network === 'bridge') await owned(record, 'network', record.networkName, 'network');
    const state = !container ? 'missing' : container.State?.Running ? 'running' : 'stopped';
    const ports = container ? actualPorts(record, container) : [];
    if (record.state !== state || JSON.stringify(record.ports) !== JSON.stringify(ports)) {
      record.state = state;
      record.ports = ports;
      record.updatedAt = new Date().toISOString();
      await persist(record);
    }
    return container;
  }

  async function findImage(image) {
    const result = await docker(['image', 'inspect', image]);
    if (result.exitCode !== 0 || result.truncated || result.timedOut || result.aborted) {
      throw new RuntimeError('IMAGE_UNAVAILABLE', 'The configured sandbox image is not available locally. Build or load the operator-approved image first.', 409);
    }
    const value = parseJson(result.stdout);
    if (!Array.isArray(value) || !IMAGE_ID.test(value[0]?.Id)) {
      throw new RuntimeError('INVALID_IMAGE', 'The configured image does not have a valid local image ID.', 409);
    }
    return value[0].Id;
  }

  async function ensureWorkspace(record, { mayCreate = false } = {}) {
    let workspace = await owned(record, 'volume', record.workspaceVolume, 'workspace');
    if (!workspace) {
      if (!mayCreate) throw new RuntimeError('WORKSPACE_MISSING', 'The persistent workspace volume is missing. Restore it before starting this sandbox.', 409);
      await checked(['volume', 'create', ...labelArgs(record, 'workspace'), record.workspaceVolume]);
      workspace = await owned(record, 'volume', record.workspaceVolume, 'workspace');
      if (!workspace) throw new RuntimeError('WORKSPACE_MISSING', 'Docker did not create the persistent workspace volume.', 503);
    }
  }

  async function ensureNetwork(record) {
    if (record.network !== 'bridge') return;
    if (!allowNetwork) throw new RuntimeError('NETWORK_DISABLED', 'The operator has disabled networked sandbox execution.', 403);
    if (!(await owned(record, 'network', record.networkName, 'network'))) {
      await checked(['network', 'create', '--driver', 'bridge', ...labelArgs(record, 'network'), record.networkName]);
      if (!(await owned(record, 'network', record.networkName, 'network'))) {
        throw new RuntimeError('NETWORK_UNAVAILABLE', 'Docker did not create the sandbox network.', 503);
      }
    }
  }

  async function makeContainer(record) {
    if (await owned(record, 'container', record.containerName, 'container')) {
      throw new RuntimeError('CONTAINER_ALREADY_EXISTS', 'The sandbox container already exists.', 409);
    }
    await ensureWorkspace(record);
    await ensureNetwork(record);
    await findImage(record.imageId);
    await checked([
      'container', 'create', '--name', record.containerName, '--pull', 'never',
      ...labelArgs(record, 'container'), '--user', '1000:1000', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
      '--memory', `${record.limits.memoryMb}m`, '--memory-swap', `${record.limits.memoryMb}m`,
      '--cpus', String(record.limits.cpus), '--pids-limit', String(record.limits.pids),
      '--ulimit', 'nofile=4096:4096', '--ipc', 'private', '--init', '--restart', 'no',
      '--stop-timeout', '5', '--log-driver', 'local', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=134217728,mode=1777',
      '--mount', `type=volume,source=${record.workspaceVolume},target=/workspace`,
      '--workdir', '/workspace', '--env', 'HOME=/workspace/.home', '--env', 'TMPDIR=/tmp',
      // Docker config.json proxies are otherwise injected automatically and can
      // contain the operator's credentials. Explicit empty overrides prevent it.
      ...PROXY_ENVIRONMENT.flatMap((name) => ['--env', `${name}=`]),
      '--network', record.network === 'none' ? 'none' : record.networkName,
      ...record.requestedPorts.flatMap((port) => ['--publish', `127.0.0.1::${port}/tcp`]),
      record.imageId,
    ]);
    if (!(await owned(record, 'container', record.containerName, 'container'))) {
      throw new RuntimeError('CONTAINER_MISSING', 'Docker did not create the sandbox container.', 503);
    }
  }

  async function startContainer(record) {
    await ensureWorkspace(record);
    let container = await owned(record, 'container', record.containerName, 'container');
    await ensureNetwork(record);
    if (!container) { await makeContainer(record); container = await owned(record, 'container', record.containerName, 'container'); }
    if (!container.State?.Running) await checked(['container', 'start', record.containerName]);
    await refresh(record);
    if (record.state !== 'running') throw new RuntimeError('SANDBOX_START_FAILED', 'The sandbox did not remain running after startup.', 503);
    delete record.lastError;
    record.updatedAt = new Date().toISOString();
    await persist(record);
    return descriptor(record);
  }

  async function killWorkload(record) {
    const container = await owned(record, 'container', record.containerName, 'container');
    if (container?.State?.Running) {
      await docker(['container', 'kill', '--signal', 'KILL', record.containerName], { timeoutMs: 15_000 });
    }
    const after = await owned(record, 'container', record.containerName, 'container');
    if (after?.State?.Running) {
      record.lastError = 'WORKLOAD_STOP_FAILED';
      await persist(record);
      throw new RuntimeError('WORKLOAD_STOP_FAILED', 'The workload could not be confirmed stopped. Stop this sandbox through Docker before retrying.', 503);
    }
    await refresh(record);
  }

  async function execute(record, request, { signal, input, generation = 0, maxOutputBytes = MAX_EXEC_OUTPUT_BYTES } = {}) {
    if (signal?.aborted) throw new RuntimeError('EXEC_ABORTED', 'Command execution was canceled.', 499);
    const container = await refresh(record);
    if (!container?.State?.Running) throw new RuntimeError('SANDBOX_NOT_RUNNING', 'Start the sandbox before executing commands.', 409);
    if (record.network === 'bridge' && !allowNetwork) {
      throw new RuntimeError('NETWORK_DISABLED', 'The operator has disabled networked sandbox execution.', 403);
    }
    if (closed || generation !== (cancellationGenerations.get(record.id) ?? 0)) {
      throw new RuntimeError('EXEC_ABORTED', 'Command execution was canceled before launch.', 499);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    activeExecutions.set(record.id, controller);
    const startedAt = Date.now();
    let result;
    try {
      try {
        result = await docker([
          'exec', ...(input !== undefined ? ['--interactive'] : []),
          '--user', '1000:1000', '--workdir', request.cwd === '.' ? '/workspace' : `/workspace/${request.cwd}`,
          '--', record.containerName, ...request.argv,
        ], { input, signal: controller.signal, timeoutMs: request.timeoutMs, maxOutputBytes });
      } catch (error) {
        // A failed CLI transport cannot prove that the exec request never reached Docker.
        await killWorkload(record);
        throw sanitized(error);
      }
      if (result.timedOut || result.aborted || controller.signal.aborted) {
        await killWorkload(record);
        if (result.aborted || controller.signal.aborted) throw new RuntimeError('EXEC_ABORTED', 'Command execution was canceled and the sandbox was stopped.', 499);
        return { exitCode: 124, stdout: result.stdout, stderr: result.stderr, timedOut: true, truncated: result.truncated, durationMs: Date.now() - startedAt };
      }
      if (result.exitCode !== 0 && !result.stdout && /^(?:Error response from daemon:|Cannot connect to|OCI runtime exec failed:|failed to connect)/m.test(result.stderr)) {
        throw new RuntimeError('EXEC_FAILED', 'Docker could not execute the requested command.', 503);
      }
      await refresh(record);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: false, truncated: result.truncated, durationMs: Date.now() - startedAt };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      activeExecutions.delete(record.id);
    }
  }

  async function fileOperation(record, request, generation) {
    const result = await execute(record, { argv: ['/usr/local/bin/node', '-e', FILE_HELPER], cwd: '.', timeoutMs: 30_000 }, {
      input: JSON.stringify(request), generation, maxOutputBytes: 2 * 1024 * 1024,
    });
    if (result.timedOut || result.truncated) throw new RuntimeError('FILE_OPERATION_FAILED', 'The sandbox file operation did not complete.', 503);
    let value;
    try { value = JSON.parse(result.stdout); }
    catch { throw new RuntimeError('FILE_OPERATION_FAILED', 'The sandbox file helper returned an invalid response.', 503); }
    const errors = {
      PATH_UNSAFE: [400, 'File paths must refer to regular files inside the workspace without symlinks.'],
      FILE_NOT_FOUND: [404, 'The requested workspace file was not found.'],
      FILE_TOO_LARGE: [413, 'Files are limited to 1 MiB per operation.'],
      FILE_ACCESS_DENIED: [403, 'The workspace file could not be accessed.'],
      FILE_OPERATION_FAILED: [503, 'The workspace file operation could not be completed.'],
    };
    if (value.error || result.exitCode !== 0) {
      const code = Object.hasOwn(errors, value.error) ? value.error : 'FILE_OPERATION_FAILED';
      throw new RuntimeError(code, errors[code][1], errors[code][0]);
    }
    return value;
  }

  const api = {
    async health() {
      try {
        const { context } = await ensureDocker();
        // Cached context selection is deliberate; daemon health is checked on every call.
        const os = parseJson((await checked(['info', '--format', '{{json .OSType}}'])).stdout);
        if (os !== 'linux') throw new RuntimeError('LINUX_CONTAINERS_REQUIRED', 'Use Docker with Linux containers enabled.', 409);
        const version = parseJson((await checked(['version', '--format', '{{json .Server.Version}}'])).stdout);
        const imageProfiles = [];
        for (const [name, profile] of Object.entries(profiles)) {
          try { imageProfiles.push({ name, image: profile.image, ready: true, imageId: await findImage(profile.image) }); }
          catch (error) { imageProfiles.push({ name, image: profile.image, ready: false, error: { code: sanitized(error).code } }); }
        }
        return { ready: imageProfiles.every((profile) => profile.ready), backend: 'docker', context, version, profiles: imageProfiles, sandboxCount: records.size, maxSandboxes, allowNetwork };
      } catch (error) {
        const safe = sanitized(error);
        return { ready: false, backend: 'docker', error: { code: safe.code, message: safe.message }, sandboxCount: records.size, maxSandboxes, allowNetwork };
      }
    },

    async list({ projectId } = {}) {
      if (projectId !== undefined) validateProjectId(projectId);
      return Promise.all([...records.values()].filter((record) => projectId === undefined || record.projectId === projectId)
        .map((record) => withLock(record.id, async () => {
          const current = records.get(record.id);
          if (!current) return null;
          await refresh(current);
          return descriptor(current);
        }))).then((items) => items.filter(Boolean));
    },

    async create(request) {
      const normalized = normalizeCreateRequest(request, { profiles, allowNetwork });
      const action = async () => {
        if (records.size >= maxSandboxes) throw new RuntimeError('SANDBOX_LIMIT_REACHED', 'Remove an unused sandbox before creating another.', 409);
        const imageId = await findImage(profiles[normalized.profile].image);
        const id = randomUUID();
        return withLock(id, async () => {
          const now = new Date().toISOString();
          const record = {
            version: 1, instanceId, id, ...normalized, requestedPorts: normalized.ports, ports: [],
            imageId, ...resourceNames(instanceId, id), state: 'creating', createdAt: now, updatedAt: now,
          };
          await persist(record);
          try {
            // Inspect all names before provisioning; labels, not names, establish ownership.
            await owned(record, 'container', record.containerName, 'container');
            if (record.network === 'bridge') await owned(record, 'network', record.networkName, 'network');
            await ensureWorkspace(record, { mayCreate: true });
            await makeContainer(record);
            return await startContainer(record);
          } catch (error) {
            const safe = sanitized(error);
            record.state = 'error';
            record.lastError = safe.code;
            record.updatedAt = new Date().toISOString();
            await persist(record);
            throw new RuntimeError(safe.code, `${safe.message} Sandbox ${id} remains recorded for recovery or explicit removal.`, safe.status, { sandboxId: id });
          }
        });
      };
      const result = createQueue.then(action, action);
      createQueue = result.catch(() => {});
      return result;
    },

    async get(id, { projectId } = {}) {
      return withLock(id, async () => { const record = recordFor(id, projectId); await refresh(record); return descriptor(record); });
    },

    async start(id, { projectId } = {}) {
      return withLock(id, async () => startContainer(recordFor(id, projectId)));
    },

    async stop(id, { projectId } = {}) {
      recordFor(id, projectId);
      cancelExecution(id);
      return withLock(id, async () => {
        const record = recordFor(id, projectId);
        const container = await owned(record, 'container', record.containerName, 'container');
        await owned(record, 'volume', record.workspaceVolume, 'workspace');
        if (container?.State?.Running) {
          const result = await docker(['container', 'stop', '--time', '5', record.containerName], { timeoutMs: 15_000 });
          if (result.exitCode !== 0 || result.timedOut) await killWorkload(record);
        }
        await refresh(record);
        if (record.state === 'running') throw new RuntimeError('WORKLOAD_STOP_FAILED', 'The sandbox could not be confirmed stopped.', 503);
        return descriptor(record);
      });
    },

    async reset(id, { projectId } = {}) {
      recordFor(id, projectId);
      cancelExecution(id);
      return withLock(id, async () => {
        const record = recordFor(id, projectId);
        const container = await owned(record, 'container', record.containerName, 'container');
        await ensureWorkspace(record);
        await findImage(record.imageId);
        await ensureNetwork(record);
        if (container) {
          await checked(['container', 'rm', '--force', record.containerName]);
        }
        await makeContainer(record);
        return startContainer(record);
      });
    },

    async remove(id, { projectId, deleteWorkspace = false } = {}) {
      recordFor(id, projectId);
      if (deleteWorkspace !== true) throw new RuntimeError('WORKSPACE_DELETION_REQUIRED', 'Set deleteWorkspace to true to remove the sandbox and its persistent workspace.', 409);
      cancelExecution(id);
      return withLock(id, async () => {
        const record = recordFor(id, projectId);
        const resources = [
          ['container', record.containerName, 'container'],
          ...(record.network === 'bridge' ? [['network', record.networkName, 'network']] : []),
          ['volume', record.workspaceVolume, 'workspace'],
        ];
        for (const [kind, name, labelKind] of resources) await owned(record, kind, name, labelKind);
        try {
          for (const [kind, name, labelKind] of resources) {
            if (await owned(record, kind, name, labelKind)) {
              await checked([kind, 'rm', ...(kind === 'container' ? ['--force'] : []), name]);
              if (await owned(record, kind, name, labelKind)) throw new RuntimeError('RESOURCE_REMOVAL_FAILED', 'A sandbox resource remains after removal.', 503);
            }
          }
          await fs.unlink(path.join(recordsDir, `${id}.json`));
          records.delete(id);
          return { id, deleted: true, workspaceDeleted: true };
        } catch (error) {
          const safe = sanitized(error, 'STATE_UNAVAILABLE');
          record.lastError = safe.code;
          record.state = 'error';
          record.updatedAt = new Date().toISOString();
          await persist(record);
          throw safe;
        }
      });
    },

    async exec(id, request, { signal } = {}) {
      const normalized = normalizeExecRequest(request);
      const generation = cancellationGenerations.get(id) ?? 0;
      return withLock(id, () => execute(recordFor(id, request.projectId), normalized, { signal, generation }));
    },

    async readFile(id, request) {
      onlyFields(request, ['projectId', 'path']);
      const filepath = validateRelativePath(request.path);
      const generation = cancellationGenerations.get(id) ?? 0;
      return withLock(id, async () => {
        const value = await fileOperation(recordFor(id, request.projectId), { op: 'read', path: filepath }, generation);
        if (typeof value.content !== 'string' || value.content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) {
          throw new RuntimeError('FILE_OPERATION_FAILED', 'The sandbox file response was invalid.', 503);
        }
        return { path: filepath, content: value.content, encoding: 'base64' };
      });
    },

    async writeFile(id, request) {
      onlyFields(request, ['projectId', 'path', 'content', 'encoding']);
      const filepath = validateRelativePath(request.path);
      const content = decodeWriteContent(request);
      const generation = cancellationGenerations.get(id) ?? 0;
      return withLock(id, async () => {
        const value = await fileOperation(recordFor(id, request.projectId), { op: 'write', path: filepath, content: content.toString('base64') }, generation);
        if (value.bytes !== content.length) throw new RuntimeError('FILE_OPERATION_FAILED', 'The sandbox did not confirm the complete file write.', 503);
        return { path: filepath, bytes: value.bytes };
      });
    },
  };
  let closing;
  const inflight = new Set();
  return {
    ...Object.fromEntries(Object.entries(api).map(([name, method]) => [name, (...args) => {
      if (closed) return Promise.reject(new RuntimeError('RUNTIME_CLOSED', 'This sandbox runtime has been closed.', 503));
      const operation = Promise.resolve().then(() => method(...args));
      inflight.add(operation);
      operation.finally(() => inflight.delete(operation)).catch(() => {});
      return operation;
    }])),
    close() {
      if (closing) return closing;
      closed = true;
      for (const controller of activeExecutions.values()) controller.abort();
      closing = (async () => {
        await Promise.allSettled([...inflight]);
        await releaseStateLock();
      })();
      return closing;
    },
  };
}
