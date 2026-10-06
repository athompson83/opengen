export class RequestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
    this.status = status;
  }
}

export function object(input, allowed, required = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError('INVALID_REQUEST', 'A JSON object is required.');
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new RequestError('INVALID_REQUEST', 'An unrecognized field was supplied.');
  if (required.some((key) => !Object.hasOwn(input, key))) throw new RequestError('INVALID_REQUEST', 'A required field is missing.');
  return input;
}

export function projectId(value, required = true) {
  if (value === undefined && !required) return undefined;
  return validateProjectId(value);
}

export function queryParams(url, allowed) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new RequestError('INVALID_QUERY', 'Unrecognized or duplicate query parameter.');
    result[key] = value;
  }
  return result;
}

export function shortString(value, label, max = 4096) {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) throw new RequestError('INVALID_REQUEST', `${label} is invalid.`);
  return value;
}

export function createRequest(input) {
  const value = object(input, ['projectId', 'profile', 'network', 'ports', 'limits'], ['projectId']);
  projectId(value.projectId);
  if (value.profile !== undefined) shortString(value.profile, 'profile', 32);
  if (value.network !== undefined && !['none', 'bridge'].includes(value.network)) throw new RequestError('INVALID_NETWORK', 'Network must be none or bridge.');
  if (value.ports !== undefined && (!Array.isArray(value.ports) || value.ports.length > 5 || value.ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535) || new Set(value.ports).size !== value.ports.length)) {
    throw new RequestError('INVALID_PORTS', 'Ports must be up to five distinct integers from 1024 to 65535.');
  }
  if (value.limits !== undefined) {
    validateLimits(value.limits);
  }
  return value;
}

export function execRequest(input) {
  const value = object(input, ['projectId', 'argv', 'cwd', 'timeoutMs'], ['projectId', 'argv']);
  projectId(value.projectId);
  return { projectId: value.projectId, ...normalizeExecRequest(value) };
}

export const filePath = (value) => validateRelativePath(value);
import { validateProjectId, validateLimits, normalizeExecRequest, validateRelativePath } from './runtime-policy.mjs';
