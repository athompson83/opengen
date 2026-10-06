import path from 'node:path';

export class RuntimeError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_LIMITS = Object.freeze({ memoryMb: 2048, cpus: 2, pids: 256 });
export const DEFAULT_PROFILES = Object.freeze({ node: Object.freeze({ image: 'opengen/node:0.1.0' }) });

export function requireObject(value, name = 'Request') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeError('INVALID_REQUEST', `${name} must be an object.`);
  }
  return value;
}

export function onlyFields(value, allowed) {
  requireObject(value);
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new RuntimeError('INVALID_REQUEST', 'The request contains unsupported fields.');
  }
}

export function validateProjectId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new RuntimeError('INVALID_PROJECT_ID', 'projectId must be 1–128 letters, numbers, dots, underscores, or hyphens.');
  }
  return value;
}

export function validateSandboxId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new RuntimeError('INVALID_SANDBOX_ID', 'A valid sandbox UUID is required.');
  }
  return value;
}

export function validateLimits(value = {}) {
  onlyFields(value, ['memoryMb', 'cpus']);
  const limits = { ...DEFAULT_LIMITS, ...value };
  if (!Number.isInteger(limits.memoryMb) || limits.memoryMb < 256 || limits.memoryMb > 2048
    || typeof limits.cpus !== 'number' || !Number.isFinite(limits.cpus) || limits.cpus < 0.25 || limits.cpus > 2) {
    throw new RuntimeError('INVALID_LIMITS', 'Limits must be 256–2048 MiB memory and 0.25–2 CPUs. The process limit is fixed at 256.');
  }
  return limits;
}

export function validateProfiles(profiles = DEFAULT_PROFILES) {
  requireObject(profiles, 'Profiles');
  if (!Object.keys(profiles).length || Object.keys(profiles).length > 16) {
    throw new RuntimeError('INVALID_CONFIGURATION', 'Configure between 1 and 16 image profiles.');
  }
  const result = Object.create(null);
  for (const [name, profile] of Object.entries(profiles)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || !profile || typeof profile.image !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9./:@_-]{0,255}$/.test(profile.image)) {
      throw new RuntimeError('INVALID_CONFIGURATION', 'Image profiles must have a valid name and a local Docker image reference.');
    }
    result[name] = Object.freeze({ image: profile.image });
  }
  return Object.freeze(result);
}

export function normalizeCreateRequest(value, { allowNetwork = false, profiles = DEFAULT_PROFILES } = {}) {
  onlyFields(value, ['projectId', 'profile', 'network', 'ports', 'limits']);
  const projectId = validateProjectId(value.projectId);
  const profile = value.profile ?? 'node';
  if (typeof profile !== 'string' || !Object.hasOwn(profiles, profile)) {
    throw new RuntimeError('UNKNOWN_PROFILE', 'Choose one of the operator-configured image profiles.');
  }
  const network = value.network ?? 'none';
  if (!['none', 'bridge'].includes(network)) {
    throw new RuntimeError('INVALID_NETWORK', 'Network mode must be none or bridge.');
  }
  if (network === 'bridge' && !allowNetwork) {
    throw new RuntimeError('NETWORK_DISABLED', 'The operator has not enabled networked sandboxes.', 403);
  }
  const ports = value.ports ?? [];
  if (!Array.isArray(ports) || ports.length > 5 || ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)
    || new Set(ports).size !== ports.length) {
    throw new RuntimeError('INVALID_PORTS', 'Choose up to five different TCP ports between 1024 and 65535.');
  }
  if (ports.length && network !== 'bridge') {
    throw new RuntimeError('NETWORK_REQUIRED', 'Published previews require explicitly enabled bridge networking.');
  }
  return { projectId, profile, network, ports: [...ports], limits: validateLimits(value.limits) };
}

export function validateRelativePath(value, { directory = false } = {}) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || /[\0\r\n\\]/.test(value)
    || path.posix.isAbsolute(value) || value.split('/').some((part) => part === '..')) {
    throw new RuntimeError('INVALID_PATH', 'Use a relative path within the sandbox workspace.');
  }
  const normalized = path.posix.normalize(value);
  if ((!directory && normalized === '.') || /^[A-Za-z]:/.test(normalized)) {
    throw new RuntimeError('INVALID_PATH', 'Use a relative path within the sandbox workspace.');
  }
  return normalized.replace(/\/$/, '') || '.';
}

export function normalizeExecRequest(value) {
  onlyFields(value, ['projectId', 'argv', 'cwd', 'timeoutMs']);
  if (value.projectId !== undefined) validateProjectId(value.projectId);
  const { argv } = value;
  if (!Array.isArray(argv) || !argv.length || argv.length > 128 || typeof argv[0] !== 'string' || !argv[0]
    || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    || argv.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 64 * 1024) {
    throw new RuntimeError('INVALID_COMMAND', 'Provide 1–128 command arguments with a total size of at most 64 KiB.');
  }
  const timeoutMs = value.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 900_000) {
    throw new RuntimeError('INVALID_TIMEOUT', 'Command timeout must be between 100 and 900000 milliseconds.');
  }
  return { argv: [...argv], cwd: validateRelativePath(value.cwd ?? '.', { directory: true }), timeoutMs };
}

export function decodeWriteContent({ content, encoding = 'utf8' }) {
  if (typeof content !== 'string' || !['utf8', 'base64'].includes(encoding)) {
    throw new RuntimeError('INVALID_FILE_CONTENT', 'File content must be a UTF-8 or base64 string.');
  }
  if (content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) {
    throw new RuntimeError('FILE_TOO_LARGE', 'Files are limited to 1 MiB per operation.', 413);
  }
  if (encoding === 'base64' && (!/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 !== 0)) {
    throw new RuntimeError('INVALID_FILE_CONTENT', 'File content is not valid base64.');
  }
  const bytes = Buffer.from(content, encoding);
  if (encoding === 'base64' && bytes.toString('base64') !== content) {
    throw new RuntimeError('INVALID_FILE_CONTENT', 'File content is not canonical base64.');
  }
  if (bytes.length > MAX_FILE_BYTES) throw new RuntimeError('FILE_TOO_LARGE', 'Files are limited to 1 MiB per operation.', 413);
  return bytes;
}

export function validateLocalDockerEndpoint(value) {
  if (typeof value !== 'string' || !(/^unix:\/\/\/[^\0\r\n?]+$/.test(value)
    || /^npipe:\/{4}\.\/pipe\/[A-Za-z0-9_.-]+$/.test(value))) {
    throw new RuntimeError('REMOTE_DOCKER_FORBIDDEN', 'OpenGen requires a local Docker Unix socket or Windows named pipe.', 403);
  }
  return value;
}
